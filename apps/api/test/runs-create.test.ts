import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import { PrismaClient } from '@durable/database';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';
import { FastifyInstance } from 'fastify';

const prisma = new PrismaClient();
let app: FastifyInstance;
let tenantId: string;
let apiKey: string;
let mockQueue: any;

beforeAll(async () => {
  mockQueue = {
    add: vi.fn().mockResolvedValue({ id: 'job_1' }),
  };
  
  app = createApp({ prisma, queue: mockQueue as any });
  await app.ready();
  
  const tenant = await prisma.tenant.create({
    data: { name: 'Test Tenant Runs Create' },
  });
  tenantId = tenant.id;
  
  apiKey = 'test_api_key_runs_create';
  await prisma.apiKey.create({
    data: {
      keyHash: hashApiKey(apiKey),
      tenantId,
      label: 'test',
    },
  });
});

afterAll(async () => {
  await prisma.executionEvent.deleteMany({ where: { tenantId } });
  await prisma.workflowRun.deleteMany({ where: { tenantId } });
  await prisma.apiKey.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
  
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  mockQueue.add.mockClear();
});

describe('POST /runs', () => {
  it('1. Fails with 400 if workflowName is missing or empty', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBeDefined();
  });

  it('2. Valid POST /runs creates run in PENDING status, records WORKFLOW_CREATED event, enqueues to BullMQ queue, and returns 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        workflowName: 'TestWorkflow',
        input: { foo: 'bar' },
      },
    });
    
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.workflowName).toBe('TestWorkflow');
    expect(body.status).toBe('PENDING');
    
    // Check DB
    const run = await prisma.workflowRun.findUnique({ where: { id: body.id } });
    expect(run).toBeDefined();
    expect(run?.status).toBe('PENDING');
    
    const events = await prisma.executionEvent.findMany({ where: { workflowRunId: body.id } });
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe('WORKFLOW_CREATED');
    
    // Check Queue
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'run_' + body.id,
      expect.objectContaining({ runId: body.id }),
      expect.any(Object)
    );
  });

  it('3. Network retry with identical Idempotency-Key header returns HTTP 200 with original run', async () => {
    const idempotencyKey = 'idemp_key_123';
    
    // First request
    const response1 = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey },
      payload: {
        workflowName: 'IdempWorkflow',
        input: { retry: true },
      },
    });
    
    expect(response1.statusCode).toBe(201);
    const body1 = response1.json();
    
    mockQueue.add.mockClear();
    
    // Second request
    const response2 = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey },
      payload: {
        workflowName: 'IdempWorkflow',
        input: { retry: true },
      },
    });
    
    expect(response2.statusCode).toBe(200);
    const body2 = response2.json();
    expect(body2.id).toBe(body1.id);
    
    // Only one run created
    const runs = await prisma.workflowRun.findMany({ where: { requestIdempotencyKey: idempotencyKey } });
    expect(runs.length).toBe(1);
    
    // Queue should not be called again
    expect(mockQueue.add).toHaveBeenCalledTimes(0);
  });

  it('4. Concurrent requests with identical idempotency key both succeed, exactly 1 DB record created', async () => {
    const idempotencyKey = 'idemp_concurrent_456';
    
    const req1 = app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        workflowName: 'ConcurrentWorkflow',
        requestIdempotencyKey: idempotencyKey,
      },
    });
    
    const req2 = app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        workflowName: 'ConcurrentWorkflow',
        requestIdempotencyKey: idempotencyKey,
      },
    });
    
    const [res1, res2] = await Promise.all([req1, req2]);
    
    const statusCodes = [res1.statusCode, res2.statusCode].sort();
    expect(statusCodes).toEqual([200, 201]); // One creates, one finds existing
    
    const id1 = res1.json().id;
    const id2 = res2.json().id;
    expect(id1).toBe(id2);
    
    const runs = await prisma.workflowRun.findMany({ where: { requestIdempotencyKey: idempotencyKey } });
    expect(runs.length).toBe(1);
  });
});
