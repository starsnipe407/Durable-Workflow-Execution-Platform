import { createPrismaClient, type PrismaClient } from '@durable/database';
import { WorkflowRegistry, createWorker, type WorkflowWorker } from '@durable/worker';
import { processOrderWorkflow } from '@example/order-processing';

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

  const db = createPrismaClient(databaseUrl);
  await db.$connect();

  const registry = new WorkflowRegistry();
  registry.register(processOrderWorkflow);

  const worker = createWorker({
    db,
    registry,
    workerId,
    connectionOrUrl: redisUrl,
    concurrency,
    queueName,
  });

  await worker.worker.waitUntilReady().catch(() => {});

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
