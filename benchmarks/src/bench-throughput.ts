import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Queue } from 'bullmq';
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
import type { OrderInput } from '@example/order-processing';
import { collectSystemMetadata, calculatePercentiles } from './sysinfo.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from './reporter.js';
import type {
  ThroughputScalingTier,
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

export interface ThroughputBenchOptions {
  tiers?: number[];
  concurrencyPerWorker?: number;
  warmupRuns?: number;
  measuredRepetitions?: number;
  runsPerRepetition?: number;
  tenantId?: string;
  databaseUrl?: string;
  redisUrl?: string;
  queueName?: string;
  timeoutMs?: number;
  workerRunnerPath?: string;
  workflowName?: 'engine-benchmark' | 'process-order';
}

function computeMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number(((sorted[mid - 1]! + sorted[mid]!) / 2).toFixed(2));
  }
  return Number(sorted[mid]!.toFixed(2));
}

export async function stopWorkerProcesses(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return resolve();
          }
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
        })
    )
  );
}

export interface CompletionLatencies extends Array<number> {
  workflowLatencies: number[];
  queueLatencies: number[];
}

export async function awaitRunsCompletedWithLatencies(
  db: PrismaClient,
  runIds: string[],
  startTimes: Map<string, number>,
  timeoutMs: number,
  enqueuedTimes?: Map<string, number>
): Promise<CompletionLatencies> {
  const pending = new Set(runIds);
  const workflowLatencies: number[] = [];
  const queueLatencies: number[] = [];
  const start = performance.now();

  while (pending.size > 0) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `Timeout awaiting workflows completion: ${pending.size} of ${runIds.length} runs pending after ${timeoutMs}ms`
      );
    }

    const pendingArray = Array.from(pending);
    const batchSize = 100;
    for (let i = 0; i < pendingArray.length; i += batchSize) {
      const slice = pendingArray.slice(i, i + batchSize);
      const runs = await db.workflowRun.findMany({
        where: { id: { in: slice } },
        select: { id: true, status: true, startedAt: true },
      });

      for (const run of runs) {
        if (run.status === 'FAILED' || run.status === 'CANCELLED') {
          throw new Error(`Workflow run ${run.id} terminated with unexpected status: ${run.status}`);
        }
        if (run.status === 'COMPLETED') {
          const finishedAt = performance.now();
          const submittedAt = startTimes.get(run.id) ?? start;
          workflowLatencies.push(Number((finishedAt - submittedAt).toFixed(2)));

          const enqueuedAt = enqueuedTimes?.get(run.id);
          if (enqueuedAt !== undefined) {
            const startedAtMs = run.startedAt ? run.startedAt.getTime() : Date.now();
            queueLatencies.push(Math.max(0, Number((startedAtMs - enqueuedAt).toFixed(2))));
          }
          pending.delete(run.id);
        }
      }
    }

    if (pending.size > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return Object.assign(workflowLatencies, {
    workflowLatencies,
    queueLatencies,
  });
}

