import { Worker, type ConnectionOptions, type Job } from "bullmq";
import type { PrismaClient } from "@durable/database";
import { recordExecutionEvent } from "@durable/database";
import { generateId } from "@durable/shared";
import { WorkflowExecutor } from "@durable/workflow-sdk";
import { WORKFLOW_QUEUE_NAME } from "./queue.js";
import type { WorkflowRunJobData } from "./types.js";
import type { WorkflowRegistry } from "./registry.js";

export interface WorkflowWorkerOptions {
  db: PrismaClient;
  registry: WorkflowRegistry;
  workerId?: string;
  connectionOrUrl?: string | ConnectionOptions;
  concurrency?: number;
}

export class WorkflowWorker {
  public readonly worker: Worker<WorkflowRunJobData>;
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

    const resolved =
      options.connectionOrUrl ??
      (process.env.REDIS_URL || "redis://localhost:6380");
    const connection: ConnectionOptions =
      typeof resolved === "string" ? { url: resolved } : resolved;

    this.worker = new Worker<WorkflowRunJobData>(
      WORKFLOW_QUEUE_NAME,
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

    if (
      !run ||
      run.status === "COMPLETED" ||
      run.status === "FAILED" ||
      run.status === "CANCELLED"
    ) {
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

    if (run.blockedReason) {
      await this.db.workflowRun.update({
        where: { id: runId },
        data: { blockedReason: null },
      });
    }

    await this.executor.execute(workflow, runId);
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}
