import { type PrismaClient, recordExecutionEvent } from "@durable/database";
import { createWorkflowQueue, enqueueWorkflowRun, type WorkflowRunJobData } from "@durable/worker";
import type { Queue } from "bullmq";
import type { ReconcilerOptions, ReconcilerStats } from "./types.js";

export class Reconciler {
  private db: PrismaClient;
  private queue: Queue<WorkflowRunJobData>;
  private ownsQueue: boolean;
  private pollIntervalMs: number;
  private batchSize: number;
  private tenantId?: string;
  private running: boolean = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isReconciling: boolean = false;

  constructor(options: ReconcilerOptions) {
    this.db = options.db;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 50;
    this.tenantId = options.tenantId;

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
      const dueRetriesReconciled = await this.reconcileDueRetries();
      const expiredLeasesReconciled = await this.reconcileExpiredLeases();
      return {
        pendingRunsReconciled,
        dueRetriesReconciled,
        expiredLeasesReconciled,
        blockedVersionsReconciled: 0,
      };
    } finally {
      this.isReconciling = false;
    }
  }

  async reconcilePendingRuns(): Promise<number> {
    const tenantFilter = this.tenantId ?? null;

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
          AND (${tenantFilter}::uuid IS NULL OR tenant_id = ${tenantFilter}::uuid)
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

  async reconcileDueRetries(): Promise<number> {
    const tenantFilter = this.tenantId ?? null;

    return await this.db.$transaction(async (tx) => {
      const steps = await tx.$queryRaw<
        Array<{
          id: string;
          attemptCount: number;
          workflowRunId: string;
          tenantId: string;
          workflowName: string;
          workflowVersion: string;
        }>
      >`
        SELECT 
          s.id,
          s.attempt_count AS "attemptCount",
          s.workflow_run_id AS "workflowRunId",
          r.tenant_id AS "tenantId",
          r.workflow_name AS "workflowName",
          r.workflow_version AS "workflowVersion"
        FROM step_executions s
        JOIN workflow_runs r ON s.workflow_run_id = r.id
        WHERE s.status = 'RETRY_WAIT'::"StepExecutionStatus"
          AND s.next_retry_at <= NOW()
          AND r.status NOT IN ('COMPLETED'::"WorkflowRunStatus", 'FAILED'::"WorkflowRunStatus", 'CANCELLED'::"WorkflowRunStatus")
          AND (${tenantFilter}::uuid IS NULL OR r.tenant_id = ${tenantFilter}::uuid)
        ORDER BY s.next_retry_at ASC
        LIMIT ${this.batchSize}
        FOR UPDATE OF s SKIP LOCKED
      `;

      for (const step of steps) {
        await enqueueWorkflowRun(
          this.queue,
          {
            tenantId: step.tenantId,
            runId: step.workflowRunId,
            workflowName: step.workflowName,
            workflowVersion: step.workflowVersion,
          },
          {
            jobId: `retry_${step.workflowRunId}_${step.id}_${step.attemptCount}`,
          }
        );
      }

      return steps.length;
    });
  }

  async reconcileExpiredLeases(): Promise<number> {
    const tenantFilter = this.tenantId ?? null;

    return await this.db.$transaction(async (tx) => {
      const attempts = await tx.$queryRaw<
        Array<{
          attemptId: string;
          attemptNumber: number;
          tenantId: string;
          stepExecutionId: string;
          attemptCount: number;
          retryLimit: number;
          workflowRunId: string;
          workflowName: string;
          workflowVersion: string;
        }>
      >`
        SELECT 
          a.id AS "attemptId",
          a.attempt_number AS "attemptNumber",
          a.tenant_id AS "tenantId",
          s.id AS "stepExecutionId",
          s.attempt_count AS "attemptCount",
          s.retry_limit AS "retryLimit",
          s.workflow_run_id AS "workflowRunId",
          r.workflow_name AS "workflowName",
          r.workflow_version AS "workflowVersion"
        FROM step_attempts a
        JOIN step_executions s ON a.step_execution_id = s.id
        JOIN workflow_runs r ON s.workflow_run_id = r.id
        WHERE a.status = 'RUNNING'::"StepAttemptStatus"
          AND a.lease_expires_at <= NOW()
          AND (${tenantFilter}::uuid IS NULL OR a.tenant_id = ${tenantFilter}::uuid)
        ORDER BY a.lease_expires_at ASC
        LIMIT ${this.batchSize}
        FOR UPDATE OF a, s SKIP LOCKED
      `;

      for (const attempt of attempts) {
        await tx.$executeRaw`
          UPDATE step_attempts
          SET status = 'ABANDONED'::"StepAttemptStatus",
              finished_at = NOW(),
              error_message = 'Lease expired without heartbeat'
          WHERE id = ${attempt.attemptId}::uuid
        `;

        await recordExecutionEvent(tx, {
          tenantId: attempt.tenantId,
          workflowRunId: attempt.workflowRunId,
          stepExecutionId: attempt.stepExecutionId,
          stepAttemptId: attempt.attemptId,
          eventType: "STEP_ATTEMPT_ABANDONED",
          payload: {
            attemptNumber: attempt.attemptNumber,
            reason: "Lease expired without heartbeat",
          },
        });

        let stepUpdated = 0;
        if (attempt.attemptCount < attempt.retryLimit) {
          stepUpdated = await tx.$executeRaw`
            UPDATE step_executions
            SET status = 'RETRY_WAIT'::"StepExecutionStatus",
                active_attempt_id = NULL,
                next_retry_at = NOW(),
                updated_at = NOW()
            WHERE id = ${attempt.stepExecutionId}::uuid
              AND active_attempt_id = ${attempt.attemptId}::uuid
          `;

          if (stepUpdated > 0) {
            await recordExecutionEvent(tx, {
              tenantId: attempt.tenantId,
              workflowRunId: attempt.workflowRunId,
              stepExecutionId: attempt.stepExecutionId,
              eventType: "STEP_RETRY_SCHEDULED",
              payload: {
                nextRetryAt: new Date().toISOString(),
                retryDelayMs: 0,
                reason: "Lease expired without heartbeat",
              },
            });
          }
        } else {
          const errorJson = JSON.stringify({ message: "Lease expired without heartbeat" });
          stepUpdated = await tx.$executeRaw`
            UPDATE step_executions
            SET status = 'FAILED'::"StepExecutionStatus",
                active_attempt_id = NULL,
                failed_at = NOW(),
                error = ${errorJson}::jsonb,
                updated_at = NOW()
            WHERE id = ${attempt.stepExecutionId}::uuid
              AND active_attempt_id = ${attempt.attemptId}::uuid
          `;

          if (stepUpdated > 0) {
            await recordExecutionEvent(tx, {
              tenantId: attempt.tenantId,
              workflowRunId: attempt.workflowRunId,
              stepExecutionId: attempt.stepExecutionId,
              eventType: "STEP_FAILED",
              payload: {
                error: "Lease expired without heartbeat",
              },
            });
          }
        }

        if (stepUpdated > 0) {
          await enqueueWorkflowRun(
            this.queue,
            {
              tenantId: attempt.tenantId,
              runId: attempt.workflowRunId,
              workflowName: attempt.workflowName,
              workflowVersion: attempt.workflowVersion,
            },
            {
              jobId: `retry_${attempt.workflowRunId}_${attempt.stepExecutionId}_${attempt.attemptCount}`,
            }
          );
        }
      }

      return attempts.length;
    });
  }
}
