import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';
import { createApp } from '@durable/api';
import { createWorkflowClient, WorkflowClientError } from '../src/index';

describe('WorkflowClient E2E', () => {
  let app: ReturnType<typeof createApp>;
  let prisma: PrismaClient;
  let baseUrl: string;
  let tenantApiKey: string;
  let validApiKey = 'test_api_key_client_e2e';

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    
    // Seed a tenant and api key for tests
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Client Test Tenant',
        apiKeys: {
          create: {
            keyHash: crypto.createHash('sha256').update(validApiKey).digest('hex'),
            label: 'test'
          }
        }
      },
      include: {
        apiKeys: true
      }
    });

    app = createApp({ prisma });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
    await prisma.tenant.deleteMany({
      where: {
        name: 'Client Test Tenant'
      }
    });
    await prisma.$disconnect();
  });

  it('client.run() creates a workflow run (HTTP 201)', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const run = await client.run({
      workflowName: 'TestWorkflow',
      input: { foo: 'bar' }
    });
    
    expect(run).toBeDefined();
    expect(run.id).toBeDefined();
    expect(run.workflowName).toBe('TestWorkflow');
    expect(run.status).toBe('PENDING');
  });

  it('client.run() with the same idempotencyKey returns the existing run', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const idempotencyKey = 'idemp_test_123';
    
    const run1 = await client.run({
      workflowName: 'IdempWorkflow',
      idempotencyKey
    });
    
    const run2 = await client.run({
      workflowName: 'IdempWorkflow',
      idempotencyKey
    });
    
    expect(run1.id).toBe(run2.id);
  });

  it('client.runs.get() retrieves run details by ID', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const created = await client.run({ workflowName: 'GetTest' });
    
    const fetched = await client.runs.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.workflowName).toBe('GetTest');
  });

  it('client.runs.list() returns list containing the created run', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const created = await client.run({ workflowName: 'ListTest' });
    
    const { runs } = await client.runs.list({ workflowName: 'ListTest' });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.some(r => r.id === created.id)).toBe(true);
  });

  it('client.runs.cancel() cancels a run', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const created = await client.run({ workflowName: 'CancelTest' });
    
    const canceled = await client.runs.cancel(created.id);
    expect(canceled.status).toBe('CANCELLED');
  });

  it('client.runs.retry() on a non-failed run throws WorkflowClientError with statusCode 400', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const created = await client.run({ workflowName: 'RetryTest' });
    
    await expect(client.runs.retry(created.id)).rejects.toThrow(WorkflowClientError);
    try {
      await client.runs.retry(created.id);
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowClientError);
      expect(e.statusCode).toBe(400);
    }
  });

  it('using an invalid API key throws WorkflowClientError with statusCode 401', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: 'invalid_key' });
    
    await expect(client.run({ workflowName: 'FailTest' })).rejects.toThrow(WorkflowClientError);
    try {
      await client.run({ workflowName: 'FailTest' });
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowClientError);
      expect(e.statusCode).toBe(401);
    }
  });

  it('client.runs.streamEvents() correctly streams SSE chunks split across packet boundaries', async () => {
    const chunk1 = new TextEncoder().encode('id: 1\nevent: WORKFLOW_STARTED\ndata: {"id":"1","eventType":"WORKFLOW_ST');
    const chunk2 = new TextEncoder().encode('ARTED","workflowRunId":"run_1"}\n\nid: 2\nevent: STEP_COMPLETED\ndata: {"id":"2","eventType":"STEP_COMPLETED","workflowRunId":"run_1"}\n\n');

    let streamCancelled = false;
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
      cancel() {
        streamCancelled = true;
      }
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(mockStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const client = createWorkflowClient({ baseUrl: 'http://localhost:3000', apiKey: 'test', fetch: mockFetch });
    const events = [];
    for await (const ev of client.runs.streamEvents('run_1')) {
      events.push(ev);
    }

    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('1');
    expect(events[0].eventType).toBe('WORKFLOW_STARTED');
    expect(events[1].id).toBe('2');
    expect(events[1].eventType).toBe('STEP_COMPLETED');
  });

  it('client.runs.streamEvents() cancels stream reader on early consumer break', async () => {
    let streamCancelled = false;
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 1\nevent: WORKFLOW_STARTED\ndata: {"id":"1"}\n\nid: 2\nevent: WORKFLOW_COMPLETED\ndata: {"id":"2"}\n\n'));
      },
      cancel() {
        streamCancelled = true;
      }
    });

    const mockFetch: typeof fetch = async () => {
      return new Response(mockStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const client = createWorkflowClient({ baseUrl: 'http://localhost:3000', apiKey: 'test', fetch: mockFetch });
    for await (const ev of client.runs.streamEvents('run_1')) {
      if (ev.id === '1') {
        break;
      }
    }

    expect(streamCancelled).toBe(true);
  });
});

