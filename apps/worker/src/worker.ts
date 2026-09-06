import { Worker, type ConnectionOptions, type Job, type Queue } from "bullmq";
import { Redis } from "ioredis";
import type { PrismaClient, WorkflowRunStatus } from "@durable/database";
import { recordExecutionEvent } from "@durable/database";
import { generateId, publishRunEventWakeup } from "@durable/shared";
import { WorkflowExecutor } from "@durable/workflow-sdk";
import {
  WORKFLOW_QUEUE_NAME,
  createWorkflowQueue,
  enqueueWorkflowRun,
  resolveRedisConnection,
} from "./queue.js";
import type { WorkflowRunJobData } from "./types.js";
import type { WorkflowRegistry } from "./registry.js";
import { ConcurrencyCoordinator } from "./concurrency.js";

function isTerminalRunStatus(status: WorkflowRunStatus | string): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

export interface WorkflowWorkerOptions {
  db: PrismaClient;
  registry: WorkflowRegistry;
  workerId?: string;
  connectionOrUrl?: string | ConnectionOptions;
  concurrency?: number;
  queue?: Queue<WorkflowRunJobData>;
  queueName?: string;
  concurrencyCoordinator?: ConcurrencyCoordinator;
  redis?: Redis;
  concurrencyRetryDelayMs?: number;
}

export class WorkflowWorker {
  public readonly worker: Worker<WorkflowRunJobData>;
  public readonly queue: Queue<WorkflowRunJobData>;
  public readonly concurrencyCoordinator: ConcurrencyCoordinator;
  private readonly ownsQueue: boolean;
  private readonly db: PrismaClient;
  private readonly registry: WorkflowRegistry;
  private readonly workerId: string;
  private readonly executor: WorkflowExecutor;
  private readonly redisClient?: Redis;
  private readonly ownsRedis: boolean;
  private readonly concurrencyRetryDelayMs: number;
  private readonly publisher?: { publish(channel: string, message: string): Promise<number> };

  constructor(options: WorkflowWorkerOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.workerId = options.workerId ?? generateId("worker");
    this.concurrencyRetryDelayMs = options.concurrencyRetryDelayMs ?? 500;

    if (options.redis) {
      this.redisClient = options.redis;
      this.ownsRedis = false;
      this.concurrencyCoordinator =
        options.concurrencyCoordinator ?? new ConcurrencyCoordinator(options.redis);
    } else if (options.concurrencyCoordinator) {
      this.concurrencyCoordinator = options.concurrencyCoordinator;
      this.ownsRedis = false;
    } else {
      if (typeof options.connectionOrUrl === "string") {
        this.redisClient = new Redis(options.connectionOrUrl, { maxRetriesPerRequest: null });
      } else if (options.connectionOrUrl && typeof options.connectionOrUrl === "object") {
        this.redisClient = new Redis({
          ...(options.connectionOrUrl as any),
          maxRetriesPerRequest: null,
        });
      } else {
        this.redisClient = new Redis(process.env.REDIS_URL || "redis://localhost:6380", {
          maxRetriesPerRequest: null,
        });
      }
      this.ownsRedis = true;
      this.concurrencyCoordinator = new ConcurrencyCoordinator(this.redisClient);
    }

    this.publisher =
      this.redisClient ||
      options.redis ||
      (options.concurrencyCoordinator ? (options.concurrencyCoordinator as any).redis : undefined);

    this.executor = new WorkflowExecutor({
      db: this.db,
      workerId: this.workerId,
      onEvent: async (runId) => {
        if (this.publisher) {
          try {
            await publishRunEventWakeup(this.publisher, runId);
          } catch {
            // Best-effort notification: errors must not disrupt worker execution
          }
        }
      },
    });

    const connection = resolveRedisConnection(options.connectionOrUrl);
    const queueName =
      options.queue?.name ?? options.queueName ?? WORKFLOW_QUEUE_NAME;

    if (options.queue) {
      this.queue = options.queue;
      this.ownsQueue = false;
    } else {
      this.queue = createWorkflowQueue(options.connectionOrUrl, queueName);
      this.ownsQueue = true;
    }

    this.worker = new Worker<WorkflowRunJobData>(
      queueName,
      async (job) => this.processJob(job),
      {
        connection,
        concurrency: options.concurrency ?? 5,
      }
    );
  }

  async processJob(
    job: Job<WorkflowRunJobData> | { data: WorkflowRunJobData }
  ): Promise<void> {
    const { runId, workflowName, workflowVersion } = job.data;

    const run = await this.db.workflowRun.findUnique({
      where: { id: runId },
    });

    if (!run || isTerminalRunStatus(run.status)) {
      return;
    }

    const workflow = this.registry.get(workflowName, workflowVersion);
    if (!workflow) {
      await this.db.$transaction(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: {
            status: "PENDING",
            blockedReason: "WORKFLOW_VERSION_UNAVAILABLE",
          },
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_VERSION_UNAVAILABLE",
          payload: { workflowName, workflowVersion },
        });
      });
      if (this.publisher) {
        try {
          await publishRunEventWakeup(this.publisher, runId);
        } catch {
          // Best-effort notification: errors must not disrupt worker execution
        }
      }
      return;
    }

    const concurrency = workflow.config.concurrency;
    const fallbackKey = run.concurrencyKey ?? undefined;
    const hasConcurrencyLimit =
      (concurrency && (concurrency.limit !== undefined || concurrency.key !== undefined)) ||
      Boolean(fallbackKey);

    let releaseSlot: (() => Promise<void>) | undefined;
    if (hasConcurrencyLimit) {
      const slot = await this.concurrencyCoordinator.tryAcquire(
        runId,
        concurrency ?? {},
        run.input,
        workflow.config.name,
        run.tenantId,
        fallbackKey
      );
      if (!slot.acquired) {
        await enqueueWorkflowRun(this.queue, job.data, {
          delay: this.concurrencyRetryDelayMs,
        });
        return;
      }
      releaseSlot = slot.release;
    }

    try {
      const output = await this.executor.execute(workflow, runId);

      if (output === undefined) {
        const retryStep = await this.db.stepExecution.findFirst({
          where: {
            workflowRunId: runId,
            status: "RETRY_WAIT",
            nextRetryAt: { not: null },
          },
          orderBy: {
            nextRetryAt: "asc",
          },
        });

        if (retryStep?.nextRetryAt) {
          const delay = Math.max(0, retryStep.nextRetryAt.getTime() - Date.now());
          const jobId = `retry_${runId}_${retryStep.id}_${retryStep.attemptCount}`;
          await enqueueWorkflowRun(this.queue, job.data, { delay, jobId });
        }
      }
    } finally {
      if (releaseSlot) {
        await releaseSlot().catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.concurrencyCoordinator.close();
    if (this.ownsQueue) {
      await this.queue.close();
    }
    if (this.ownsRedis && this.redisClient) {
      await this.redisClient.quit().catch(() => this.redisClient?.disconnect());
    }
  }
}

export function createWorker(options: WorkflowWorkerOptions): WorkflowWorker {
  return new WorkflowWorker(options);
}
