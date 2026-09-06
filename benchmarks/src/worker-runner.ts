import { createPrismaClient, type PrismaClient } from '@durable/database';
import { WorkflowRegistry, createWorker, type WorkflowWorker } from '@durable/worker';
import { defineWorkflow } from '@durable/workflow-sdk';
import { Redis } from 'ioredis';
import { processOrderWorkflow } from '@example/order-processing';

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

  const db = createPrismaClient(databaseUrl);
  await db.$connect();

  const registry = new WorkflowRegistry();
  registry.register(processOrderWorkflow);
  registry.register(chaosWorkflow);

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

const isChildProcess = Boolean(process.send);
const isDirectCli = Boolean(process.argv[1]?.includes('worker-runner'));

if (isChildProcess || isDirectCli) {
  startWorkerReplica().catch((err) => {
    console.error(`Worker runner replica [PID ${process.pid}] failed to start:`, err);
    process.exit(1);
  });
}