export async function runThroughputBenchmark(
  options?: ThroughputBenchOptions
): Promise<ThroughputScalingTier[]> {
  const tiers = options?.tiers ?? [1, 2, 4, 8];
  const concurrencyPerWorker = options?.concurrencyPerWorker ?? 5;
  const warmupRuns = options?.warmupRuns ?? 10;
  const measuredRepetitions = options?.measuredRepetitions ?? 3;
  const runsPerRepetition = options?.runsPerRepetition ?? 50;
  const timeoutMs = options?.timeoutMs ?? 60000;

  const databaseUrl =
    options?.databaseUrl ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl =
    options?.redisUrl ||
    process.env.REDIS_URL ||
    'redis://localhost:6380';

  const tenantId =
    options?.tenantId ||
    crypto.randomUUID();
  const queueName =
    options?.queueName ||
    `bench_queue_${crypto.randomUUID().slice(0, 8)}`;

  const defaultDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultTsPath = path.resolve(defaultDir, 'worker-runner.ts');
  const defaultJsPath = path.resolve(defaultDir, 'worker-runner.js');
  const defaultRunnerPath = fs.existsSync(defaultTsPath) ? defaultTsPath : defaultJsPath;
  const runnerPath = options?.workerRunnerPath || defaultRunnerPath;

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

  const workflowName = options?.workflowName ?? 'engine-benchmark';
  const stepsPerWorkflow = workflowName === 'engine-benchmark' ? 4 : (workflowName === 'process-order' ? 7 : 4);
  const createRunInput = (orderId: string, idx: number) => {
    if (workflowName === 'engine-benchmark') {
      return { stepDelayMs: 2 };
    }
    return {
      orderId,
      customerId: `cust_${idx}`,
      customerEmail: `customer_${idx}@example.com`,
      items: [
        { sku: 'ITEM-A', quantity: 2, price: 25 },
        { sku: 'ITEM-B', quantity: 1, price: 50 },
      ],
      totalAmount: 100,
    };
  };

  const db = createPrismaClient(databaseUrl);
  await db.$connect();

  await db.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: `Throughput Benchmark Tenant ${tenantId}` },
  });

  const queue: Queue<WorkflowRunJobData> = createWorkflowQueue(redisUrl, queueName);
  const results: ThroughputScalingTier[] = [];

  try {
    for (const N of tiers) {
      const children: ChildProcess[] = [];

      try {
        // 1. Spawn N worker processes
        for (let i = 0; i < N; i++) {
          const child = fork(runnerPath, [], {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              REDIS_URL: redisUrl,
              TENANT_ID: tenantId,
              CONCURRENCY: concurrencyPerWorker.toString(),
              QUEUE_NAME: queueName,
              WORKER_ID: `bench-worker-${N}-${i}-${crypto.randomUUID().slice(0, 6)}`,
            },
            execArgv,
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          });
          children.push(child);
        }

        // 2. Await ready handshake from all N workers
        await Promise.all(
          children.map(
            (child, idx) =>
              new Promise<void>((resolve, reject) => {
                const onExit = (code: number | null) => {
                  clearTimeout(timer);
                  child.off('message', onMsg);
                  reject(
                    new Error(`Worker replica ${idx + 1}/${N} exited prematurely with code ${code}`)
                  );
                };

                const onMsg = (msg: any) => {
                  if (msg && msg.ready === true) {
                    clearTimeout(timer);
                    child.off('message', onMsg);
                    child.off('exit', onExit);
                    resolve();
                  }
                };

                const timer = setTimeout(() => {
                  child.off('message', onMsg);
                  child.off('exit', onExit);
                  reject(
                    new Error(
                      `Timed out waiting for worker replica ${idx + 1}/${N} ready message`
                    )
                  );
                }, 20000);

                child.on('message', onMsg);
                child.once('exit', onExit);
              })
          )
        );

        // 3. Warmup phase (discard timings)
        if (warmupRuns > 0) {
          const warmupRunIds: string[] = [];
          const CHUNK_SIZE = 50;
          for (let chunkStart = 0; chunkStart < warmupRuns; chunkStart += CHUNK_SIZE) {
            const chunkEnd = Math.min(warmupRuns, chunkStart + CHUNK_SIZE);
            const chunkPromises = Array.from({ length: chunkEnd - chunkStart }, async (_, offset) => {
              const i = chunkStart + offset;
              const orderId = `warmup_${N}_${i}_${crypto.randomUUID().slice(0, 8)}`;
              const input = createRunInput(orderId, i);
              const run = await createWorkflowRun(db, {
                tenantId,
                workflowName,
                workflowVersion: '1.0.0',
                input: input as any,
              });
              await enqueueWorkflowRun(queue, {
                tenantId,
                runId: run.id,
                workflowName,
                workflowVersion: '1.0.0',
              });
              return run.id;
            });
            const chunkIds = await Promise.all(chunkPromises);
            warmupRunIds.push(...chunkIds);
          }
          await awaitRunsCompletedWithLatencies(
            db,
            warmupRunIds,
            new Map(),
            timeoutMs
          );
        }

        // 4. Measured repetitions
        const durationsMs: number[] = [];
        const throughputsPerSec: number[] = [];
        const tierRawLatencies: number[] = [];
        const tierRawQueueLatencies: number[] = [];

        for (let rep = 1; rep <= measuredRepetitions; rep++) {
          const repStart = performance.now();
          const runIds: string[] = [];
          const runStartTimes = new Map<string, number>();
          const runEnqueuedTimes = new Map<string, number>();

          const CHUNK_SIZE = 50;
          for (let chunkStart = 0; chunkStart < runsPerRepetition; chunkStart += CHUNK_SIZE) {
            const chunkEnd = Math.min(runsPerRepetition, chunkStart + CHUNK_SIZE);
            const chunkPromises = Array.from({ length: chunkEnd - chunkStart }, async (_, offset) => {
              const i = chunkStart + offset;
              const orderId = `ord_t${N}_r${rep}_${i}_${crypto.randomUUID().slice(0, 8)}`;
              const input = createRunInput(orderId, i);
              const submitTime = performance.now();
              const enqueuedAt = Date.now();
              const run = await createWorkflowRun(db, {
                tenantId,
                workflowName,
                workflowVersion: '1.0.0',
                input: input as any,
              });
              await enqueueWorkflowRun(queue, {
                tenantId,
                runId: run.id,
                workflowName,
                workflowVersion: '1.0.0',
              });
              return { id: run.id, submitTime, enqueuedAt };
            });
            const chunkSubmitted = await Promise.all(chunkPromises);
            for (const item of chunkSubmitted) {
              runIds.push(item.id);
              runStartTimes.set(item.id, item.submitTime);
              runEnqueuedTimes.set(item.id, item.enqueuedAt);
            }
          }

          const repLatencies = await awaitRunsCompletedWithLatencies(
            db,
            runIds,
            runStartTimes,
            timeoutMs,
            runEnqueuedTimes
          );

          const repDurationMs = Number((performance.now() - repStart).toFixed(2));
          const repThroughput = Number(
            ((runsPerRepetition / (repDurationMs / 1000))).toFixed(2)
          );

          durationsMs.push(repDurationMs);
          throughputsPerSec.push(repThroughput);
          tierRawLatencies.push(...repLatencies.workflowLatencies);
          tierRawQueueLatencies.push(...repLatencies.queueLatencies);
        }

        // 5. Compute tier statistics
        const medianDurationMs = computeMedian(durationsMs);
        const medianThroughputPerSec = computeMedian(throughputsPerSec);
        const latencyMs = calculatePercentiles(tierRawLatencies);
        const workflowLatencyMs = latencyMs;
        const queueLatencyMs = calculatePercentiles(
          tierRawQueueLatencies.length > 0 ? tierRawQueueLatencies : [0]
        );
        const stepsPerSec = Number((medianThroughputPerSec * stepsPerWorkflow).toFixed(2));

        const tierResult: ThroughputScalingTier = {
          workerReplicas: N,
          concurrencyPerWorker,
          totalWorkers: N,
          warmupRuns,
          measuredRepetitions,
          runsPerRepetition,
          totalWorkflows: runsPerRepetition * measuredRepetitions,
          durationsMs,
          medianDurationMs,
          throughputsPerSec,
          medianThroughputPerSec,
          stepsPerSec,
          workflowLatencyMs,
          queueLatencyMs,
          latencyMs,
          rawLatenciesMs: tierRawLatencies,
        };

        results.push(tierResult);
      } finally {
        // 6. Terminate N worker processes
        await stopWorkerProcesses(children);
      }
    }
  } finally {
    await queue.close();
    await db.$disconnect();
  }

  return results;
}

