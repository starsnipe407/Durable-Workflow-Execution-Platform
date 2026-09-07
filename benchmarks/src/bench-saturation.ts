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
import { calculatePercentiles, collectSystemMetadata } from './sysinfo.js';
import { stopWorkerProcesses } from './bench-throughput.js';
import type {
  SaturationBenchmarkResult,
  SaturationTierResult,
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

export interface SaturationBenchOptions {
  rates?: number[];
  durationPerTierSec?: number;
  workerReplicas?: number;
  concurrencyPerWorker?: number;
  tenantId?: string;
  databaseUrl?: string;
  redisUrl?: string;
  queueName?: string;
  workerRunnerPath?: string;
  drainTimeoutMs?: number;
}

export async function runSaturationBenchmark(
  options?: SaturationBenchOptions
): Promise<SaturationBenchmarkResult> {
  const rates = options?.rates ?? [25, 50, 75, 100, 150, 200];
  const durationSec = options?.durationPerTierSec ?? 5;
  const workerReplicas = options?.workerReplicas ?? 4;
  const concurrency = options?.concurrencyPerWorker ?? 8;
  const drainTimeoutMs = options?.drainTimeoutMs ?? 30000;
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
    `bench_sat_${crypto.randomUUID().slice(0, 8)}`;

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

  const db: PrismaClient = createPrismaClient(databaseUrl);
  await db.$connect();

  await db.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: `Saturation Tenant ${tenantId}` },
  });

  const queue: Queue<WorkflowRunJobData> = createWorkflowQueue(redisUrl, queueName);
  const tierResults: SaturationTierResult[] = [];
  let saturationPoint: number | null = null;
  const children: ChildProcess[] = [];

  try {
    // 1. Spawn worker replicas
    for (let i = 0; i < workerReplicas; i++) {
      const child = fork(runnerPath, [], {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          REDIS_URL: redisUrl,
          TENANT_ID: tenantId,
          CONCURRENCY: concurrency.toString(),
          QUEUE_NAME: queueName,
          WORKER_ID: `sat-worker-${i}-${crypto.randomUUID().slice(0, 6)}`,
        },
        execArgv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
    }

    // 2. Await ready handshake from all worker replicas
    await Promise.all(
      children.map(
        (child, idx) =>
          new Promise<void>((resolve, reject) => {
            const onExit = (code: number | null) => {
              clearTimeout(timer);
              child.off('message', onMsg);
              reject(
                new Error(`Saturation worker ${idx + 1}/${workerReplicas} exited prematurely with code ${code}`)
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
                  `Timed out waiting for saturation worker ${idx + 1}/${workerReplicas} ready message`
                )
              );
            }, 20000);

            child.on('message', onMsg);
            child.once('exit', onExit);
          })
      )
    );

    // 3. Step through offered load rates
    for (const rate of rates) {
      const totalToInject = Math.max(1, Math.round(rate * durationSec));
      const runIds: string[] = [];
      const enqueuedAtMap = new Map<string, number>();
      const queueDepths: number[] = [];

      const tierStartTime = performance.now();

      let sampleTimer: NodeJS.Timeout | null = null;
      sampleTimer = setInterval(async () => {
        try {
          const [w, a] = await Promise.all([queue.getWaitingCount(), queue.getActiveCount()]);
          queueDepths.push(w + a);
        } catch {}
      }, 50);

      try {
        // Pace workflow submissions at offered rate
        for (let i = 0; i < totalToInject; i++) {
          const targetElapsedMs = (i * 1000) / rate;
          const currentElapsedMs = performance.now() - tierStartTime;
          if (targetElapsedMs > currentElapsedMs) {
            await new Promise((r) => setTimeout(r, Math.max(0, targetElapsedMs - currentElapsedMs)));
          }

          const enqueuedAt = Date.now();
          const run = await createWorkflowRun(db, {
            tenantId,
            workflowName: 'engine-benchmark',
            workflowVersion: '1.0.0',
            input: { stepDelayMs: 2 } as any,
          });

          await enqueueWorkflowRun(queue, {
            tenantId,
            runId: run.id,
            workflowName: 'engine-benchmark',
            workflowVersion: '1.0.0',
          });

          runIds.push(run.id);
          enqueuedAtMap.set(run.id, enqueuedAt);
        }
      } finally {
        if (sampleTimer) {
          clearInterval(sampleTimer);
          sampleTimer = null;
        }
      }

      // Await runs completion for this tier
      const pending = new Set(runIds);
      const queueLatencies: number[] = [];
      let completedRuns = 0;
      const drainStart = performance.now();

      while (pending.size > 0 && performance.now() - drainStart < drainTimeoutMs) {
        const pendingArray = Array.from(pending);
        const batchSize = 100;
        for (let b = 0; b < pendingArray.length; b += batchSize) {
          const slice = pendingArray.slice(b, b + batchSize);
          const dbRuns = await db.workflowRun.findMany({
            where: { id: { in: slice } },
            select: { id: true, status: true, startedAt: true },
          });

          for (const r of dbRuns) {
            if (r.status === 'COMPLETED') {
              completedRuns++;
              pending.delete(r.id);
              const enqueuedAt = enqueuedAtMap.get(r.id) ?? Date.now();
              const startedAt = r.startedAt ? r.startedAt.getTime() : Date.now();
              queueLatencies.push(Math.max(0, startedAt - enqueuedAt));
            } else if (r.status === 'FAILED' || r.status === 'CANCELLED') {
              pending.delete(r.id);
            }
          }
        }

        if (pending.size > 0) {
          const waiting = await queue.getWaitingCount();
          const active = await queue.getActiveCount();
          queueDepths.push(waiting + active);
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      const tierDurationMs = Number((performance.now() - tierStartTime).toFixed(2));
      const achievedThroughputPerSec = Number(
        ((completedRuns / (tierDurationMs / 1000))).toFixed(2)
      );
      const maxQueueDepth = queueDepths.reduce((max, d) => Math.max(max, d), 0);
      const queueLatencyMs = calculatePercentiles(
        queueLatencies.length > 0 ? queueLatencies : [0]
      );

      const workerCapacity = workerReplicas * concurrency;
      const isSaturated =
        (rate > achievedThroughputPerSec * 1.25 && maxQueueDepth > workerCapacity) ||
        maxQueueDepth > workerCapacity * 2;

      if (isSaturated && saturationPoint === null) {
        saturationPoint = rate;
      }

      tierResults.push({
        offeredRateReqPerSec: rate,
        acceptedRuns: runIds.length,
        completedRuns,
        durationMs: tierDurationMs,
        achievedThroughputPerSec,
        maxQueueDepth,
        queueLatencyMs,
        isSaturated,
      });
    }
  } finally {
    await stopWorkerProcesses(children);
    await queue.close();
    await db.$disconnect();
  }

  return {
    scenario: 'OFFERED_LOAD_SATURATION',
    fixedWorkerReplicas: workerReplicas,
    concurrencyPerWorker: concurrency,
    tiers: tierResults,
    saturationPointReqPerSec: saturationPoint,
    status: 'PASSED',
  };
}

// CLI entrypoint execution
const isMain =
  process.argv[1]?.includes('bench-saturation') && !process.env.VITEST;

if (isMain) {
  (async () => {
    try {
      console.log('=== Offered Load Saturation Curve Benchmark ===');
      const sysinfo = await collectSystemMetadata();
      console.log(`CPU: ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
      console.log(`Node: ${sysinfo.nodeVersion} | OS: ${sysinfo.platform} ${sysinfo.osRelease}`);
      console.log('Stepping through offered rates [25, 50, 75, 100, 150, 200] req/s...');

      const result = await runSaturationBenchmark();
      console.log('\n=== Saturation Curve Results ===\n');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Saturation benchmark failed:', err);
      process.exit(1);
    }
  })();
}
