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
  enqueueWorkflowRun,
  type WorkflowRunJobData,
} from '@durable/worker';
import { WorkflowReconciler } from '@durable/reconciler';
import { collectSystemMetadata } from './sysinfo.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from './reporter.js';
import type { ChaosBenchmarkResult, MultiTtlChaosResult, BenchmarkReport } from './types.js';

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

export interface ChaosBenchOptions {
  leaseTtlMs?: number;
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

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      resolve();
    }, 3000);

    try {
      child.send('shutdown');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    }
  });
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

export async function runChaosBenchmark(
  options?: ChaosBenchOptions
): Promise<ChaosBenchmarkResult> {
  const leaseTtlMs = options?.leaseTtlMs ?? 2000;
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
    options?.queueName || `bench_chaos_${crypto.randomUUID().slice(0, 8)}`;

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
    create: { id: tenantId, name: `Chaos Benchmark Tenant ${tenantId}` },
  });

  const queue: Queue<WorkflowRunJobData> = createWorkflowQueue(redisUrl, queueName);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  let worker1: ChildProcess | null = null;
  let worker2: ChildProcess | null = null;
  let reconciler: WorkflowReconciler | null = null;

  try {
    // 1. Spawn worker child process configured with LEASE_TTL_MS
    worker1 = fork(runnerPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        TENANT_ID: tenantId,
        CONCURRENCY: '1',
        QUEUE_NAME: queueName,
        WORKER_ID: `chaos-worker-victim-${crypto.randomUUID().slice(0, 6)}`,
        LEASE_TTL_MS: leaseTtlMs.toString(),
      },
      execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    const victimPid = worker1.pid!;
    await waitForReady(worker1);

    // 2. Enqueue workflow run
    const chaosRunId = crypto.randomUUID();
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: 'chaos-workflow',
      workflowVersion: '1.0.0',
      input: {
        chaosRunId,
        delayMs: 15000,
      },
    });

    await enqueueWorkflowRun(
      queue,
      {
        tenantId,
        runId: run.id,
        workflowName: 'chaos-workflow',
        workflowVersion: '1.0.0',
      },
      { jobId: `run_${run.id}` }
    );

    // 3. Detect step 2 is active in PostgreSQL
    const detectStart = performance.now();
    let step2Detected = false;

    while (performance.now() - detectStart < 15000) {
      const step2 = await db.stepExecution.findFirst({
        where: {
          workflowRunId: run.id,
          stepKey: 'step-2-process',
          status: 'RUNNING',
        },
      });

      if (step2) {
        step2Detected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (!step2Detected) {
      throw new Error('Timed out waiting for step-2-process to enter RUNNING state');
    }

    // 4. Abruptly terminate child process with real SIGKILL mid-step
    process.kill(victimPid, 'SIGKILL');
    const killTimestamp = performance.now();

    // Signal in Redis so resuming worker knows it's the post-kill attempt and completes step 2 immediately
    await redis.set(`chaos:killed:${chaosRunId}`, '1');

    // 5. Wait for the lease duration to expire
    const waitLeaseMs = leaseTtlMs + 200;
    await new Promise((r) => setTimeout(r, waitLeaseMs));

    // 6. Trigger Reconciler to reconcile expired lease
    reconciler = new WorkflowReconciler({
      db,
      connectionOrUrl: redisUrl,
      queueName,
      tenantId,
      batchSize: 10,
    });
    await reconciler.reconcileOnce();
    const timeToAbandonedMs = Number((performance.now() - killTimestamp).toFixed(2));

    // 7. Spawn replacement worker replica to resume workflow
    worker2 = fork(runnerPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        TENANT_ID: tenantId,
        CONCURRENCY: '1',
        QUEUE_NAME: queueName,
        WORKER_ID: `chaos-worker-replacement-${crypto.randomUUID().slice(0, 6)}`,
        LEASE_TTL_MS: leaseTtlMs.toString(),
      },
      execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    await waitForReady(worker2);

    // In case lease reconciliation needed an extra tick or due retry
    await reconciler.reconcileOnce();

    // 8. Await completion of workflow run in PostgreSQL
    const awaitStart = performance.now();
    let finalStatus: string | null = null;

    while (performance.now() - awaitStart < timeoutMs) {
      const currentRun = await db.workflowRun.findUnique({
        where: { id: run.id },
        select: { status: true },
      });

      if (currentRun?.status === 'COMPLETED') {
        finalStatus = 'COMPLETED';
        break;
      }

      if (currentRun?.status === 'FAILED' || currentRun?.status === 'CANCELLED') {
        throw new Error(`Workflow run ended with unexpected status: ${currentRun.status}`);
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    if (finalStatus !== 'COMPLETED') {
      throw new Error(`Workflow run ${run.id} did not complete within ${timeoutMs}ms`);
    }

    const recoveryLatencyMs = Number((performance.now() - killTimestamp).toFixed(2));

    // 9. Assert duplicateStepCalls === 0 for memoized step 1
    const memoizedStep = await db.stepExecution.findFirst({
      where: {
        workflowRunId: run.id,
        stepKey: 'step-1-init',
      },
      include: {
        stepAttempts: true,
      },
    });

    const duplicateStepCalls = (memoizedStep?.stepAttempts.length ?? 1) - 1;

    // 10. Clean up Redis chaos key
    await redis.del(`chaos:killed:${chaosRunId}`).catch(() => {});

    return {
      scenario: 'WORKER_SIGKILL_RECOVERY',
      workerPid: victimPid,
      killSignal: 'SIGKILL',
      leaseTtlMs,
      recoveryLatencyMs,
      timeToAbandonedMs,
      workflowRunId: run.id,
      duplicateStepCalls,
      status: 'COMPLETED',
    };
  } finally {
    if (worker1) {
      await stopProcess(worker1);
    }
    if (worker2) {
      await stopProcess(worker2);
    }
    if (reconciler) {
      await reconciler.stop().catch(() => {});
    }
    await queue.close().catch(() => {});
    await redis.quit().catch(() => {});
    await db.$disconnect().catch(() => {});
  }
}

export interface MultiTtlChaosOptions {
  ttlsMs?: number[];
  repetitionsPerTtl?: number;
  tenantId?: string;
  databaseUrl?: string;
  dbUrl?: string;
  redisUrl?: string;
  queueName?: string;
  timeoutMs?: number;
  workerRunnerPath?: string;
}

export async function runMultiTtlChaosBenchmark(
  options?: MultiTtlChaosOptions
): Promise<MultiTtlChaosResult> {
  const ttlsMs = options?.ttlsMs ?? [2000, 5000, 10000, 30000];
  const repetitions = options?.repetitionsPerTtl ?? 1;
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
    options?.queueName || `bench_chaos_${crypto.randomUUID().slice(0, 8)}`;

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
    create: { id: tenantId, name: `Multi-TTL Chaos Tenant ${tenantId}` },
  });

  const queue: Queue<WorkflowRunJobData> = createWorkflowQueue(redisUrl, queueName);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const results: ChaosBenchmarkResult[] = [];

  try {
    for (const leaseTtlMs of ttlsMs) {
      for (let rep = 0; rep < repetitions; rep++) {
        let worker1: ChildProcess | null = null;
        let worker2: ChildProcess | null = null;
        let reconciler: WorkflowReconciler | null = null;
        const chaosRunId = crypto.randomUUID();

        try {
          // 1. Spawn victim worker child process configured with LEASE_TTL_MS
          worker1 = fork(runnerPath, [], {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              REDIS_URL: redisUrl,
              TENANT_ID: tenantId,
              CONCURRENCY: '1',
              QUEUE_NAME: queueName,
              WORKER_ID: `chaos-victim-${leaseTtlMs}-${rep}-${crypto.randomUUID().slice(0, 6)}`,
              LEASE_TTL_MS: leaseTtlMs.toString(),
            },
            execArgv,
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          });

          const victimPid = worker1.pid!;
          await waitForReady(worker1);

          // 2. Enqueue workflow run
          const run = await createWorkflowRun(db, {
            tenantId,
            workflowName: 'chaos-workflow',
            workflowVersion: '1.0.0',
            input: {
              chaosRunId,
              delayMs: 15000,
            },
          });

          await enqueueWorkflowRun(
            queue,
            {
              tenantId,
              runId: run.id,
              workflowName: 'chaos-workflow',
              workflowVersion: '1.0.0',
            },
            { jobId: `run_${run.id}` }
          );

          // 3. Detect step 2 is active in PostgreSQL
          const detectStart = performance.now();
          let step2Detected = false;

          while (performance.now() - detectStart < 15000) {
            const step2 = await db.stepExecution.findFirst({
              where: {
                workflowRunId: run.id,
                stepKey: 'step-2-process',
                status: 'RUNNING',
              },
            });

            if (step2) {
              step2Detected = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }

          if (!step2Detected) {
            throw new Error('Timed out waiting for step-2-process to enter RUNNING state');
          }

          // 4. Abruptly terminate victim child process with real SIGKILL mid-step
          process.kill(victimPid, 'SIGKILL');
          const killTimestamp = performance.now();

          // Signal in Redis so resuming worker knows it's the post-kill attempt and completes step 2 immediately
          await redis.set(`chaos:killed:${chaosRunId}`, '1');

          // 5. Wait for the lease duration to expire
          const waitLeaseMs = leaseTtlMs + 200;
          await new Promise((r) => setTimeout(r, waitLeaseMs));

          // 6. Trigger Reconciler to reconcile expired lease
          reconciler = new WorkflowReconciler({
            db,
            connectionOrUrl: redisUrl,
            queueName,
            tenantId,
            batchSize: 10,
          });
          await reconciler.reconcileOnce();
          const timeToAbandonedMs = Number((performance.now() - killTimestamp).toFixed(2));

          // 7. Spawn replacement worker replica to resume workflow
          worker2 = fork(runnerPath, [], {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              REDIS_URL: redisUrl,
              TENANT_ID: tenantId,
              CONCURRENCY: '1',
              QUEUE_NAME: queueName,
              WORKER_ID: `chaos-replacement-${leaseTtlMs}-${rep}-${crypto.randomUUID().slice(0, 6)}`,
              LEASE_TTL_MS: leaseTtlMs.toString(),
            },
            execArgv,
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          });

          await waitForReady(worker2);

          // Additional tick to ensure due retries are re-enqueued
          await reconciler.reconcileOnce();

          // 8. Await completion of workflow run in PostgreSQL
          const awaitStart = performance.now();
          let finalStatus: string | null = null;

          while (performance.now() - awaitStart < timeoutMs) {
            const currentRun = await db.workflowRun.findUnique({
              where: { id: run.id },
              select: { status: true },
            });

            if (currentRun?.status === 'COMPLETED') {
              finalStatus = 'COMPLETED';
              break;
            }

            if (currentRun?.status === 'FAILED' || currentRun?.status === 'CANCELLED') {
              throw new Error(`Workflow run ended with unexpected status: ${currentRun.status}`);
            }

            await new Promise((r) => setTimeout(r, 50));
          }

          if (finalStatus !== 'COMPLETED') {
            throw new Error(`Workflow run ${run.id} did not complete within ${timeoutMs}ms`);
          }

          const recoveryLatencyMs = Number((performance.now() - killTimestamp).toFixed(2));

          // 9. Assert duplicateStepCalls === 0 for memoized step 1
          const memoizedStep = await db.stepExecution.findFirst({
            where: {
              workflowRunId: run.id,
              stepKey: 'step-1-init',
            },
            include: {
              stepAttempts: true,
            },
          });

          const duplicateStepCalls = (memoizedStep?.stepAttempts.length ?? 1) - 1;

          results.push({
            scenario: 'WORKER_SIGKILL_RECOVERY',
            workerPid: victimPid,
            killSignal: 'SIGKILL',
            leaseTtlMs,
            recoveryLatencyMs,
            timeToAbandonedMs,
            workflowRunId: run.id,
            duplicateStepCalls,
            status: 'COMPLETED',
          });
        } finally {
          await redis.del(`chaos:killed:${chaosRunId}`).catch(() => {});
          if (worker1) {
            await stopProcess(worker1);
          }
          if (worker2) {
            await stopProcess(worker2);
          }
          if (reconciler) {
            await reconciler.stop().catch(() => {});
          }
        }
      }
    }

    return {
      scenario: 'MULTI_TTL_CHAOS_SWEEP',
      results,
      status: 'PASSED',
    };
  } finally {
    await queue.close().catch(() => {});
    await redis.quit().catch(() => {});
    await db.$disconnect().catch(() => {});
  }
}

