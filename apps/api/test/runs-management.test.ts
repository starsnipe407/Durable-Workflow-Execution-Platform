import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import { PrismaClient } from '@durable/database';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';
import { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { WORKFLOW_JOB_NAME } from '@durable/worker';

const prisma = new PrismaClient();
let app: FastifyInstance;
let tenantId: string;
let apiKey: string;
let tenant2Id: string;
let apiKey2: string;
let mockQueue: any;

beforeAll(async () => {
  mockQueue = {
    add: vi.fn().mockResolvedValue({ id: 'job_1' }),
  };
  
  app = createApp({ prisma, queue: mockQueue as any });
  await app.ready();
  
  const tenant = await prisma.tenant.create({
    data: { name: 'Test Tenant Mgmt 1' },
  });
  tenantId = tenant.id;
  
  apiKey = 'test_api_key_mgmt_1';
  await prisma.apiKey.create({
    data: {
      keyHash: hashApiKey(apiKey),
      tenantId,
      label: 'test1',
    },
  });

  const tenant2 = await prisma.tenant.create({
    data: { name: 'Test Tenant Mgmt 2' },
  });
  tenant2Id = tenant2.id;
  
  apiKey2 = 'test_api_key_mgmt_2';
  await prisma.apiKey.create({
    data: {
      keyHash: hashApiKey(apiKey2),
      tenantId: tenant2Id,
      label: 'test2',
    },
  });
});

afterAll(async () => {
  await prisma.executionEvent.deleteMany({ where: { tenantId: { in: [tenantId, tenant2Id] } } });
  await prisma.stepExecution.deleteMany({ where: { tenantId: { in: [tenantId, tenant2Id] } } });
  await prisma.workflowRun.deleteMany({ where: { tenantId: { in: [tenantId, tenant2Id] } } });
  await prisma.apiKey.deleteMany({ where: { tenantId: { in: [tenantId, tenant2Id] } } });
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, tenant2Id] } } });
  
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mockQueue.add.mockClear();
  await prisma.executionEvent.deleteMany({ where: { tenantId: { in: [tenantId, tenant2Id] } } });
  await prisma.stepExecution.deleteMany({ where: { tenantId: { in: [tenantId, tenant2Id] } } });
  await prisma.workflowRun.deleteMany({ where: { tenantId: { in: [tenantId, tenant2Id] } } });
});

describe('Runs Management', () => {

  it('GET /runs/:id returns 404 for non-existent or cross-tenant run', async () => {
    const run1 = await prisma.workflowRun.create({
      data: {
        tenantId,
        workflowName: 'test-wf',
        workflowVersion: '1.0',
        input: {},
        status: 'PENDING',
      }
    });

    // Cross tenant
    const resCross = await app.inject({
      method: 'GET',
      url: `/runs/${run1.id}`,
      headers: { authorization: `Bearer ${apiKey2}` },
    });
    expect(resCross.statusCode).toBe(404);

    // Non-existent (must be valid uuid so Prisma does not throw P2023)
    const resMissing = await app.inject({
      method: 'GET',
      url: `/runs/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(resMissing.statusCode).toBe(404);
  });

  it('GET /runs/:id returns run with step executions for authorized tenant', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId,
        workflowName: 'test-wf',
        workflowVersion: '1.0',
        input: {},
        status: 'PENDING',
      }
    });

    await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run.id,
        stepKey: 'step-1',
        status: 'COMPLETED',
        startedAt: new Date(),
        completedAt: new Date(),
        output: { foo: 'bar' }
      }
    });

    const res = await app.inject({
      method: 'GET',
      url: `/runs/${run.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.id).toBe(run.id);
    expect(data.stepExecutions).toBeDefined();
    expect(data.stepExecutions.length).toBe(1);
    expect(data.stepExecutions[0].stepKey).toBe('step-1');
  });

  it('GET /runs lists runs filtered by status and tenant', async () => {
    await prisma.workflowRun.create({ data: { tenantId, workflowName: 'wf1', workflowVersion: '1.0', input: {}, status: 'PENDING' }});
    await prisma.workflowRun.create({ data: { tenantId, workflowName: 'wf2', workflowVersion: '1.0', input: {}, status: 'COMPLETED' }});
    await prisma.workflowRun.create({ data: { tenantId, workflowName: 'wf1', workflowVersion: '1.0', input: {}, status: 'COMPLETED' }});
    await prisma.workflowRun.create({ data: { tenantId: tenant2Id, workflowName: 'wf1', workflowVersion: '1.0', input: {}, status: 'COMPLETED' }}); // Cross tenant

    // Get all for tenant1
    const res1 = await app.inject({ method: 'GET', url: `/runs`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().runs.length).toBe(3);

    // Filter by status
    const res2 = await app.inject({ method: 'GET', url: `/runs?status=COMPLETED`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().runs.length).toBe(2);

    // Filter by workflowName
    const res3 = await app.inject({ method: 'GET', url: `/runs?workflowName=wf2`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(res3.statusCode).toBe(200);
    expect(res3.json().runs.length).toBe(1);
    
    // Filter by limit
    const res4 = await app.inject({ method: 'GET', url: `/runs?limit=2`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(res4.statusCode).toBe(200);
    expect(res4.json().runs.length).toBe(2);
  });

  it('POST /runs/:id/retry successfully resets FAILED run to PENDING, logs event, enqueues replay job', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId,
        workflowName: 'test-wf',
        workflowVersion: '1.0',
        input: {},
        status: 'FAILED',
        failedAt: new Date(),
        error: 'some error',
        workflowAttempt: 1
      }
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${run.id}/retry`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.status).toBe('PENDING');
    expect(data.failedAt).toBeNull();
    expect(data.error).toBeNull();
    expect(data.workflowAttempt).toBe(2);

    const event = await prisma.executionEvent.findFirst({
      where: { workflowRunId: run.id, eventType: 'WORKFLOW_RETRY_REQUESTED' }
    });
    expect(event).toBeDefined();
    
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      WORKFLOW_JOB_NAME,
      expect.objectContaining({ runId: run.id }),
      expect.objectContaining({ jobId: 'replay_' + run.id + '_attempt_2' })
    );
  });

  it('POST /runs/:id/retry rejects non-failed run with 400', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        tenantId,
        workflowName: 'test-wf',
        workflowVersion: '1.0',
        input: {},
        status: 'COMPLETED',
        workflowAttempt: 1
      }
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${run.id}/retry`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Cannot retry run/);
  });

  it('POST /runs/:id/cancel cancels PENDING run directly to CANCELLED', async () => {
    const run = await prisma.workflowRun.create({
      data: { tenantId, workflowName: 'test-wf', workflowVersion: '1.0', input: {}, status: 'PENDING' }
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${run.id}/cancel`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.status).toBe('CANCELLED');
    expect(data.cancelledAt).not.toBeNull();
  });

  it('POST /runs/:id/cancel marks RUNNING run as CANCEL_REQUESTED', async () => {
    const run = await prisma.workflowRun.create({
      data: { tenantId, workflowName: 'test-wf', workflowVersion: '1.0', input: {}, status: 'RUNNING' }
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${run.id}/cancel`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.status).toBe('CANCEL_REQUESTED');
  });

  it('POST /runs/:id/cancel rejects terminal runs with 400', async () => {
    const run = await prisma.workflowRun.create({
      data: { tenantId, workflowName: 'test-wf', workflowVersion: '1.0', input: {}, status: 'COMPLETED' }
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${run.id}/cancel`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Cannot cancel/);
  });

});
