import type { PrismaClient } from "@prisma/client";
import { StaleAttemptError } from "../errors.js";
import { recordExecutionEvent } from "./execution-events.js";
import type {
  ClaimStepAttemptParams,
  ClaimStepAttemptResult,
  CompleteStepAttemptParams,
  FailStepAttemptParams,
  RenewAttemptLeaseParams
} from "../types.js";

export async function claimStepAttempt(
  db: PrismaClient,
  params: ClaimStepAttemptParams
): Promise<ClaimStepAttemptResult> {
  const { tenantId, workflowRunId, stepKey, workerId, leaseDurationMs } = params;

  return await db.$transaction(async (tx) => {
    // 1. Lock and fetch step_execution if exists
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        output: unknown;
        error: unknown;
        attempt_count: number;
        active_attempt_id: string | null;
        next_retry_at: Date | null;
        lease_expires_at: Date | null;
      }>
    >`
      SELECT s.id, s.status, s.output, s.error, s.attempt_count, s.active_attempt_id, s.next_retry_at, a.lease_expires_at
      FROM step_executions s
      LEFT JOIN step_attempts a ON a.id = s.active_attempt_id
      WHERE s.workflow_run_id = ${workflowRunId}::uuid AND s.step_key = ${stepKey}
      FOR UPDATE OF s
    `;

    const existing = rows[0];

    // If already COMPLETED, return memoized result immediately
    if (existing && existing.status === "COMPLETED") {
      return { status: "COMPLETED", output: existing.output };
    }

    const now = new Date();

    // Check if step is in RETRY_WAIT and delay has not elapsed
    if (existing && existing.status === "RETRY_WAIT" && existing.next_retry_at && new Date(existing.next_retry_at) > now) {
      return {
        status: "RETRY_WAIT",
        nextRetryAt: new Date(existing.next_retry_at),
        error: existing.error ?? undefined
      };
    }

    // Check if active lease is still valid
    if (existing && existing.status === "RUNNING" && existing.active_attempt_id && existing.lease_expires_at && existing.lease_expires_at > now) {
      return {
        status: "LOCKED",
        activeAttemptId: existing.active_attempt_id,
        leaseExpiresAt: existing.lease_expires_at
      };
    }

    const newAttemptNumber = (existing?.attempt_count ?? 0) + 1;
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    // Create or update step_execution
    let stepExecutionId: string;
    if (!existing) {
      const created = await tx.stepExecution.create({
        data: {
          tenantId,
          workflowRunId,
          stepKey,
          status: "RUNNING",
          attemptCount: 1,
          startedAt: now
        }
      });
      stepExecutionId = created.id;
    } else {
      stepExecutionId = existing.id;
    }

    // Insert new step_attempt
    const attempt = await tx.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId,
        attemptNumber: newAttemptNumber,
        status: "RUNNING",
        workerId,
        startedAt: now,
        heartbeatAt: now,
        leaseExpiresAt
      }
    });

    // Update active_attempt_id (and advance attempt count/status if existing)
    if (existing) {
      await tx.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "RUNNING",
          attemptCount: newAttemptNumber,
          activeAttemptId: attempt.id,
          startedAt: existing.attempt_count === 0 ? now : undefined
        }
      });
    } else {
      await tx.stepExecution.update({
        where: { id: stepExecutionId },
        data: { activeAttemptId: attempt.id }
      });
    }

    // Append STEP_STARTED durable execution event
    await recordExecutionEvent(tx, {
      tenantId,
      workflowRunId,
      stepExecutionId,
      stepAttemptId: attempt.id,
      eventType: "STEP_STARTED",
      payload: { stepKey, attemptNumber: newAttemptNumber, workerId }
    });

    return {
      status: "RUNNING",
      attemptId: attempt.id,
      attemptNumber: newAttemptNumber,
      stepExecutionId
    };
  });
}

export async function completeStepAttempt(
  db: PrismaClient,
  params: CompleteStepAttemptParams
): Promise<void> {
  const { tenantId, workflowRunId, stepExecutionId, attemptId, output } = params;

  await db.$transaction(async (tx) => {
    const outputJson = JSON.stringify(output === undefined ? null : output);

    // Fenced conditional update: only succeeds if active_attempt_id matches attemptId
    const updatedCount = await tx.$executeRaw`
      UPDATE step_executions
      SET status = 'COMPLETED',
          output = ${outputJson}::jsonb,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${stepExecutionId}::uuid
        AND active_attempt_id = ${attemptId}::uuid
        AND tenant_id = ${tenantId}::uuid
    `;

    if (updatedCount === 0) {
      throw new StaleAttemptError();
    }

    // Update attempt record
    await tx.stepAttempt.update({
      where: { id: attemptId },
      data: {
        status: "COMPLETED",
        finishedAt: new Date()
      }
    });

    // Append STEP_COMPLETED event
    await recordExecutionEvent(tx, {
      tenantId,
      workflowRunId,
      stepExecutionId,
      stepAttemptId: attemptId,
      eventType: "STEP_COMPLETED",
      payload: { output }
    });
  });
}

export async function renewAttemptLease(
  db: PrismaClient,
  params: RenewAttemptLeaseParams
): Promise<void> {
  const { attemptId, additionalMs } = params;
  const now = new Date();
  const newLease = new Date(now.getTime() + additionalMs);

  await db.stepAttempt.update({
    where: { id: attemptId },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: newLease
    }
  });
}

export async function failStepAttempt(
  db: PrismaClient,
  params: FailStepAttemptParams
): Promise<void> {
  const {
    tenantId,
    workflowRunId,
    stepExecutionId,
    attemptId,
    error,
    timedOut = false,
    retryDelayMs = null,
    nextRetryAt = null,
    isTerminalFailure
  } = params;

  await db.$transaction(async (tx) => {
    // 1. Update attempt record
    await tx.stepAttempt.update({
      where: { id: attemptId },
      data: {
        status: timedOut ? "TIMED_OUT" : "FAILED",
        errorMessage: error.message,
        errorType: error.type ?? (timedOut ? "TimeoutError" : "Error"),
        errorMetadata: (error.metadata ?? {}) as any,
        retryDelayMs,
        timedOut,
        finishedAt: new Date()
      }
    });

    // 2. Record STEP_ATTEMPT_FAILED event
    await recordExecutionEvent(tx, {
      tenantId,
      workflowRunId,
      stepExecutionId,
      stepAttemptId: attemptId,
      eventType: "STEP_ATTEMPT_FAILED",
      payload: { error: error.message, timedOut, retryDelayMs }
    });

    // 3. Update step_executions
    if (isTerminalFailure) {
      await tx.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "FAILED",
          error: error as any,
          failedAt: new Date()
        }
      });

      await recordExecutionEvent(tx, {
        tenantId,
        workflowRunId,
        stepExecutionId,
        eventType: "STEP_FAILED",
        payload: { error: error.message }
      });
    } else {
      await tx.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "RETRY_WAIT",
          nextRetryAt,
          error: error as any
        }
      });

      await recordExecutionEvent(tx, {
        tenantId,
        workflowRunId,
        stepExecutionId,
        eventType: "STEP_RETRY_SCHEDULED",
        payload: {
          nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
          retryDelayMs
        }
      });
    }
  });
}
