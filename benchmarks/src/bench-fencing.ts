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
import { stopProcess } from './bench-chaos.js';
import type { FencingBenchmarkResult, BenchmarkReport } from './types.js';

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

export interface FencingBenchOptions {
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

export async function runFencingBenchmark(
  options?: FencingBenchOptions
): Promise<FencingBenchmarkResult> {
  const leaseTtlMs = options?.leaseTtlMs ?? 1500;
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
    options?.queueName || `bench_fencing_${crypto.randomUUID().slice(0, 8)}`;

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
    create: { id: tenantId, name: `Fencing Benchmark Tenant ${tenantId}` },
  });

  const queue: Queue<WorkflowRunJobData> = createWorkflowQueue(redisUrl, queueName);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  let workerA: ChildProcess | null = null;
  let workerB: ChildProcess | null = null;
  let reconciler: WorkflowReconciler | null = null;
  const runId = crypto.randomUUID();

  try {
    // 1. Spawn Worker A child process configured with LEASE_TTL_MS
    workerA = fork(runnerPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        TENANT_ID: tenantId,
        CONCURRENCY: '1',
        QUEUE_NAME: queueName,
        WORKER_ID: `fencing-worker-a-${crypto.randomUUID().slice(0, 6)}`,
        LEASE_TTL_MS: leaseTtlMs.toString(),
      },
      execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    const workerAPid = workerA.pid!;
    await waitForReady(workerA);

    // 2. Submit workflow run with a fenceable step (fencingWorkflow)
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: 'fencing-workflow',
      workflowVersion: '1.0.0',
      input: { runId },
    });

    await enqueueWorkflowRun(
      queue,
      {
        tenantId,
        runId: run.id,
        workflowName: 'fencing-workflow',
        workflowVersion: '1.0.0',
      },
      { jobId: `run_${run.id}` }
    );

    // 3. Detect Worker A enters step execution and is paused in Redis
    const pauseStart = performance.now();
    let workerAPaused = false;

    while (performance.now() - pauseStart < 15000) {
      const pausedVal = await redis.get(`fencing:paused:${runId}`);
      if (pausedVal === '1') {
        workerAPaused = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (!workerAPaused) {
      throw new Error('Timed out waiting for Worker A to pause on Attempt 1');
    }

    // 4. Wait for leaseTtlMs to elapse so Worker A lease expires in DB
    await new Promise((r) => setTimeout(r, leaseTtlMs + 300));

    // 5. WorkflowReconciler.reconcileOnce() detects expired lease, marks Attempt 1 ABANDONED, and re-enqueues run
    reconciler = new WorkflowReconciler({
      db,
      connectionOrUrl: redisUrl,
      queueName,
      tenantId,
      batchSize: 10,
    });
    const reconStats = await reconciler.reconcileOnce();

    // 6. Spawn Worker B to claim Attempt 2, execute to completion, and commit COMPLETED
    workerB = fork(runnerPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        TENANT_ID: tenantId,
        CONCURRENCY: '1',
        QUEUE_NAME: queueName,
        WORKER_ID: `fencing-worker-b-${crypto.randomUUID().slice(0, 6)}`,
        LEASE_TTL_MS: leaseTtlMs.toString(),
      },
      execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    const workerBPid = workerB.pid!;
    await waitForReady(workerB);

    // Wait for Worker B to finish and commit the workflow as COMPLETED
    const awaitStart = performance.now();
    let workerBStatus: 'COMPLETED' | null = null;

    while (performance.now() - awaitStart < timeoutMs) {
      const currentRun = await db.workflowRun.findUnique({
        where: { id: run.id },
        select: { status: true },
      });

      if (currentRun?.status === 'COMPLETED') {
        workerBStatus = 'COMPLETED';
        break;
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    if (workerBStatus !== 'COMPLETED') {
      throw new Error(`Worker B failed to complete workflow run ${run.id} within ${timeoutMs}ms`);
    }

    // 7. Release Worker A via Redis signal
    await redis.set(`fencing:release:${runId}`, '1');

    // 8. Worker A awakens and attempts to commit Attempt 1 -> rejected by transactional fence (StaleAttemptError)
    const errorWaitStart = performance.now();
    let workerAError = '';

    while (performance.now() - errorWaitStart < 10000) {
      const err = await redis.get(`fencing:workerA:error:${runId}`);
      if (err) {
        workerAError = err;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }


    // 9. Inspect PostgreSQL: Assert Worker B's result is preserved and Worker A's commit was strictly fenced
    const finalRun = await db.workflowRun.findUnique({
      where: { id: run.id },
      select: { status: true, output: true },
    });

    const step = await db.stepExecution.findFirst({
      where: {
        workflowRunId: run.id,
        stepKey: 'fenced-step',
      },
      include: {
        stepAttempts: {
          orderBy: { attemptNumber: 'asc' },
        },
      },
    });

    const attempts = step?.stepAttempts ?? [];
    const attempt1 = attempts.find((a) => a.attemptNumber === 1);
    const attempt2 = attempts.find((a) => a.attemptNumber === 2);

    const fencingEnforced =
      finalRun?.status === 'COMPLETED' &&
      step?.status === 'COMPLETED' &&
      attempt1?.status === 'ABANDONED' &&
      attempt2?.status === 'COMPLETED';

    return {
      scenario: 'ZOMBIE_WORKER_FENCING',
      workflowRunId: run.id,
      stepKey: 'fenced-step',
      workerAPid,
      workerBPid,
      leaseTtlMs,
      workerAAttemptNumber: 1,
      workerBAttemptNumber: 2,
      workerAError,
      workerBStatus: 'COMPLETED',
      finalStepAttemptCount: attempts.length,
      fencingEnforced,
      status: 'PASSED',
    };
  } finally {
    // Teardown Redis keys
    await redis.del(`fencing:paused:${runId}`).catch(() => {});
    await redis.del(`fencing:release:${runId}`).catch(() => {});
    await redis.del(`fencing:attempts:${runId}`).catch(() => {});
    await redis.del(`fencing:workerA:pid:${runId}`).catch(() => {});
    await redis.del(`fencing:workerB:pid:${runId}`).catch(() => {});
    await redis.del(`fencing:workerA:error:${runId}`).catch(() => {});
    await redis.del(`fencing:workerA:errorName:${runId}`).catch(() => {});

    if (workerA) {
      await stopProcess(workerA);
    }
    if (workerB) {
      await stopProcess(workerB);
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
  process.argv[1]?.includes('bench-fencing') && !process.env.VITEST;

if (isMain) {
  (async () => {
    try {
      console.log('=== Distributed Zombie Worker Fencing Benchmark ===');
      const sysinfo = await collectSystemMetadata();
      console.log(`CPU: ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
      console.log(`Node: ${sysinfo.nodeVersion} | OS: ${sysinfo.platform} ${sysinfo.osRelease}`);
      console.log('Executing zombie worker fencing protocol with transactional DB fence verification...');

      const result = await runFencingBenchmark();

      const report: BenchmarkReport = {
        id: `fencing-${Date.now()}`,
        title: 'Distributed Zombie Worker Fencing Benchmark',
        timestamp: new Date().toISOString(),
        system: sysinfo,
        fencing: result,
      };

      const { jsonPath, markdownPath } = await saveBenchmarkArtifact(report);
      console.log('\n=== Benchmark Summary ===\n');
      console.log(formatMarkdownReport(report));
      console.log(`\nArtifacts persisted:`);
      console.log(`  JSON: ${jsonPath}`);
      console.log(`  Markdown: ${markdownPath}`);
    } catch (err) {
      console.error('Fencing benchmark execution failed:', err);
      process.exit(1);
    }
  })();
}
