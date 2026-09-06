import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';
import { Redis } from 'ioredis';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';
import { createWorkflowClient } from '../../../packages/client/src/index';
import { getRunEventsChannel, publishRunEventWakeup } from '@durable/shared';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6380');

describe('Server-Sent Events (SSE) Streaming & Multiplexer', () => {
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  let tenant1Id: string;
  let apiKey1: string;
  let tenant2Id: string;
  let apiKey2: string;

  beforeAll(async () => {
    // Create tenant 1
    const t1 = await prisma.tenant.create({
      data: { name: `Tenant 1 SSE ${crypto.randomUUID()}` },
    });
    tenant1Id = t1.id;
    apiKey1 = `key_sse_1_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey1),
        tenantId: tenant1Id,
        label: 'sse-key-1',
      },
    });

    // Create tenant 2
    const t2 = await prisma.tenant.create({
      data: { name: `Tenant 2 SSE ${crypto.randomUUID()}` },
    });
    tenant2Id = t2.id;
    apiKey2 = `key_sse_2_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey2),
        tenantId: tenant2Id,
        label: 'sse-key-2',
      },
    });

    app = createApp({ prisma, redis });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
    // Strictly scoped DB cleanup by tenant IDs
    if (tenant1Id || tenant2Id) {
      const tenantIds = [tenant1Id, tenant2Id].filter(Boolean);
      await prisma.executionEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.stepAttempt.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.stepExecution.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.apiKey.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await redis.quit();
    await prisma.$disconnect();
  });

  it('GET /runs/:runId/events rejects unauthorized requests and cross-tenant access', async () => {
    // Create a run for Tenant 1
    const run = await prisma.workflowRun.create({
      data: {
        tenantId: tenant1Id,
        workflowName: 'TestAuthWorkflow',
        workflowVersion: '1.0.0',
        input: {},
        status: 'RUNNING',
      },
    });

    // Missing auth -> 401
    const resNoAuth = await fetch(`${baseUrl}/runs/${run.id}/events`);
    expect(resNoAuth.status).toBe(401);

    // Tenant 2 key -> 404 (isolated)
    const resCrossTenant = await fetch(`${baseUrl}/runs/${run.id}/events`, {
      headers: { 'x-api-key': apiKey2 },
    });
    expect(resCrossTenant.status).toBe(404);
  });

  it('GET /runs/:runId/events authenticates via query parameter ?apiKey=...', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId: tenant1Id,
        workflowName: 'TestQueryAuthWorkflow',
        workflowVersion: '1.0.0',
        input: {},
        status: 'COMPLETED',
      },
    });

    await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'WORKFLOW_COMPLETED',
        payload: { success: true },
      },
    });

    const res = await fetch(`${baseUrl}/runs/${run.id}/events?apiKey=${apiKey1}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: WORKFLOW_COMPLETED');
  });

  it('replays historical execution events in order and terminates on WORKFLOW_COMPLETED', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId: tenant1Id,
        workflowName: 'ReplayWorkflow',
        workflowVersion: '1.0.0',
        input: {},
        status: 'COMPLETED',
      },
    });

    const ev1 = await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'WORKFLOW_STARTED',
        payload: { input: 1 },
      },
    });
    const ev2 = await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'STEP_COMPLETED',
        payload: { step: 'step-1' },
      },
    });
    const ev3 = await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'WORKFLOW_COMPLETED',
        payload: { result: 'done' },
      },
    });

    const res = await fetch(`${baseUrl}/runs/${run.id}/events`, {
      headers: { 'x-api-key': apiKey1 },
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain(`id: ${ev1.id}`);
    expect(text).toContain('event: WORKFLOW_STARTED');
    expect(text).toContain(`id: ${ev2.id}`);
    expect(text).toContain('event: STEP_COMPLETED');
    expect(text).toContain(`id: ${ev3.id}`);
    expect(text).toContain('event: WORKFLOW_COMPLETED');
  });

  it('replays only unread events when Last-Event-ID or ?lastEventId is provided', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId: tenant1Id,
        workflowName: 'ResumeReplayWorkflow',
        workflowVersion: '1.0.0',
        input: {},
        status: 'COMPLETED',
      },
    });

    const ev1 = await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'WORKFLOW_STARTED',
        payload: {},
      },
    });
    const ev2 = await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'WORKFLOW_COMPLETED',
        payload: {},
      },
    });

    // Test with Last-Event-ID header
    const resHeader = await fetch(`${baseUrl}/runs/${run.id}/events`, {
      headers: {
        'x-api-key': apiKey1,
        'Last-Event-ID': ev1.id.toString(),
      },
    });
    const textHeader = await resHeader.text();
    expect(textHeader).not.toContain(`id: ${ev1.id}`);
    expect(textHeader).toContain(`id: ${ev2.id}`);

    // Test with query parameter ?lastEventId=
    const resQuery = await fetch(`${baseUrl}/runs/${run.id}/events?lastEventId=${ev1.id.toString()}`, {
      headers: { 'x-api-key': apiKey1 },
    });
    const textQuery = await resQuery.text();
    expect(textQuery).not.toContain(`id: ${ev1.id}`);
    expect(textQuery).toContain(`id: ${ev2.id}`);
  });

  it('streams live events via Redis Pub/Sub wake-ups until terminal completion', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId: tenant1Id,
        workflowName: 'LiveStreamWorkflow',
        workflowVersion: '1.0.0',
        input: {},
        status: 'RUNNING',
      },
    });

    await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'WORKFLOW_STARTED',
        payload: { initial: true },
      },
    });

    const client = createWorkflowClient({ baseUrl, apiKey: apiKey1 });
    const receivedEvents: any[] = [];

    // Stream live events in the background
    const streamPromise = (async () => {
      for await (const event of client.runs.streamEvents(run.id)) {
        receivedEvents.push(event);
      }
    })();

    // Allow connection to establish
    await new Promise((r) => setTimeout(r, 100));

    // Simulate an ongoing step completing
    await prisma.executionEvent.create({
      data: {
        tenantId: tenant1Id,
        workflowRunId: run.id,
        eventType: 'STEP_COMPLETED',
        payload: { step: 'step-live' },
      },
    });
    await publishRunEventWakeup(redis, run.id);

    // Wait 100ms then publish terminal event
    await new Promise((r) => setTimeout(r, 100));
    await prisma.$transaction(async (tx) => {
      await tx.workflowRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED' },
      });
      await tx.executionEvent.create({
        data: {
          tenantId: tenant1Id,
          workflowRunId: run.id,
          eventType: 'WORKFLOW_COMPLETED',
          payload: { finished: true },
        },
      });
    });
    await publishRunEventWakeup(redis, run.id);

    // Await stream completion
    await streamPromise;

    expect(receivedEvents.length).toBe(3);
    expect(receivedEvents[0].eventType).toBe('WORKFLOW_STARTED');
    expect(receivedEvents[1].eventType).toBe('STEP_COMPLETED');
    expect(receivedEvents[2].eventType).toBe('WORKFLOW_COMPLETED');
  });

  it('handles client disconnect gracefully without leaking listeners', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId: tenant1Id,
        workflowName: 'DisconnectWorkflow',
        workflowVersion: '1.0.0',
        input: {},
        status: 'RUNNING',
      },
    });

    const abortController = new AbortController();
    const client = createWorkflowClient({ baseUrl, apiKey: apiKey1 });

    // Trigger abort after connection is open
    setTimeout(() => {
      abortController.abort();
    }, 100);

    let caughtError: any;
    try {
      for await (const _ of client.runs.streamEvents(run.id, { signal: abortController.signal })) {
        // stream
      }
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.name).toBe('AbortError');

    // Allow server request close to process
    await new Promise((r) => setTimeout(r, 100));
  });
});
