import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { defineWorkflow } from "../src/workflow.js";
import { WorkflowExecutor } from "../src/executor.js";

describe("Step Retries, Backoff, and Timeouts", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "retry-test-tenant" } });
    tenantId = tenant.id;
  });

  it("retries a failing step with backoff, then succeeds on subsequent replay", async () => {
    let attemptCount = 0;
    const workflow = defineWorkflow<{ id: string }, { done: boolean }>(
      { name: "retry-wf", version: "v1" },
      async ({ input: _input, step }) => {
        await step.run(
          "flaky-step",
          { retries: 2, backoff: { initialMs: 100, jitter: false } },
          async () => {
            attemptCount++;
            if (attemptCount === 1) {
              throw new Error("TEMPORARY_NETWORK_FAILURE");
            }
            return "success";
          }
        );
        return { done: true };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "retry-wf",
      workflowVersion: "v1",
      input: { id: "test-1" }
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-1" });

    // Execution 1: fails attempt 1, transitions step to RETRY_WAIT, suspends workflow
    const result1 = await executor.execute(workflow, run.id);
    expect(result1).toBeUndefined();
    expect(attemptCount).toBe(1);

    const stepRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "flaky-step" } }
    });
    expect(stepRecord?.status).toBe("RETRY_WAIT");
    expect(stepRecord?.attemptCount).toBe(1);

    // Fast-forward nextRetryAt to simulate time elapsed
    await db.stepExecution.update({
      where: { id: stepRecord!.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) }
    });

    // Execution 2: due retry executes attempt 2 and succeeds
    const result2 = await executor.execute(workflow, run.id);
    expect(result2).toEqual({ done: true });
    expect(attemptCount).toBe(2);

    const finalStep = await db.stepExecution.findUnique({
      where: { id: stepRecord!.id }
    });
    expect(finalStep?.status).toBe("COMPLETED");
  });

  it("aborts handler when timeoutMs is exceeded and marks attempt TIMED_OUT", async () => {
    const workflow = defineWorkflow<{ id: string }, { done: boolean }>(
      { name: "timeout-wf", version: "v1" },
      async ({ input: _input, step }) => {
        await step.run(
          "slow-step",
          { retries: 0, timeoutMs: 50 },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return "ok";
          }
        );
        return { done: true };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "timeout-wf",
      workflowVersion: "v1",
      input: { id: "test-timeout" }
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-1" });

    // Should fail because retries: 0 and timeout exceeded
    await expect(executor.execute(workflow, run.id)).rejects.toThrow();

    const attempt = await db.stepAttempt.findFirst({
      where: { tenantId, stepExecution: { stepKey: "slow-step" } }
    });
    expect(attempt?.status).toBe("TIMED_OUT");
    expect(attempt?.timedOut).toBe(true);
  });
});