// CLI entrypoint execution
const isMain =
  process.argv[1]?.includes('bench-throughput') && !process.env.VITEST;

if (isMain) {
  (async () => {
    try {
      console.log('=== Horizontal Multi-Worker Replica Scaling Benchmark ===');
      const sysinfo = await collectSystemMetadata();
      console.log(`CPU: ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
      console.log(`Node: ${sysinfo.nodeVersion} | OS: ${sysinfo.platform} ${sysinfo.osRelease}`);
      console.log('Running scaling tiers [1, 2, 4, 8] with 5 concurrency slots/worker...');

      const tiersResult = await runThroughputBenchmark();

      const report: BenchmarkReport = {
        id: `throughput-${Date.now()}`,
        title: 'Horizontal Multi-Worker Replica Scaling Benchmark',
        timestamp: new Date().toISOString(),
        system: sysinfo,
        throughput: tiersResult,
      };

      const { jsonPath, markdownPath } = await saveBenchmarkArtifact(report);
      console.log('\n=== Benchmark Summary ===\n');
      console.log(formatMarkdownReport(report));
      console.log(`\nArtifacts persisted:`);
      console.log(`  JSON: ${jsonPath}`);
      console.log(`  Markdown: ${markdownPath}`);
    } catch (err) {
      console.error('Benchmark execution failed:', err);
      process.exit(1);
    }
  })();
}
