import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  createPrismaClient,
  createWorkflowRun,
  type PrismaClient,
} from '@durable/database';
import {
  createWorkflowQueue,
  type WorkflowRunJobData,
} from '@durable/worker';
import { WorkflowReconciler } from '@durable/reconciler';
import { collectSystemMetadata, calculatePercentiles } from './sysinfo.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from './reporter.js';
import { stopProcess } from './bench-chaos.js';
import type {
  RetryTierResult,
  RetryBenchmarkResult,
  BenchmarkReport,
} from './types.js';

// Auto-load .env.test if environment variables are not already set
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  const envCandidates = [
    path.resolve(process.cwd(), '.env.test'),
    path.resolve(process.cwd(), '../.env.test'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.test'),
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            const v = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[k]) {
              process.env[k] = v;
            }
          }
        }
      } catch {}
      break;
    }
  }
}

export interface RetryBenchOptions {
  failureRates?: number[];
  workflowsPerTier?: number;
  workerReplicas?: number;
  concurrencyPerWorker?: number;
  tenantId?: string;
  databaseUrl?: string;
  dbUrl?: string;
  redisUrl?: string;
  queueName?: string;
  timeoutMs?: number;
  workerRunnerPath?: string;
}

function resolveExecArgv(runnerPath: string): string[] {
  let execArgv = process.execArgv;
  const hasTsx = execArgv.some((arg) => arg.includes('tsx'));
  if (runnerPath.endsWith('.ts') && !hasTsx) {
    try {
      const req = createRequire(import.meta.url);
      const tsxPackage = req.resolve('tsx/package.json');
      const tsxLoader = path.resolve(path.dirname(tsxPackage), 'dist', 'loader.mjs');
      execArgv = [...execArgv, '--import', pathToFileURL(tsxLoader).href];
    } catch {
      execArgv = [...execArgv, '--import', 'tsx'];
    }
  }
  return execArgv;
}

function waitForReady(child: ChildProcess, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMsg);
      child.off('exit', onExit);
      reject(new Error(`Timed out waiting for worker ready message (pid ${child.pid})`));
    }, timeoutMs);

    const onMsg = (msg: any) => {
      if (msg && msg.ready === true) {
        clearTimeout(timer);
        child.off('message', onMsg);
        child.off('exit', onExit);
        resolve();
      }
    };

    const onExit = (code: number | null) => {
      clearTimeout(timer);
      child.off('message', onMsg);
      reject(new Error(`Worker exited prematurely with code ${code}`));
    };

    child.on('message', onMsg);
    child.once('exit', onExit);
  });
}

function generateRunId(targetFail: boolean, failureRatePercent: number): string {
  while (true) {
    const id = crypto.randomUUID();
    const hash = id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const fails = hash % 100 < failureRatePercent;
    if (fails === targetFail) return id;
  }
}

