import type { PrismaClient } from "@durable/database";
import { recordExecutionEvent } from "@durable/database";
import { StepContextImpl } from "./step-context.js";
import { WorkflowSuspendedError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

export interface WorkflowExecutorOptions {
  db: PrismaClient;
  workerId: string;
  leaseDurationMs?: number;
}

export class WorkflowExecutor {
  private readonly db: PrismaClient;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;

  constructor(options: WorkflowExecutorOptions) {
    this.db = options.db;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
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
    // Transition to RUNNING and record WORKFLOW_STARTED if PENDING
    if (run.status === "PENDING") {
      await this.db.$transaction(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: { status: "RUNNING", startedAt: now }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_STARTED",
          payload: { workerId: this.workerId, startedAt: now }
        });
      });
    }

    const seenKeys = new Set<string>();
    const stepContext = new StepContextImpl({
      db: this.db,
      tenantId: run.tenantId,
      workflowRunId: runId,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      seenKeys
    });

    try {
      const output = await workflow.handler({
        input: run.input as TInput,
        step: stepContext
      });

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

      return output;
    } catch (err) {
      if (err instanceof WorkflowSuspendedError) {
        // Workflow gracefully suspended waiting for retry/lock; do not mark run failed
        return undefined;
      }

      // Record failure on workflow run
      await this.db.$transaction(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            error: { message: (err as Error).message } as any,
            failedAt: new Date()
          }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_FAILED",
          payload: { error: (err as Error).message }
        });
      });

      throw err;
    }
  }
}
