import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrismaClient } from "../src/client.js";
import { createWorkflowRun } from "../src/repositories/workflow-repository.js";
import { claimStepAttempt, completeStepAttempt, renewAttemptLease } from "../src/repositories/step-repository.js";
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
});