export async function runRetryBenchmark(
  options?: RetryBenchOptions
): Promise<RetryBenchmarkResult> {
  const failureRates = options?.failureRates ?? [0, 5, 10, 20];
  const workflowsPerTier = options?.workflowsPerTier ?? 20;
  const workerReplicas = options?.workerReplicas ?? 2;
  const concurrency = options?.concurrencyPerWorker ?? 5;
  const timeoutMs = options?.timeoutMs ?? 30000;

  const databaseUrl =
    options?.databaseUrl ||
    options?.dbUrl ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl =
    options?.redisUrl ||
    process.env.REDIS_URL ||
    'redis://localhost:6380';
  const tenantId = options?.tenantId || crypto.randomUUID();
  const queueName =
    options?.queueName || `bench_retry_${crypto.randomUUID().slice(0, 8)}`;

  const defaultDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultTsPath = path.resolve(defaultDir, 'worker-runner.ts');
  const defaultJsPath = path.resolve(defaultDir, 'worker-runner.js');
  const defaultRunnerPath = fs.existsSync(defaultTsPath) ? defaultTsPath : defaultJsPath;
  const runnerPath = options?.workerRunnerPath || defaultRunnerPath;
  const execArgv = resolveExecArgv(runnerPath);

  const db: PrismaClient = createPrismaClient(databaseUrl);
  await db.$connect();

  await db.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: `Retry Benchmark Tenant ${tenantId}` },
  });

  const queue: Queue<WorkflowRunJobData> = createWorkflowQueue(redisUrl, queueName);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const workers: ChildProcess[] = [];
  let reconciler: WorkflowReconciler | null = null;
  const tiers: RetryTierResult[] = [];

  try {
    // 1. Spawn worker replica processes
    for (let i = 0; i < workerReplicas; i++) {
      const child = fork(runnerPath, [], {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          REDIS_URL: redisUrl,
          TENANT_ID: tenantId,
          CONCURRENCY: concurrency.toString(),
          QUEUE_NAME: queueName,
          WORKER_ID: `retry-worker-${i}-${crypto.randomUUID().slice(0, 6)}`,
        },
        execArgv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      workers.push(child);
      await waitForReady(child);
    }

    // 2. Start reconciler to handle any retries smoothly
    reconciler = new WorkflowReconciler({
      db,
      connectionOrUrl: redisUrl,
      queueName,
      tenantId,
      batchSize: 20,
      pollIntervalMs: 200,
    });
    reconciler.start();

    // 3. Execute tiers across failure rates
    for (const failureRatePercent of failureRates) {
      const failCount =
        failureRatePercent === 0
          ? 0
          : Math.max(1, Math.round(workflowsPerTier * (failureRatePercent / 100)));

      const runSpecs: Array<{ runId: string; failureRatePercent: number }> = [];
      for (let i = 0; i < workflowsPerTier; i++) {
        const shouldFail = i < failCount;
        const runId = generateRunId(shouldFail, failureRatePercent);
        runSpecs.push({ runId, failureRatePercent });
      }

      // Create workflow runs in PostgreSQL
      const runs = await Promise.all(
        runSpecs.map((spec) =>
          createWorkflowRun(db, {
            tenantId,
            workflowName: 'retry-workflow',
            workflowVersion: '1.0.0',
            input: {
              runId: spec.runId,
              failureRatePercent: spec.failureRatePercent,
            },
          })
        )
      );

      const runIds = runs.map((r) => r.id);
      const tierStart = performance.now();

      // Enqueue all runs in BullMQ
      await queue.addBulk(
        runs.map((r) => ({
          name: 'execute',
          data: {
            tenantId,
            runId: r.id,
            workflowName: 'retry-workflow',
            workflowVersion: '1.0.0',
          },
          opts: { jobId: `run_${r.id}` },
        }))
      );

      // Poll until all runs are COMPLETED
      const pollStart = performance.now();
      let allCompleted = false;

      while (performance.now() - pollStart < timeoutMs) {
        const completedCount = await db.workflowRun.count({
          where: {
            id: { in: runIds },
            status: 'COMPLETED',
          },
        });

        if (completedCount === workflowsPerTier) {
          allCompleted = true;
          break;
        }

        const failedRun = await db.workflowRun.findFirst({
          where: {
            id: { in: runIds },
            status: 'FAILED',
          },
          select: { id: true, error: true },
        });

        if (failedRun) {
          throw new Error(
            `Workflow run ${failedRun.id} failed in tier ${failureRatePercent}%: ${failedRun.error ?? 'Unknown error'}`
          );
        }

        await reconciler.reconcileOnce().catch(() => {});
        await new Promise((r) => setTimeout(r, 40));
      }

      if (!allCompleted) {
        throw new Error(
          `Timed out waiting for tier ${failureRatePercent}% (${workflowsPerTier} runs) to complete within ${timeoutMs}ms`
        );
      }

      const durationMs = Number((performance.now() - tierStart).toFixed(2));
      const throughputPerSec = Number(((workflowsPerTier / (durationMs / 1000))).toFixed(2));

      // Compute latency percentiles
      const completedRuns = await db.workflowRun.findMany({
        where: { id: { in: runIds } },
        select: { createdAt: true, completedAt: true },
      });

      const latenciesMs = completedRuns.map((r) =>
        r.completedAt ? Math.max(1, r.completedAt.getTime() - r.createdAt.getTime()) : 1
      );
      const latencyMs = calculatePercentiles(latenciesMs);

      // Count step attempts created across all runs in this tier
      const totalStepAttempts = await db.stepAttempt.count({
        where: {
          tenantId,
          stepExecution: {
            workflowRunId: { in: runIds },
          },
        },
      });

      const meanAttemptsPerWorkflow = Number((totalStepAttempts / workflowsPerTier).toFixed(2));

      tiers.push({
        failureRatePercent,
        totalWorkflows: workflowsPerTier,
        durationMs,
        throughputPerSec,
        latencyMs,
        totalStepAttempts,
        meanAttemptsPerWorkflow,
      });

      // Cleanup Redis retry keys
      for (const spec of runSpecs) {
        await redis.del(`retry:attempt:${spec.runId}`).catch(() => {});
      }
    }

    return {
      scenario: 'RELIABILITY_RETRY_OVERHEAD',
      tiers,
      status: 'PASSED',
    };
  } finally {
    for (const child of workers) {
      await stopProcess(child);
    }
    if (reconciler) {
      await reconciler.stop().catch(() => {});
    }
    await queue.close().catch(() => {});
    await redis.quit().catch(() => {});
    if (!options?.tenantId) {
      await db.stepAttempt.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.stepExecution.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.executionEvent.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.workflowRun.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    }
    await db.$disconnect().catch(() => {});
  }
}

// CLI entrypoint execution
const isMain =
  process.argv[1]?.includes('bench-retry') && !process.env.VITEST;

if (isMain) {
  (async () => {
    try {
      console.log('=== Transient Failure Retry Overhead Benchmark ===');
      const sysinfo = await collectSystemMetadata();
      console.log(`CPU: ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
      console.log(`Node: ${sysinfo.nodeVersion} | OS: ${sysinfo.platform} ${sysinfo.osRelease}`);
      console.log('Sweeping failure rates [0, 5, 10, 20]% and measuring throughput degradation...');

      const result = await runRetryBenchmark();

      const report: BenchmarkReport = {
        id: `retry-${Date.now()}`,
        title: 'Transient Failure Retry Overhead Benchmark',
        timestamp: new Date().toISOString(),
        system: sysinfo,
        retryOverhead: result,
      };

      const { jsonPath, markdownPath } = await saveBenchmarkArtifact(report);
      console.log('\n=== Benchmark Summary ===\n');
      console.log(formatMarkdownReport(report));
      console.log(`\nArtifacts persisted:`);
      console.log(`  JSON: ${jsonPath}`);
      console.log(`  Markdown: ${markdownPath}`);
    } catch (err) {
      console.error('Retry overhead benchmark execution failed:', err);
      process.exit(1);
    }
  })();
}