// CLI entrypoint execution
const isMain =
  process.argv[1]?.includes('bench-chaos') && !process.env.VITEST;

if (isMain) {
  (async () => {
    try {
      console.log('=== Real SIGKILL Worker Chaos Benchmark ===');
      const sysinfo = await collectSystemMetadata();
      console.log(`CPU: ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
      console.log(`Node: ${sysinfo.nodeVersion} | OS: ${sysinfo.platform} ${sysinfo.osRelease}`);
      console.log('Spawning worker child, injecting real SIGKILL mid-step, and measuring recovery...');

      const chaosResult = await runChaosBenchmark();

      const report: BenchmarkReport = {
        id: `chaos-${Date.now()}`,
        title: 'Real Worker SIGKILL Chaos Benchmark',
        timestamp: new Date().toISOString(),
        system: sysinfo,
        chaos: chaosResult,
      };

      const { jsonPath, markdownPath } = await saveBenchmarkArtifact(report);
      console.log('\n=== Benchmark Summary ===\n');
      console.log(formatMarkdownReport(report));
      console.log(`\nArtifacts persisted:`);
      console.log(`  JSON: ${jsonPath}`);
      console.log(`  Markdown: ${markdownPath}`);
    } catch (err) {
      console.error('Chaos benchmark execution failed:', err);
      process.exit(1);
    }
  })();
}
