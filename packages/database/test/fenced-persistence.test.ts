import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrismaClient } from "../src/client.js";
import { createWorkflowRun } from "../src/repositories/workflow-repository.js";
import { claimStepAttempt, completeStepAttempt, renewAttemptLease, failStepAttempt } from "../src/index.js";
import { StaleAttemptError } from "../src/errors.js";

describe("Fenced Step Persistence", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "test-tenant" } });
    tenantId = tenant.id;
  });

  it("claims an attempt, renews lease, and commits completion", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "test-wf",
      workflowVersion: "v1",
      input: { test: true }
    });

    const claim = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-1",
      workerId: "worker-a",
      leaseDurationMs: 10_000
    });

    expect(claim.status).toBe("RUNNING");
    if (claim.status !== "RUNNING") return;

    await renewAttemptLease(db, {
      attemptId: claim.attemptId,
      additionalMs: 5_000
    });

    await completeStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepExecutionId: claim.stepExecutionId,
      attemptId: claim.attemptId,
      output: { result: 42 }
    });

    // Second claim must return memoized result immediately
    const memoClaim = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-1",
      workerId: "worker-b",
      leaseDurationMs: 10_000
    });

    expect(memoClaim.status).toBe("COMPLETED");
    if (memoClaim.status === "COMPLETED") {
      expect(memoClaim.output).toEqual({ result: 42 });
    }
  });

  it("fences out a stale attempt commit when active_attempt_id has changed", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "test-wf",
      workflowVersion: "v1",
      input: {}
    });

    const claim1 = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fenced",
      workerId: "worker-a",
      leaseDurationMs: 10_000
    });
    if (claim1.status !== "RUNNING") throw new Error("claim1 failed");

    // Simulate lease expiry and reassignment to Worker B
    await db.stepAttempt.update({
      where: { id: claim1.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) }
    });

    const claim2 = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fenced",
      workerId: "worker-b",
      leaseDurationMs: 10_000
    });
    if (claim2.status !== "RUNNING") throw new Error("claim2 failed");

    // Worker A wakes up and attempts to complete -> MUST throw StaleAttemptError
    await expect(
      completeStepAttempt(db, {
        tenantId,
        workflowRunId: run.id,
        stepExecutionId: claim1.stepExecutionId,
        attemptId: claim1.attemptId,
        output: { result: "stale-A" }
      })
    ).rejects.toThrow(StaleAttemptError);
  });

  it("records step attempt failure and transitions to RETRY_WAIT", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "fail-wf",
      workflowVersion: "v1",
      input: {}
    });

    const claim = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fail",
      workerId: "worker-1",
      leaseDurationMs: 10_000
    });
    if (claim.status !== "RUNNING") throw new Error("claim failed");

    const nextRetryAt = new Date(Date.now() + 5000);
    await failStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepExecutionId: claim.stepExecutionId,
      attemptId: claim.attemptId,
      error: { message: "Simulated failure" },
      retryDelayMs: 5000,
      nextRetryAt,
      isTerminalFailure: false
    });

    const retryClaim = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fail",
      workerId: "worker-1",
      leaseDurationMs: 10_000
    });
    expect(retryClaim.status).toBe("RETRY_WAIT");
  });

  it("records terminal step attempt failure and transitions to FAILED", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "fail-wf-terminal",
      workflowVersion: "v1",
      input: {}
    });

    const claim = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-term-fail",
      workerId: "worker-1",
      leaseDurationMs: 10_000
    });
    if (claim.status !== "RUNNING") throw new Error("claim failed");

    await failStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepExecutionId: claim.stepExecutionId,
      attemptId: claim.attemptId,
      error: { message: "Fatal error" },
      isTerminalFailure: true
    });

    const step = await db.stepExecution.findUnique({
      where: { id: claim.stepExecutionId }
    });
    expect(step?.status).toBe("FAILED");
    expect(step?.failedAt).not.toBeNull();

    const attempt = await db.stepAttempt.findUnique({
      where: { id: claim.attemptId }
    });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.errorMessage).toBe("Fatal error");
  });

  it("rejects failStepAttempt from a stale worker when active_attempt_id has changed", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "fail-fenced-wf",
      workflowVersion: "v1",
      input: {}
    });

    const claim1 = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fail-fenced",
      workerId: "worker-a",
      leaseDurationMs: 10_000
    });
    if (claim1.status !== "RUNNING") throw new Error("claim1 failed");

    // Expire Worker A lease
    await db.stepAttempt.update({
      where: { id: claim1.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) }
    });

    // Worker B claims attempt 2
    const claim2 = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fail-fenced",
      workerId: "worker-b",
      leaseDurationMs: 10_000
    });
    if (claim2.status !== "RUNNING") throw new Error("claim2 failed");

    // Worker A wakes up and attempts to report failure -> MUST throw StaleAttemptError
    await expect(
      failStepAttempt(db, {
        tenantId,
        workflowRunId: run.id,
        stepExecutionId: claim1.stepExecutionId,
        attemptId: claim1.attemptId,
        error: { message: "Late failure from worker A" },
        isTerminalFailure: true
      })
    ).rejects.toThrow(StaleAttemptError);

    // Verify step_execution is still active under Worker B (attempt 2) and NOT failed
    const step = await db.stepExecution.findUnique({
      where: { id: claim1.stepExecutionId }
    });
    expect(step?.status).toBe("RUNNING");
    expect(step?.activeAttemptId).toBe(claim2.attemptId);
  });
});

