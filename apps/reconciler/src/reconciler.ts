import type { PrismaClient } from "@durable/database";
import { createWorkflowQueue, enqueueWorkflowRun, type WorkflowRunJobData } from "@durable/worker";
import type { Queue } from "bullmq";
import type { ReconcilerOptions, ReconcilerStats } from "./types.js";

export class Reconciler {
  private db: PrismaClient;
  private queue: Queue<WorkflowRunJobData>;
  private ownsQueue: boolean;
  private pollIntervalMs: number;
  private batchSize: number;
  private running: boolean = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isReconciling: boolean = false;

  constructor(options: ReconcilerOptions) {
    this.db = options.db;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 50;

    if (options.queue) {
      this.queue = options.queue;
      this.ownsQueue = false;
    } else {
      this.queue = createWorkflowQueue(options.connectionOrUrl, options.queueName);
      this.ownsQueue = true;
    }
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    this.intervalTimer = setInterval(async () => {
      if (!this.running || this.isReconciling) {
        return;
      }
      try {
        await this.reconcileOnce();
      } catch (err) {
        console.error("Reconciler tick error:", err);
      }
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    const start = Date.now();
    while (this.isReconciling && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.ownsQueue) {
      await this.queue.close();
    }
  }

  async reconcileOnce(): Promise<ReconcilerStats> {
    if (this.isReconciling) {
      return {
        pendingRunsReconciled: 0,
        dueRetriesReconciled: 0,
        expiredLeasesReconciled: 0,
        blockedVersionsReconciled: 0,
      };
    }

    this.isReconciling = true;
    try {
      const pendingRunsReconciled = await this.reconcilePendingRuns();
      return {
        pendingRunsReconciled,
        dueRetriesReconciled: 0,
        expiredLeasesReconciled: 0,
        blockedVersionsReconciled: 0,
      };
    } finally {
      this.isReconciling = false;
    }
  }

  async reconcilePendingRuns(): Promise<number> {
    return await this.db.$transaction(async (tx) => {
      const runs = await tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          workflowName: string;
          workflowVersion: string;
        }>
      >`
        SELECT 
          id,
          tenant_id AS "tenantId",
          workflow_name AS "workflowName",
          workflow_version AS "workflowVersion"
        FROM workflow_runs
        WHERE status = 'PENDING'::"WorkflowRunStatus"
          AND (blocked_reason IS NULL OR blocked_reason != 'WORKFLOW_VERSION_UNAVAILABLE')
        ORDER BY created_at ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      for (const run of runs) {
        await enqueueWorkflowRun(
          this.queue,
          {
            tenantId: run.tenantId,
            runId: run.id,
            workflowName: run.workflowName,
            workflowVersion: run.workflowVersion,
          },
          {
            jobId: `run_${run.id}`,
          }
        );
      }

      return runs.length;
    });
  }
}
