import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { createWorkflowQueue } from '@durable/worker';
import { runChaosBenchmark, type ChaosBenchOptions } from '../src/bench-chaos.js';
import { runReconciliationBenchmark, type ReconcilerBenchOptions } from '../src/bench-reconciliation.js';

describe('Real Fault Injection Chaos & Reconciler Resilience Harness', () => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const testTenantId = crypto.randomUUID();
  const testQueueName = `test_chaos_queue_${crypto.randomUUID().slice(0, 8)}`;

  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    await prisma.tenant.create({
      data: { id: testTenantId, name: `Chaos Test Tenant ${testTenantId}` },
    });
  });

  afterAll(async () => {
    // Purge test tenant database records
    if (prisma && testTenantId) {
      try {
        await prisma.stepAttempt.deleteMany({ where: { tenantId: testTenantId } });
        await prisma.stepExecution.deleteMany({ where: { tenantId: testTenantId } });
        await prisma.executionEvent.deleteMany({ where: { tenantId: testTenantId } });
        await prisma.workflowRun.deleteMany({ where: { tenantId: testTenantId } });
        await prisma.tenant.deleteMany({ where: { id: testTenantId } });
      } catch {}
      await prisma.$disconnect();
    }

    // Clean test queue in Redis
    try {
      const q = createWorkflowQueue(redisUrl, testQueueName);
      await q.obliterate({ force: true }).catch(() => {});
      await q.close();
    } catch {}
  });

  describe('Real SIGKILL Worker Chaos Benchmark (bench-chaos.ts)', () => {
    it('executes genuine process.kill SIGKILL mid-workflow and recovers with 0 duplicate memoized step calls', async () => {
      const chaosOptions: ChaosBenchOptions = {
        leaseTtlMs: 2000,
        tenantId: testTenantId,
        databaseUrl,
        redisUrl,
        queueName: testQueueName,
        timeoutMs: 20000,
      };

      const result = await runChaosBenchmark(chaosOptions);

      expect(result).toBeDefined();
      expect(result.scenario).toBe('WORKER_SIGKILL_RECOVERY');
      expect(result.killSignal).toBe('SIGKILL');
      expect(result.status).toBe('COMPLETED');
      expect(result.leaseTtlMs).toBe(2000);
      expect(result.workerPid).toBeGreaterThan(0);
      expect(result.recoveryLatencyMs).toBeGreaterThan(0);
      expect(result.duplicateStepCalls).toBe(0);

      // Verify PostgreSQL authoritative state
      const run = await prisma.workflowRun.findUnique({
        where: { id: result.workflowRunId },
      });
      expect(run).toBeDefined();
      expect(run?.status).toBe('COMPLETED');

      const steps = await prisma.stepExecution.findMany({
        where: { workflowRunId: result.workflowRunId },
        orderBy: { stepKey: 'asc' },
      });

      // Assert 5 steps completed
      expect(steps.length).toBe(5);
      for (const step of steps) {
        expect(step.status).toBe('COMPLETED');
      }

      // Step 1 was memoized: attemptCount must be exactly 1
      const step1 = steps.find((s) => s.stepKey === 'step-1-init');
      expect(step1).toBeDefined();
      expect(step1?.attemptCount).toBe(1);

      // Step 2 was interrupted by SIGKILL: attemptCount must be 2 (attempt 1 killed/abandoned, attempt 2 completed)
      const step2 = steps.find((s) => s.stepKey === 'step-2-process');
      expect(step2).toBeDefined();
      expect(step2?.attemptCount).toBe(2);

      // Verify attempts for step 2
      const step2Attempts = await prisma.stepAttempt.findMany({
        where: { stepExecutionId: step2!.id },
        orderBy: { attemptNumber: 'asc' },
      });
      expect(step2Attempts.length).toBe(2);
      expect(step2Attempts[0]?.status).toBe('ABANDONED');
      expect(step2Attempts[1]?.status).toBe('COMPLETED');
    }, 25000);
  });

  describe('Redis Destruction & Reconciler Resilience Benchmark (bench-reconciliation.ts)', () => {
    it('recovers from real Redis FLUSHALL queue destruction with 0 lost runs and 0 duplicates', async () => {
      const reconOptions: ReconcilerBenchOptions = {
        totalRuns: 5,
        tenantId: testTenantId,
        databaseUrl,
        redisUrl,
        queueName: `${testQueueName}_recon`,
        timeoutMs: 25000,
      };

      const result = await runReconciliationBenchmark(reconOptions);

      expect(result).toBeDefined();
      expect(result.scenario).toBe('REDIS_DESTRUCTION_RECONCILER');
      expect(result.redisFlushCommand).toBe('FLUSHALL');
      expect(result.status).toBe('PASSED');
      expect(result.totalRunsSubmitted).toBe(5);
      expect(result.lostRunsCount).toBe(0);
      expect(result.duplicateRunsCount).toBe(0);
      expect(result.completedRunsCount).toBe(5);
      expect(result.reconstructionDurationMs).toBeGreaterThan(0);

      // Verify PostgreSQL authoritative state
      const completedRuns = await prisma.workflowRun.findMany({
        where: {
          tenantId: testTenantId,
          workflowName: 'process-order',
        },
      });
      expect(completedRuns.length).toBe(5);
      for (const r of completedRuns) {
        expect(r.status).toBe('COMPLETED');
      }
    }, 30000);
  });
});
