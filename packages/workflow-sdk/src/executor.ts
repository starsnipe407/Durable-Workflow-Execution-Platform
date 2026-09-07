import type { PrismaClient } from "@durable/database";
import { recordExecutionEvent } from "@durable/database";
import { StepContextImpl } from "./step-context.js";
import { WorkflowSuspendedError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

export interface WorkflowExecutorOptions {
  db: PrismaClient;
  workerId: string;
  leaseDurationMs?: number;
  onEvent?: (runId: string) => Promise<void> | void;
}

export class WorkflowExecutor {
  private readonly db: PrismaClient;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly onEvent?: (runId: string) => Promise<void> | void;

  constructor(options: WorkflowExecutorOptions) {
    this.db = options.db;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.onEvent = options.onEvent;
  }

  async execute<TInput, TOutput>(
    workflow: WorkflowDefinition<TInput, TOutput>,
    runId: string
  ): Promise<TOutput | undefined> {
    const run = await this.db.workflowRun.findUnique({
      where: { id: runId }
    });

    if (!run) {
      throw new Error(`Workflow run ${runId} not found.`);
    }

    if (run.status === "COMPLETED" || run.status === "CANCELLED") {
      return run.output as TOutput;
    }

    const now = new Date();
    // Transition to RUNNING and record WORKFLOW_STARTED if PENDING or FAILED
    if (run.status === "PENDING" || run.status === "FAILED") {
      await this.db.$transaction(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: { status: "RUNNING", startedAt: now, blockedReason: null }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_STARTED",
          payload: { workerId: this.workerId, startedAt: now }
        });
      });
      await this.triggerEvent(runId);
    }

    const seenKeys = new Set<string>();
    const stepContext = new StepContextImpl({
      db: this.db,
      tenantId: run.tenantId,
      workflowRunId: runId,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      seenKeys,
      onEvent: this.onEvent
    });

    try {
      const output = await workflow.handler({
        input: run.input as TInput,
        step: stepContext
      });

      await stepContext.settleInFlight();

      // Mark workflow COMPLETED and record event
      await this.db.$transaction(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: {
            status: "COMPLETED",
            output: output as any,
            completedAt: new Date()
          }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_COMPLETED",
          payload: { output }
        });
      });
      await this.triggerEvent(runId);

      return output;
    } catch (err) {
      await stepContext.settleInFlight();

      if (err instanceof WorkflowSuspendedError) {
        // Workflow gracefully suspended waiting for retry/lock; do not mark run failed
        return undefined;
      }

      if ((err as any)?.name === "StaleAttemptError") {
        // Fenced out by transactional fence; do not corrupt authoritative workflow run state
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Record failure on workflow run
      await this.db.$transaction(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            error: { message: errorMessage } as any,
            failedAt: new Date()
          }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_FAILED",
          payload: { error: errorMessage }
        });
      });
      await this.triggerEvent(runId);

      throw err;
    }
  }

  private async triggerEvent(runId: string): Promise<void> {
    try {
      await this.onEvent?.(runId);
    } catch {
      // Best-effort notification: errors must not disrupt durable workflow execution
    }
  }
}
