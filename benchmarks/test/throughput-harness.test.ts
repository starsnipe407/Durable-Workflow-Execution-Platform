import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { createWorkflowQueue } from '@durable/worker';
import {
  runThroughputBenchmark,
  awaitRunsCompletedWithLatencies,
  stopWorkerProcesses,
} from '../src/bench-throughput.js';

import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerRunnerPath = path.resolve(__dirname, '../src/worker-runner.ts');

function getExecArgv(): string[] {
  const hasTsx = process.execArgv.some((arg) => arg.includes('tsx'));
  if (hasTsx) {
    return process.execArgv;
  }
  try {
    const req = createRequire(import.meta.url);
    const tsxPackage = req.resolve('tsx/package.json');
    const tsxLoader = path.resolve(path.dirname(tsxPackage), 'dist', 'loader.mjs');
    return [...process.execArgv, '--import', pathToFileURL(tsxLoader).href];
  } catch {
    return [...process.execArgv, '--import', 'tsx'];
  }
}

const execArgv = getExecArgv();

describe('Horizontal Worker Replica & Throughput Benchmark Harness', () => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const testTenantId = crypto.randomUUID();
  const testQueueName = `bench_queue_${crypto.randomUUID().slice(0, 8)}`;

  let prisma: PrismaClient;
  const activeChildren: ChildProcess[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    await prisma.tenant.create({
      data: { id: testTenantId, name: `Test Tenant ${testTenantId}` },
    });
  });

  afterAll(async () => {
    // Teardown: kill any lingering worker child processes
    for (const child of activeChildren) {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }

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

  describe('Worker Replica Process Lifecycle (worker-runner.ts)', () => {
    it('spawns child replica, performs IPC ready handshake, and shuts down cleanly', async () => {
      const child = fork(workerRunnerPath, [], {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          REDIS_URL: redisUrl,
          TENANT_ID: testTenantId,
          CONCURRENCY: '2',
          QUEUE_NAME: testQueueName,
          WORKER_ID: `test-worker-${process.pid}`,
        },
        execArgv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      activeChildren.push(child);

      // Wait for IPC ready message
      const readyMsg = await new Promise<{ ready: boolean; pid: number }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for worker replica ready IPC message'));
        }, 10000);

        child.on('message', (msg: any) => {
          if (msg && msg.ready === true) {
            clearTimeout(timeout);
            resolve(msg);
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        child.on('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Worker replica exited prematurely with code ${code}`));
        });
      });

      expect(readyMsg.ready).toBe(true);
      expect(readyMsg.pid).toBe(child.pid);

      // Send shutdown signal
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
        child.send('shutdown');
      });

      expect(exitCode).toBe(0);
    });
  });

  describe('Throughput Benchmark Harness Correctness (bench-throughput.ts)', () => {
    it('executes workflows across 2 worker replicas to 100% completion with 0 lost runs and 0 duplicate steps', async () => {
      const tiers = await runThroughputBenchmark({
        tiers: [2],
        concurrencyPerWorker: 2,
        warmupRuns: 1,
        measuredRepetitions: 1,
        runsPerRepetition: 4,
        tenantId: testTenantId,
        databaseUrl,
        redisUrl,
        queueName: testQueueName,
        timeoutMs: 30000,
        workflowName: 'process-order',
      });

      // Validate returned structure
      expect(tiers).toBeDefined();
      expect(tiers.length).toBe(1);

      const tier = tiers[0]!;
      expect(tier.workerReplicas).toBe(2);
      expect(tier.concurrencyPerWorker).toBe(2);
      expect(tier.totalWorkers).toBe(2);
      expect(tier.warmupRuns).toBe(1);
      expect(tier.measuredRepetitions).toBe(1);
      expect(tier.runsPerRepetition).toBe(4);
      expect(tier.totalWorkflows).toBe(4);

      // Valid metrics without brittle thresholds
      expect(tier.medianDurationMs).toBeGreaterThan(0);
      expect(tier.medianThroughputPerSec).toBeGreaterThan(0);
      expect(tier.latencyMs.min).toBeGreaterThan(0);
      expect(tier.latencyMs.p50).toBeGreaterThan(0);
      expect(tier.latencyMs.p95).toBeGreaterThan(0);
      expect(tier.latencyMs.p99).toBeGreaterThan(0);
      expect(tier.latencyMs.max).toBeGreaterThanOrEqual(tier.latencyMs.min);
      expect(tier.latencyMs.avg).toBeGreaterThan(0);
      expect(tier.rawLatenciesMs.length).toBe(4);

      // Invariant 1: 0 lost runs (all submitted runs reached COMPLETED)
      const runs = await prisma.workflowRun.findMany({
        where: { tenantId: testTenantId },
      });
      // 1 warmup + 4 measured = 5 total runs
      expect(runs.length).toBe(5);
      for (const r of runs) {
        expect(r.status).toBe('COMPLETED');
      }

      // Invariant 2: 0 duplicate step executions
      const expectedSteps = [
        'validate-cart',
        'reserve-inventory',
        'process-payment',
        'send-confirmation-email',
        'update-crm-records',
        'dispatch-warehouse-fulfillment',
        'generate-invoice',
      ];

      for (const r of runs) {
        const steps = await prisma.stepExecution.findMany({
          where: { workflowRunId: r.id },
        });

        expect(steps.length).toBe(expectedSteps.length);
        const stepKeys = steps.map((s) => s.stepKey).sort();
        expect(stepKeys).toEqual([...expectedSteps].sort());

        // Each step must have completed without duplicated attempts
        for (const s of steps) {
          expect(s.status).toBe('COMPLETED');
          expect(s.attemptCount).toBe(1);
        }
      }
    });

    it('throws when a workflow run transitions to FAILED status', async () => {
      const failedRun = await prisma.workflowRun.create({
        data: {
          tenantId: testTenantId,
          workflowName: 'test-wf-fail',
          workflowVersion: '1.0.0',
          status: 'FAILED',
          input: {},
        },
      });

      await expect(
        awaitRunsCompletedWithLatencies(prisma, [failedRun.id], new Map(), 5000)
      ).rejects.toThrow(/terminated with unexpected status: FAILED/);
    });

    it('throws when a workflow run transitions to CANCELLED status', async () => {
      const cancelledRun = await prisma.workflowRun.create({
        data: {
          tenantId: testTenantId,
          workflowName: 'test-wf-cancel',
          workflowVersion: '1.0.0',
          status: 'CANCELLED',
          input: {},
        },
      });

      await expect(
        awaitRunsCompletedWithLatencies(prisma, [cancelledRun.id], new Map(), 5000)
      ).rejects.toThrow(/terminated with unexpected status: CANCELLED/);
    });
  });

  describe('Worker process termination with signalCode', () => {
    it('resolves immediately when child process already has signalCode', async () => {
      const fakeChild = {
        exitCode: null,
        signalCode: 'SIGTERM',
      } as any;

      await expect(stopWorkerProcesses([fakeChild])).resolves.toBeUndefined();
    });
  });
});
