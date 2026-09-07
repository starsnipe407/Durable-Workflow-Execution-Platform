import { createPrismaClient, type PrismaClient } from '@durable/database';
import { WorkflowRegistry, createWorker, type WorkflowWorker } from '@durable/worker';
import {
  defineWorkflow,
  type WorkflowConfig,
  type WorkflowDefinition,
  type WorkflowHandler,
} from '@durable/workflow-sdk';
import { Redis } from 'ioredis';
import { processOrderWorkflow } from '@example/order-processing';

export type BenchmarkWorkflowDefinition<TInput, TOutput> = WorkflowDefinition<TInput, TOutput> & {
  name: string;
  version: string;
  execute: WorkflowHandler<TInput, TOutput>;
};

function createBenchmarkWorkflow<TInput, TOutput>(
  config: WorkflowConfig<TInput>,
  handler: WorkflowHandler<TInput, TOutput>
): BenchmarkWorkflowDefinition<TInput, TOutput> {
  const def = defineWorkflow<TInput, TOutput>(config, handler);
  return Object.assign(def, {
    name: config.name,
    version: config.version,
    execute: handler,
  });
}

export interface ChaosWorkflowInput {
  chaosRunId: string;
  delayMs?: number;
}

export const chaosWorkflow = defineWorkflow<ChaosWorkflowInput, { completed: boolean }>(
  { name: 'chaos-workflow', version: '1.0.0' },
  async ({ input, step }) => {
    // Step 1: Initial setup (sequential)
    await step.run('step-1-init', async () => {
      return { initialized: true, at: Date.now() };
    });

    // Step 2: Processing step where SIGKILL will be injected
    await step.run('step-2-process', async () => {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
      try {
        const isKilled = await redis.get(`chaos:killed:${input.chaosRunId}`);
        if (!isKilled) {
          const delay = input.delayMs ?? 10000;
          await new Promise((r) => setTimeout(r, delay));
        }
      } finally {
        await redis.quit().catch(() => {});
      }
      return { processed: true, at: Date.now() };
    });

    // Steps 3 & 4: Parallel steps
    await Promise.all([
      step.run('step-3-notify', async () => ({ notified: true })),
      step.run('step-4-index', async () => ({ indexed: true })),
    ]);

    // Step 5: Finalization (sequential)
    await step.run('step-5-finalize', async () => ({ finalized: true }));

    return { completed: true };
  }
);

export interface EngineBenchmarkInput {
  stepDelayMs?: number;
}

export const engineBenchmarkWorkflow = createBenchmarkWorkflow<
  EngineBenchmarkInput,
  { completed: boolean }
>({ name: 'engine-benchmark', version: '1.0.0' }, async ({ input, step }) => {
  const delay = input.stepDelayMs ?? 5;

  await step.run('step-a', async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { step: 'a', ts: Date.now() };
  });

  await step.run('step-b', async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { step: 'b', ts: Date.now() };
  });

  await step.run('step-c', async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { step: 'c', ts: Date.now() };
  });

  await step.run('step-d', async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { step: 'd', ts: Date.now() };
  });

  return { completed: true };
});

export interface RetryWorkflowInput {
  failureRatePercent: number; // e.g. 0, 5, 10, 20
  runId: string;
}

const retryAttempts = new Map<string, number>();

export const retryWorkflow = createBenchmarkWorkflow<RetryWorkflowInput, { completed: boolean }>(
  { name: 'retry-workflow', version: '1.0.0' },
  async ({ input, step }) => {
    await step.run(
      'flaky-step',
      {
        retry: {
          maxAttempts: 5,
          backoff: { type: 'exponential', initialMs: 20, maxMs: 100 },
        },
      },
      async (ctx: any) => {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
        const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
        let attempt = 1;
        try {
          attempt = await redis.incr(`retry:attempt:${input.runId}`);
        } catch {
          attempt = ctx?.attempt ?? ((retryAttempts.get(input.runId) ?? 0) + 1);
          retryAttempts.set(input.runId, attempt);
        } finally {
          await redis.quit().catch(() => {});
        }

        if (input.failureRatePercent > 0 && attempt === 1) {
          // Deterministic hash based on runId to simulate transient failure
          const hash = input.runId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
          if (hash % 100 < input.failureRatePercent) {
            throw new Error(`Injected transient failure (rate: ${input.failureRatePercent}%)`);
          }
        }

        retryAttempts.delete(input.runId);
        return { success: true, attempt };
      }
    );

    return { completed: true };
  }
);

