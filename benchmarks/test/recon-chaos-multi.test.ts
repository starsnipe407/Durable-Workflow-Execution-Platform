import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { createWorkflowQueue } from '@durable/worker';
import { runMultiTierReconciliationBenchmark } from '../src/bench-reconciliation.js';
import { runMultiTtlChaosBenchmark } from '../src/bench-chaos.js';

describe('Task 3: Multi-Tier Reconciliation & Multi-TTL Chaos', () => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const tenantId = crypto.randomUUID();
  const queueRecon = `test_multi_recon_${crypto.randomUUID().slice(0, 6)}`;
  const queueChaos = `test_multi_chaos_${crypto.randomUUID().slice(0, 6)}`;
  let db: PrismaClient;

  beforeAll(async () => {
    db = createPrismaClient(databaseUrl);
    await db.$connect();
    await db.tenant.create({ data: { id: tenantId, name: 'Recon Chaos Multi Test' } });
  });

  afterAll(async () => {
    if (db) {
      await db.stepAttempt.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.stepExecution.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.executionEvent.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.workflowRun.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
      await db.$disconnect().catch(() => {});
    }
    const q1 = createWorkflowQueue(redisUrl, queueRecon);
    await q1.obliterate({ force: true }).catch(() => {});
    await q1.close().catch(() => {});

    const q2 = createWorkflowQueue(redisUrl, queueChaos);
    await q2.obliterate({ force: true }).catch(() => {});
    await q2.close().catch(() => {});
  });

  it('runs multi-tier reconciliation sweep asserting 0 lost and 0 duplicates across tiers', async () => {
    const res = await runMultiTierReconciliationBenchmark({
      tiers: [5, 10], // Fast test tiers
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: queueRecon,
    });

    expect(res.scenario).toBe('MULTI_TIER_REDIS_RECONSTRUCTION');
    expect(res.redisFlushCommand).toBe('FLUSHALL');
    expect(res.tiers.length).toBe(2);
    for (const t of res.tiers) {
      expect(t.lostRunsCount).toBe(0);
      expect(t.duplicateRunsCount).toBe(0);
      expect(t.completedRunsCount).toBe(t.totalRunsSubmitted);
      expect(t.reconstructionDurationMs).toBeGreaterThanOrEqual(0);
      expect(t.requeueRatePerSec).toBeGreaterThanOrEqual(0);
      expect(t.status).toBe('PASSED');
    }
    expect(res.status).toBe('PASSED');
  }, 30000);

  it('runs multi-TTL chaos sweep asserting recovery across lease durations', async () => {
    const res = await runMultiTtlChaosBenchmark({
      ttlsMs: [1000, 2000], // Fast test TTLs
      repetitionsPerTtl: 1,
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: queueChaos,
    });

    expect(res.scenario).toBe('MULTI_TTL_CHAOS_SWEEP');
    expect(res.results.length).toBe(2);
    for (const r of res.results) {
      expect(r.status).toBe('COMPLETED');
      expect(r.duplicateStepCalls).toBe(0);
      expect(r.workerPid).toBeGreaterThan(0);
      expect(r.recoveryLatencyMs).toBeGreaterThan(0);
    }
    expect(res.status).toBe('PASSED');
  }, 30000);
});
