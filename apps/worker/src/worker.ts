import { Worker, type ConnectionOptions, type Job, type Queue } from "bullmq";
import type { PrismaClient, WorkflowRunStatus } from "@durable/database";
import { recordExecutionEvent } from "@durable/database";
import { generateId } from "@durable/shared";
import { WorkflowExecutor } from "@durable/workflow-sdk";
import {
  WORKFLOW_QUEUE_NAME,
  createWorkflowQueue,
  enqueueWorkflowRun,
  resolveRedisConnection,
} from "./queue.js";
import type { WorkflowRunJobData } from "./types.js";
import type { WorkflowRegistry } from "./registry.js";

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
}

export class WorkflowWorker {
  public readonly worker: Worker<WorkflowRunJobData>;
  public readonly queue: Queue<WorkflowRunJobData>;
  private readonly ownsQueue: boolean;
  private readonly db: PrismaClient;
  private readonly registry: WorkflowRegistry;
  private readonly workerId: string;
  private readonly executor: WorkflowExecutor;

  constructor(options: WorkflowWorkerOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.workerId = options.workerId ?? generateId("worker");
    this.executor = new WorkflowExecutor({
      db: this.db,
      workerId: this.workerId,
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
      return;
    }

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
  }

  async close(): Promise<void> {
    await this.worker.close();
    if (this.ownsQueue) {
      await this.queue.close();
    }
  }
}
