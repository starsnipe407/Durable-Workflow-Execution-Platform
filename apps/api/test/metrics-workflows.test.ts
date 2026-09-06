import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';
import { Redis } from 'ioredis';
import { FastifyInstance } from 'fastify';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6380');

describe('Metrics & Workflows API & Run Enrichment', () => {
  let app: FastifyInstance;
  let tenant1Id: string;
  let apiKey1: string;
  let tenant2Id: string;
  let apiKey2: string;

  beforeAll(async () => {
    // Provision Tenant 1
    const t1 = await prisma.tenant.create({
      data: { name: `Test Tenant 1 ${crypto.randomUUID()}` },
    });
    tenant1Id = t1.id;

    apiKey1 = `key1_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey1),
        tenantId: tenant1Id,
        label: 'tenant1-key',
      },
    });

    // Provision Tenant 2
    const t2 = await prisma.tenant.create({
      data: { name: `Test Tenant 2 ${crypto.randomUUID()}` },
    });
    tenant2Id = t2.id;

    apiKey2 = `key2_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey2),
        tenantId: tenant2Id,
        label: 'tenant2-key',
      },
    });

    app = createApp({ prisma, redis });
    await app.ready();
  });

  afterAll(async () => {
    // Strictly scoped DB cleanup by tenant IDs
    if (tenant1Id || tenant2Id) {
      const tenantIds = [tenant1Id, tenant2Id].filter(Boolean);
      await prisma.stepAttempt.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.executionEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.stepExecution.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.workflowEventBinding.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.workflowDefinition.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.apiKey.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });

      // Scoped Redis cleanup
      await redis.del(`ratelimit:${tenant1Id}`);
      await redis.del(`ratelimit:${tenant2Id}`);
    }

    await app.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const tenantIds = [tenant1Id, tenant2Id].filter(Boolean);
    await prisma.stepAttempt.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.executionEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.stepExecution.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.workflowEventBinding.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.workflowDefinition.deleteMany({ where: { tenantId: { in: tenantIds } } });
  });

  describe('GET /metrics', () => {
    it('returns accurate run counts per status and systemStatus healthy scoped to tenant', async () => {
      // Seed runs for Tenant 1
      await prisma.workflowRun.createMany({
        data: [
          { tenantId: tenant1Id, workflowName: 'wf1', workflowVersion: '1.0.0', input: {}, status: 'PENDING' },
          { tenantId: tenant1Id, workflowName: 'wf1', workflowVersion: '1.0.0', input: {}, status: 'RUNNING' },
          { tenantId: tenant1Id, workflowName: 'wf2', workflowVersion: '1.0.0', input: {}, status: 'CANCEL_REQUESTED' },
          { tenantId: tenant1Id, workflowName: 'wf1', workflowVersion: '1.0.0', input: {}, status: 'COMPLETED' },
          { tenantId: tenant1Id, workflowName: 'wf1', workflowVersion: '1.0.0', input: {}, status: 'COMPLETED' },
          { tenantId: tenant1Id, workflowName: 'wf2', workflowVersion: '1.0.0', input: {}, status: 'FAILED' },
          { tenantId: tenant1Id, workflowName: 'wf2', workflowVersion: '1.0.0', input: {}, status: 'CANCELLED' },
        ],
      });

      // Seed runs for Tenant 2 (isolation check)
      await prisma.workflowRun.createMany({
        data: [
          { tenantId: tenant2Id, workflowName: 'wf_other', workflowVersion: '1.0.0', input: {}, status: 'COMPLETED' },
          { tenantId: tenant2Id, workflowName: 'wf_other', workflowVersion: '1.0.0', input: {}, status: 'COMPLETED' },
          { tenantId: tenant2Id, workflowName: 'wf_other', workflowVersion: '1.0.0', input: {}, status: 'RUNNING' },
        ],
      });

      // Tenant 1 metrics request
      const res1 = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${apiKey1}` },
      });

      expect(res1.statusCode).toBe(200);
      const data1 = res1.json();
      expect(data1).toEqual({
        activeRuns: 3, // PENDING (1) + RUNNING (1) + CANCEL_REQUESTED (1)
        completedRuns: 2,
        failedRuns: 1,
        cancelledRuns: 1,
        totalRuns: 7,
        systemStatus: 'healthy',
      });

      // Tenant 2 metrics request
      const res2 = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${apiKey2}` },
      });

      expect(res2.statusCode).toBe(200);
      const data2 = res2.json();
      expect(data2).toEqual({
        activeRuns: 1, // RUNNING (1)
        completedRuns: 2,
        failedRuns: 0,
        cancelledRuns: 0,
        totalRuns: 3,
        systemStatus: 'healthy',
      });
    });

    it('reports systemStatus: "degraded" when Redis ping fails', async () => {
      const pingSpy = vi.spyOn(redis, 'ping').mockRejectedValueOnce(new Error('Redis connection down'));

      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${apiKey1}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.systemStatus).toBe('degraded');

      pingSpy.mockRestore();
    });

    it('reports systemStatus: "degraded" when Database query fails', async () => {
      const querySpy = vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('DB unreachable'));

      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${apiKey1}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.systemStatus).toBe('degraded');

      querySpy.mockRestore();
    });

    it('requires authentication (401 without valid key)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /workflows', () => {
    it('aggregates registered definitions, event bindings, and runs for authenticated tenant', async () => {
      // Setup Tenant 1 definitions
      await prisma.workflowDefinition.createMany({
        data: [
          { tenantId: tenant1Id, name: 'order-process', version: '1.0.0' },
          { tenantId: tenant1Id, name: 'order-process', version: '1.1.0' },
          { tenantId: tenant1Id, name: 'user-onboard', version: '0.9.0' },
        ],
      });

      // Setup Tenant 1 event bindings
      await prisma.workflowEventBinding.createMany({
        data: [
          { tenantId: tenant1Id, eventName: 'order.placed', workflowName: 'order-process', workflowVersion: '1.0.0' },
          { tenantId: tenant1Id, eventName: 'order.paid', workflowName: 'order-process', workflowVersion: '1.1.0' },
        ],
      });

      // Setup Tenant 1 runs
      const olderDate = new Date('2026-09-01T10:00:00.000Z');
      const newerDate = new Date('2026-09-06T12:00:00.000Z');

      await prisma.workflowRun.createMany({
        data: [
          { tenantId: tenant1Id, workflowName: 'order-process', workflowVersion: '1.0.0', input: {}, createdAt: olderDate },
          { tenantId: tenant1Id, workflowName: 'order-process', workflowVersion: '1.1.0', input: {}, createdAt: newerDate },
          { tenantId: tenant1Id, workflowName: 'data-sync', workflowVersion: '2.0.0', input: {}, createdAt: olderDate },
        ],
      });

      // Setup Tenant 2 definitions & runs (must not leak)
      await prisma.workflowDefinition.create({
        data: { tenantId: tenant2Id, name: 'tenant2-secret-workflow', version: '1.0.0' },
      });
      await prisma.workflowRun.create({
        data: { tenantId: tenant2Id, workflowName: 'tenant2-secret-workflow', workflowVersion: '1.0.0', input: {} },
      });

      // Request Tenant 1 workflows
      const res1 = await app.inject({
        method: 'GET',
        url: '/workflows',
        headers: { authorization: `Bearer ${apiKey1}` },
      });

      expect(res1.statusCode).toBe(200);
      const body1 = res1.json();
      expect(body1.workflows).toBeDefined();
      expect(Array.isArray(body1.workflows)).toBe(true);
      expect(body1.workflows.map((w: any) => w.name)).toEqual(['data-sync', 'order-process', 'user-onboard']);

      const orderProcess = body1.workflows.find((w: any) => w.name === 'order-process');
      expect(orderProcess).toBeDefined();
      expect(orderProcess.versions).toEqual(['1.0.0', '1.1.0']);
      expect(orderProcess.triggers).toEqual([
        { eventName: 'order.placed', workflowVersion: '1.0.0' },
        { eventName: 'order.paid', workflowVersion: '1.1.0' },
      ]);
      expect(orderProcess.totalRuns).toBe(2);
      expect(orderProcess.lastRunAt).toBe(newerDate.toISOString());

      const userOnboard = body1.workflows.find((w: any) => w.name === 'user-onboard');
      expect(userOnboard).toBeDefined();
      expect(userOnboard.versions).toEqual(['0.9.0']);
      expect(userOnboard.triggers).toEqual([]);
      expect(userOnboard.totalRuns).toBe(0);
      expect(userOnboard.lastRunAt).toBeNull();

      const dataSync = body1.workflows.find((w: any) => w.name === 'data-sync');
      expect(dataSync).toBeDefined();
      expect(dataSync.versions).toEqual(['2.0.0']);
      expect(dataSync.totalRuns).toBe(1);
      expect(dataSync.lastRunAt).toBe(olderDate.toISOString());

      // Ensure tenant 2 workflow is not present
      expect(body1.workflows.find((w: any) => w.name === 'tenant2-secret-workflow')).toBeUndefined();

      // Request Tenant 2 workflows
      const res2 = await app.inject({
        method: 'GET',
        url: '/workflows',
        headers: { authorization: `Bearer ${apiKey2}` },
      });

      expect(res2.statusCode).toBe(200);
      const body2 = res2.json();
      expect(body2.workflows.length).toBe(1);
      expect(body2.workflows[0].name).toBe('tenant2-secret-workflow');
    });

    it('requires authentication (401 without valid key)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workflows',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /runs/:id enrichment with nested stepAttempts', () => {
    it('returns stepExecutions including nested stepAttempts ordered by attemptNumber asc', async () => {
      const run = await prisma.workflowRun.create({
        data: {
          tenantId: tenant1Id,
          workflowName: 'enrichment-wf',
          workflowVersion: '1.0.0',
          input: { key: 'val' },
          status: 'RUNNING',
        },
      });

      const step = await prisma.stepExecution.create({
        data: {
          tenantId: tenant1Id,
          workflowRunId: run.id,
          stepKey: 'step-validate',
          status: 'COMPLETED',
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      await prisma.stepAttempt.createMany({
        data: [
          {
            tenantId: tenant1Id,
            stepExecutionId: step.id,
            attemptNumber: 1,
            status: 'FAILED',
            errorMessage: 'Attempt 1 failed: network blip',
            startedAt: new Date('2026-09-06T10:00:00Z'),
            finishedAt: new Date('2026-09-06T10:00:01Z'),
          },
          {
            tenantId: tenant1Id,
            stepExecutionId: step.id,
            attemptNumber: 2,
            status: 'COMPLETED',
            startedAt: new Date('2026-09-06T10:00:02Z'),
            finishedAt: new Date('2026-09-06T10:00:03Z'),
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/runs/${run.id}`,
        headers: { authorization: `Bearer ${apiKey1}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.id).toBe(run.id);
      expect(data.stepExecutions).toBeDefined();
      expect(data.stepExecutions.length).toBe(1);

      const stepExec = data.stepExecutions[0];
      expect(stepExec.stepKey).toBe('step-validate');
      expect(stepExec.stepAttempts).toBeDefined();
      expect(stepExec.stepAttempts.length).toBe(2);
      expect(stepExec.stepAttempts[0].attemptNumber).toBe(1);
      expect(stepExec.stepAttempts[0].status).toBe('FAILED');
      expect(stepExec.stepAttempts[0].errorMessage).toBe('Attempt 1 failed: network blip');
      expect(stepExec.stepAttempts[1].attemptNumber).toBe(2);
      expect(stepExec.stepAttempts[1].status).toBe('COMPLETED');
    });
  });

  describe('GET /runs offset pagination', () => {
    it('supports offset query parameter to paginate runs', async () => {
      const d1 = new Date('2026-09-01T10:00:00.000Z');
      const d2 = new Date('2026-09-02T10:00:00.000Z');
      const d3 = new Date('2026-09-03T10:00:00.000Z');

      const run1 = await prisma.workflowRun.create({
        data: { tenantId: tenant1Id, workflowName: 'page-wf', workflowVersion: '1.0.0', input: {}, createdAt: d1 },
      });
      const run2 = await prisma.workflowRun.create({
        data: { tenantId: tenant1Id, workflowName: 'page-wf', workflowVersion: '1.0.0', input: {}, createdAt: d2 },
      });
      const run3 = await prisma.workflowRun.create({
        data: { tenantId: tenant1Id, workflowName: 'page-wf', workflowVersion: '1.0.0', input: {}, createdAt: d3 },
      });

      // Query offset=0 limit=1 -> newest run3
      const resPage1 = await app.inject({
        method: 'GET',
        url: '/runs?workflowName=page-wf&limit=1&offset=0',
        headers: { authorization: `Bearer ${apiKey1}` },
      });
      expect(resPage1.statusCode).toBe(200);
      expect(resPage1.json().runs.length).toBe(1);
      expect(resPage1.json().runs[0].id).toBe(run3.id);

      // Query offset=1 limit=1 -> run2
      const resPage2 = await app.inject({
        method: 'GET',
        url: '/runs?workflowName=page-wf&limit=1&offset=1',
        headers: { authorization: `Bearer ${apiKey1}` },
      });
      expect(resPage2.statusCode).toBe(200);
      expect(resPage2.json().runs.length).toBe(1);
      expect(resPage2.json().runs[0].id).toBe(run2.id);

      // Query offset=2 limit=1 -> oldest run1
      const resPage3 = await app.inject({
        method: 'GET',
        url: '/runs?workflowName=page-wf&limit=1&offset=2',
        headers: { authorization: `Bearer ${apiKey1}` },
      });
      expect(resPage3.statusCode).toBe(200);
      expect(resPage3.json().runs.length).toBe(1);
      expect(resPage3.json().runs[0].id).toBe(run1.id);

      // Query offset=3 limit=1 -> empty
      const resPage4 = await app.inject({
        method: 'GET',
        url: '/runs?workflowName=page-wf&limit=1&offset=3',
        headers: { authorization: `Bearer ${apiKey1}` },
      });
      expect(resPage4.statusCode).toBe(200);
      expect(resPage4.json().runs.length).toBe(0);
    });

    it('defensively sanitizes invalid, negative, or excessive limit and offset', async () => {
      // Seed 2 runs
      await prisma.workflowRun.createMany({
        data: [
          { tenantId: tenant1Id, workflowName: 'defensive-wf', workflowVersion: '1.0.0', input: {} },
          { tenantId: tenant1Id, workflowName: 'defensive-wf', workflowVersion: '1.0.0', input: {} },
        ],
      });

      // Invalid string for limit and offset
      const resInvalid = await app.inject({
        method: 'GET',
        url: '/runs?workflowName=defensive-wf&limit=invalid&offset=not-a-number',
        headers: { authorization: `Bearer ${apiKey1}` },
      });
      expect(resInvalid.statusCode).toBe(200);
      expect(resInvalid.json().runs.length).toBe(2);

      // Negative values for limit and offset
      const resNegative = await app.inject({
        method: 'GET',
        url: '/runs?workflowName=defensive-wf&limit=-10&offset=-5',
        headers: { authorization: `Bearer ${apiKey1}` },
      });
      expect(resNegative.statusCode).toBe(200);
      expect(resNegative.json().runs.length).toBe(2);

      // Zero limit defaults to 20
      const resZeroLimit = await app.inject({
        method: 'GET',
        url: '/runs?workflowName=defensive-wf&limit=0',
        headers: { authorization: `Bearer ${apiKey1}` },
      });
      expect(resZeroLimit.statusCode).toBe(200);
      expect(resZeroLimit.json().runs.length).toBe(2);
    });
  });
});
