import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { runFencingBenchmark } from '../src/bench-fencing.js';
import { runRetryBenchmark } from '../src/bench-retry.js';

describe('Task 4: Distributed Fencing & Retry Overhead Harness', () => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const tenantId = crypto.randomUUID();
  let db: PrismaClient;

  beforeAll(async () => {
    db = createPrismaClient(databaseUrl);
    await db.$connect();
    await db.tenant.create({ data: { id: tenantId, name: 'Fencing Retry Test' } });
  });

  afterAll(async () => {
    if (db) {
      await db.workflowRun.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
      await db.$disconnect().catch(() => {});
    }
  });

  it('rejects stale zombie worker commit when lease expires and replacement completes', async () => {
    const result = await runFencingBenchmark({
      leaseTtlMs: 1500,
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: `test_fencing_${crypto.randomUUID().slice(0, 6)}`,
    });

    expect(result.scenario).toBe('ZOMBIE_WORKER_FENCING');
    expect(result.fencingEnforced).toBe(true);
    expect(result.workerBStatus).toBe('COMPLETED');
    expect(result.workerAAttemptNumber).toBe(1);
    expect(result.workerBAttemptNumber).toBe(2);
    expect(result.finalStepAttemptCount).toBe(2);
    expect(result.workerAError).toBeDefined();
    expect(result.workerAError.length).toBeGreaterThan(0);
    expect(result.status).toBe('PASSED');
  }, 15000);

  it('measures throughput degradation across failure rates (0% vs 20%)', async () => {
    const result = await runRetryBenchmark({
      failureRates: [0, 20],
      workflowsPerTier: 10,
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: `test_retry_${crypto.randomUUID().slice(0, 6)}`,
    });

    expect(result.scenario).toBe('RELIABILITY_RETRY_OVERHEAD');
    expect(result.tiers.length).toBe(2);
    expect(result.tiers[0]!.meanAttemptsPerWorkflow).toBe(1);
    expect(result.tiers[1]!.meanAttemptsPerWorkflow).toBeGreaterThan(1);
    expect(result.status).toBe('PASSED');
  }, 15000);
});
