import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { createWorkflowQueue } from '@durable/worker';
import { runThroughputBenchmark } from '../src/bench-throughput.js';
import { runSaturationBenchmark } from '../src/bench-saturation.js';

describe('Task 2: Throughput Scaling & Saturation Harness', () => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const tenantId = crypto.randomUUID();
  const queueName = `test_thru_sat_${crypto.randomUUID().slice(0, 8)}`;
  let db: PrismaClient;

  beforeAll(async () => {
    db = createPrismaClient(databaseUrl);
    await db.$connect();
    await db.tenant.create({ data: { id: tenantId, name: 'Throughput Saturation Test' } });
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
    const qTp = createWorkflowQueue(redisUrl, `${queueName}_tp`);
    await qTp.obliterate({ force: true }).catch(() => {});
    await qTp.close().catch(() => {});

    const qSat = createWorkflowQueue(redisUrl, `${queueName}_sat`);
    await qSat.obliterate({ force: true }).catch(() => {});
    await qSat.close().catch(() => {});
  });

  it('measures throughput with steps/sec and queue latency percentiles', async () => {
    const results = await runThroughputBenchmark({
      tiers: [1],
      concurrencyPerWorker: 4,
      warmupRuns: 2,
      measuredRepetitions: 1,
      runsPerRepetition: 10,
      tenantId,
      queueName: `${queueName}_tp`,
      workflowName: 'engine-benchmark',
    });

    expect(results.length).toBe(1);
    const tier = results[0]!;
    expect(tier.workerReplicas).toBe(1);
    expect(tier.stepsPerSec).toBeDefined();
    expect(tier.stepsPerSec!).toBeGreaterThan(0);
    expect(tier.workflowLatencyMs?.p50).toBeGreaterThan(0);
    expect(tier.queueLatencyMs?.p95).toBeDefined();
    expect(tier.queueLatencyMs?.p95).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('runs saturation tiers and detects queue growth rate', async () => {
    const saturation = await runSaturationBenchmark({
      rates: [10, 25],
      durationPerTierSec: 2,
      workerReplicas: 1,
      concurrencyPerWorker: 4,
      tenantId,
      queueName: `${queueName}_sat`,
    });

    expect(saturation.scenario).toBe('OFFERED_LOAD_SATURATION');
    expect(saturation.tiers.length).toBe(2);
    expect(saturation.status).toBe('PASSED');
    for (const t of saturation.tiers) {
      expect(t.acceptedRuns).toBeGreaterThan(0);
      expect(t.queueLatencyMs.p50).toBeGreaterThanOrEqual(0);
    }
  }, 30000);
});