export interface FencingWorkflowInput {
  runId: string;
}

export const fencingWorkflow = createBenchmarkWorkflow<
  FencingWorkflowInput,
  { completed: boolean; workerPid?: number; attempt?: number }
>(
  { name: 'fencing-workflow', version: '1.0.0' },
  async ({ input, step }) => {
    let result: any;
    try {
      result = await step.run('fenced-step', async () => {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
        const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
        try {
          const attempt = await redis.incr(`fencing:attempts:${input.runId}`);
          if (attempt === 1) {
            await redis.set(`fencing:workerA:pid:${input.runId}`, process.pid.toString());
            await redis.set(`fencing:paused:${input.runId}`, '1');
            const waitStart = Date.now();
            while (Date.now() - waitStart < 30000) {
              const release = await redis.get(`fencing:release:${input.runId}`);
              if (release) break;
              await new Promise((r) => setTimeout(r, 50));
            }
          } else {
            await redis.set(`fencing:workerB:pid:${input.runId}`, process.pid.toString());
          }
          return { workerPid: process.pid, attempt, completedAt: Date.now() };
        } finally {
          await redis.quit().catch(() => {});
        }
      });
    } catch (err: any) {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
      try {
        const errMsg = err instanceof Error ? err.message : String(err);
        await redis.set(`fencing:workerA:error:${input.runId}`, errMsg);
        await redis.set(`fencing:workerA:errorName:${input.runId}`, err?.name ?? 'Error');
      } finally {
        await redis.quit().catch(() => {});
      }
      throw err;
    }

    return { completed: true, ...result };
  }
);

export interface WorkerReplicaInstance {
  worker: WorkflowWorker;
  db: PrismaClient;
  shutdown: () => Promise<void>;
}

export async function startWorkerReplica(): Promise<WorkerReplicaInstance> {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const concurrency = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 5;
  const queueName = process.env.QUEUE_NAME || 'workflow-runs';
  const workerId = process.env.WORKER_ID || `worker-replica-${process.pid}`;
  const leaseDurationMs = process.env.LEASE_TTL_MS
    ? parseInt(process.env.LEASE_TTL_MS, 10)
    : undefined;

  const dbUrlWithLimit = databaseUrl.includes('connection_limit=')
    ? databaseUrl
    : `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}connection_limit=10`;
  const db = createPrismaClient(dbUrlWithLimit);
  await db.$connect();

  const registry = new WorkflowRegistry();
  registry.register(processOrderWorkflow);
  registry.register(chaosWorkflow);
  registry.register(engineBenchmarkWorkflow);
  registry.register(retryWorkflow);
  registry.register(fencingWorkflow);

  const worker = createWorker({
    db,
    registry,
    workerId,
    connectionOrUrl: redisUrl,
    concurrency,
    queueName,
    leaseDurationMs,
  });

  await worker.worker.waitUntilReady();

  let isClosing = false;
  const shutdown = async () => {
    if (isClosing) return;
    isClosing = true;
    try {
      await worker.close();
    } catch {}
    try {
      await db.$disconnect();
    } catch {}
    if (process.send) {
      process.send({ stopped: true, pid: process.pid });
    }
  };

  process.on('message', async (msg) => {
    if (msg === 'shutdown' || (typeof msg === 'object' && msg && (msg as any).type === 'shutdown')) {
      await shutdown();
      process.exit(0);
    }
  });

  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });

  if (process.send) {
    process.send({ ready: true, pid: process.pid });
  }

  return { worker, db, shutdown };
}

const isWorkerEntry = Boolean(
  process.argv[1] && process.argv[1].includes('worker-runner')
);

if (isWorkerEntry) {
  startWorkerReplica().catch((err) => {
    console.error(`Worker runner replica [PID ${process.pid}] failed to start:`, err);
    process.exit(1);
  });
}
