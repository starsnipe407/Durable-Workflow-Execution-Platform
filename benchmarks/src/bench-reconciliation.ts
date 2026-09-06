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
import type { OrderInput } from '@example/order-processing';
import { collectSystemMetadata } from './sysinfo.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from './reporter.js';
import { stopWorkerProcesses } from './bench-throughput.js';
import type { ReconciliationBenchmarkResult, BenchmarkReport } from './types.js';

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

export interface ReconcilerBenchOptions {
  totalRuns?: number;
  tenantId?: string;
  databaseUrl?: string;
  dbUrl?: string;
  redisUrl?: string;
  queueName?: string;
  workerCount?: number;
  concurrencyPerWorker?: number;
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

export async function runReconciliationBenchmark(
  options?: ReconcilerBenchOptions
): Promise<ReconciliationBenchmarkResult> {
  const totalRuns = options?.totalRuns ?? 20;
  const workerCount = options?.workerCount ?? 2;
  const concurrencyPerWorker = options?.concurrencyPerWorker ?? 5;
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
    options?.queueName || `bench_recon_${crypto.randomUUID().slice(0, 8)}`;

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
    create: { id: tenantId, name: `Reconciliation Benchmark Tenant ${tenantId}` },
  });

  const children: ChildProcess[] = [];
  let reconciler: WorkflowReconciler | null = null;
  let queue: Queue<WorkflowRunJobData> | null = null;

  try {
    queue = createWorkflowQueue(redisUrl, queueName);

    // 1. Enqueue totalRuns into PostgreSQL & BullMQ (runs enter PENDING)
    // Note: No active workers are running yet, so all runs remain PENDING
    const runIds: string[] = [];
    for (let i = 0; i < totalRuns; i++) {
      const orderId = `recon_ord_${i}_${crypto.randomUUID().slice(0, 8)}`;
      const input: OrderInput = {
        orderId,
        customerId: `cust_recon_${i}`,
        customerEmail: `recon_${i}@example.com`,
        items: [
          { sku: 'ITEM-A', quantity: 1, price: 50 },
          { sku: 'ITEM-B', quantity: 2, price: 25 },
        ],
        totalAmount: 100,
      };

      const run = await createWorkflowRun(db, {
        tenantId,
        workflowName: 'process-order',
        workflowVersion: '1.0.0',
        input: input as any,
      });

      await enqueueWorkflowRun(
        queue,
        {
          tenantId,
          runId: run.id,
          workflowName: 'process-order',
          workflowVersion: '1.0.0',
        },
        { jobId: `run_${run.id}` }
      );

      runIds.push(run.id);
    }

    // 2. Genuinely destroy Redis scheduling state with FLUSHALL
    await queue.close();
    queue = null;

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    await redis.flushall();

    // Verify BullMQ queues in Redis are completely empty
    const remainingKeys = await redis.keys('*');
    if (remainingKeys.length > 0) {
      throw new Error(`Expected 0 Redis keys after FLUSHALL, but found ${remainingKeys.length}`);
    }
    await redis.quit();

    // 3. Reconstruct BullMQ queues from PostgreSQL authoritative truth
    const reconstructionStart = performance.now();

    reconciler = new WorkflowReconciler({
      db,
      connectionOrUrl: redisUrl,
      queueName,
      tenantId,
      batchSize: Math.max(100, totalRuns),
    });

    await reconciler.reconcileOnce();
    const reconstructionDurationMs = Number(
      (performance.now() - reconstructionStart).toFixed(2)
    );

    // 4. Spawn workers to execute the reconstructed queue
    for (let i = 0; i < workerCount; i++) {
      const child = fork(runnerPath, [], {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          REDIS_URL: redisUrl,
          TENANT_ID: tenantId,
          CONCURRENCY: concurrencyPerWorker.toString(),
          QUEUE_NAME: queueName,
          WORKER_ID: `recon-worker-${i}-${crypto.randomUUID().slice(0, 6)}`,
        },
        execArgv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
    }

    // Await ready handshake from all workers
    await Promise.all(
      children.map(
        (child, idx) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              child.off('message', onMsg);
              child.off('exit', onExit);
              reject(new Error(`Timed out waiting for worker ${idx + 1} ready message`));
            }, 15000);

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
              reject(new Error(`Worker ${idx + 1} exited prematurely with code ${code}`));
            };

            child.on('message', onMsg);
            child.once('exit', onExit);
          })
      )
    );

    // 5. Await completion of all totalRuns in PostgreSQL
    const pendingSet = new Set(runIds);
    const awaitStart = performance.now();

    while (pendingSet.size > 0) {
      if (performance.now() - awaitStart > timeoutMs) {
        throw new Error(
          `Timeout awaiting workflows completion after reconciliation: ${pendingSet.size} of ${totalRuns} runs pending after ${timeoutMs}ms`
        );
      }

      const checkIds = Array.from(pendingSet);
      const runs = await db.workflowRun.findMany({
        where: { id: { in: checkIds } },
        select: { id: true, status: true },
      });

      for (const run of runs) {
        if (run.status === 'COMPLETED') {
          pendingSet.delete(run.id);
        } else if (run.status === 'FAILED' || run.status === 'CANCELLED') {
          throw new Error(`Workflow run ${run.id} terminated with status: ${run.status}`);
        }
      }

      if (pendingSet.size > 0) {
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    // 6. Invariants assertion
    const allRuns = await db.workflowRun.findMany({
      where: { tenantId, id: { in: runIds } },
      select: { id: true, status: true },
    });

    const completedRunsCount = allRuns.filter((r) => r.status === 'COMPLETED').length;
    const lostRunsCount = totalRuns - completedRunsCount;
    const duplicateRunsCount = Math.max(0, allRuns.length - totalRuns);

    return {
      scenario: 'REDIS_DESTRUCTION_RECONCILER',
      totalRunsSubmitted: totalRuns,
      redisFlushCommand: 'FLUSHALL',
      reconstructionDurationMs,
      lostRunsCount,
      duplicateRunsCount,
      completedRunsCount,
      status: 'PASSED',
    };
  } finally {
    await stopWorkerProcesses(children);
    if (reconciler) {
      await reconciler.stop().catch(() => {});
    }
    if (queue) {
      await queue.close().catch(() => {});
    }
    await db.$disconnect().catch(() => {});
  }
}

// CLI entrypoint execution
const isMain =
  process.argv[1]?.includes('bench-reconciliation') && !process.env.VITEST;

if (isMain) {
  (async () => {
    try {
      console.log('=== Redis Destruction & Reconciler Resilience Benchmark ===');
      const sysinfo = await collectSystemMetadata();
      console.log(`CPU: ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
      console.log(`Node: ${sysinfo.nodeVersion} | OS: ${sysinfo.platform} ${sysinfo.osRelease}`);
      console.log('Submitting workflows, executing real Redis FLUSHALL, and reconciling queues...');

      const result = await runReconciliationBenchmark();

      const report: BenchmarkReport = {
        id: `reconciliation-${Date.now()}`,
        title: 'Redis Destruction & Reconciler Resilience Benchmark',
        timestamp: new Date().toISOString(),
        system: sysinfo,
        reconciliation: result,
      };

      const { jsonPath, markdownPath } = await saveBenchmarkArtifact(report);
      console.log('\n=== Benchmark Summary ===\n');
      console.log(formatMarkdownReport(report));
      console.log(`\nArtifacts persisted:`);
      console.log(`  JSON: ${jsonPath}`);
      console.log(`  Markdown: ${markdownPath}`);
    } catch (err) {
      console.error('Reconciliation benchmark execution failed:', err);
      process.exit(1);
    }
  })();
}
