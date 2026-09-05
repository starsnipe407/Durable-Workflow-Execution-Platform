import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { defineWorkflow } from "../src/workflow.js";
import { WorkflowExecutor } from "../src/executor.js";

describe("Parallel Step Execution and In-Flight Settlement", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "parallel-test-tenant" } });
    tenantId = tenant.id;
  });

  it("settles in-flight sibling steps before workflow suspension when one sibling fails early", async () => {
    const workflow = defineWorkflow<{ id: string }, { fast: string; slow: { data: string } }>(
      { name: "parallel-wf", version: "v1" },
      async ({ input: _input, step }) => {
        const [fast, slow] = await Promise.all([
          step.run(
            "sibling-fast",
            { retries: 1, backoff: { initialMs: 500, jitter: false } },
            async () => {
              throw new Error("FAST_FAILURE");
            }
          ),
          step.run("sibling-slow", async () => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            return { data: "slow-done" };
          })
        ]);
        return { fast, slow };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "parallel-wf",
      workflowVersion: "v1",
      input: { id: "test-parallel-1" }
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-parallel-1" });

    const result = await executor.execute(workflow, run.id);
    expect(result).toBeUndefined(); // suspended due to sibling-fast failure with retries remaining

    // Verify sibling-slow was NOT abandoned mid-flight: output must be persisted as COMPLETED
    const slowStepRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "sibling-slow" } }
    });

    expect(slowStepRecord).not.toBeNull();
    expect(slowStepRecord?.status).toBe("COMPLETED");
    expect(slowStepRecord?.output).toEqual({ data: "slow-done" });

    // Verify sibling-fast is in RETRY_WAIT
    const fastStepRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "sibling-fast" } }
    });
    expect(fastStepRecord?.status).toBe("RETRY_WAIT");
  });

  it("executes multiple parallel steps concurrently and reuses completed siblings on replay", async () => {
    let fastAttempts = 0;
    let slowExecutions = 0;

    const workflow = defineWorkflow<{ id: string }, { fast: string; slow: string }>(
      { name: "parallel-replay-wf", version: "v1" },
      async ({ input: _input, step }) => {
        const [fast, slow] = await Promise.all([
          step.run(
            "step-retry",
            { retries: 1, backoff: { initialMs: 100, jitter: false } },
            async () => {
              fastAttempts++;
              if (fastAttempts === 1) {
                throw new Error("FAIL_FIRST");
              }
              return "fast-success";
            }
          ),
          step.run("step-concurrent", async () => {
            slowExecutions++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return "slow-success";
          })
        ]);
        return { fast, slow };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "parallel-replay-wf",
      workflowVersion: "v1",
      input: { id: "test-parallel-2" }
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-parallel-2" });

    // First execution: step-retry fails attempt 1, step-concurrent completes, workflow suspends
    const result1 = await executor.execute(workflow, run.id);
    expect(result1).toBeUndefined();
    expect(fastAttempts).toBe(1);
    expect(slowExecutions).toBe(1);

    // Elapse nextRetryAt for step-retry
    const fastRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "step-retry" } }
    });
    await db.stepExecution.update({
      where: { id: fastRecord!.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) }
    });

    // Second execution (replay): step-concurrent returns memoized result (not re-executed), step-retry succeeds
    const result2 = await executor.execute(workflow, run.id);
    expect(result2).toEqual({ fast: "fast-success", slow: "slow-success" });
    expect(fastAttempts).toBe(2);
    expect(slowExecutions).toBe(1); // Not re-executed!

    const runRecord = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(runRecord?.status).toBe("COMPLETED");
  });

  it("guarantees sibling isolation, preserves attempt records, and logs complete event stream across replays", async () => {
    let alphaCallCount = 0;
    let betaCallCount = 0;

    const workflow = defineWorkflow<
      { id: string },
      { alpha: { result: string }; beta: { result: string } }
    >(
      { name: "sibling-isolation-wf", version: "v1" },
      async ({ input: _input, step }) => {
        const [alpha, beta] = await Promise.all([
          step.run("sibling-alpha", async () => {
            alphaCallCount++;
            return { result: "alpha-ok" };
          }),
          step.run(
            "sibling-beta",
            { retries: 1, backoff: { initialMs: 1000, jitter: false } },
            async () => {
              betaCallCount++;
              if (betaCallCount === 1) {
                throw new Error("BETA_FAIL");
              }
              return { result: "beta-ok" };
            }
          )
        ]);
        return { alpha, beta };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "sibling-isolation-wf",
      workflowVersion: "v1",
      input: { id: "test-isolation-1" }
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-isolation-1" });

    // 1. First execution: sibling-alpha succeeds, sibling-beta fails attempt 1, workflow suspends
    const result1 = await executor.execute(workflow, run.id);
    expect(result1).toBeUndefined();
    expect(alphaCallCount).toBe(1);
    expect(betaCallCount).toBe(1);

    // Sibling-alpha step execution
    const alphaStepRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "sibling-alpha" } }
    });
    expect(alphaStepRecord).not.toBeNull();
    expect(alphaStepRecord?.status).toBe("COMPLETED");
    expect(alphaStepRecord?.attemptCount).toBe(1);
    expect(alphaStepRecord?.output).toEqual({ result: "alpha-ok" });

    // Sibling-beta step execution
    const betaStepRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "sibling-beta" } }
    });
    expect(betaStepRecord).not.toBeNull();
    expect(betaStepRecord?.status).toBe("RETRY_WAIT");
    expect(betaStepRecord?.attemptCount).toBe(1);
    expect((betaStepRecord?.error as any)?.message).toBe("BETA_FAIL");

    // Sibling-beta attempt history
    const betaAttempts = await db.stepAttempt.findMany({
      where: { stepExecutionId: betaStepRecord!.id },
      orderBy: { attemptNumber: "asc" }
    });
    expect(betaAttempts).toHaveLength(1);
    expect(betaAttempts[0]?.status).toBe("FAILED");
    expect(betaAttempts[0]?.attemptNumber).toBe(1);
    expect(betaAttempts[0]?.errorMessage).toBe("BETA_FAIL");

    // 2. Premature replay (before backoff elapses)
    const resultPremature = await executor.execute(workflow, run.id);
    expect(resultPremature).toBeUndefined();
    expect(alphaCallCount).toBe(1);
    expect(betaCallCount).toBe(1);

    // 3. Fast-forward backoff & Replay
    await db.stepExecution.update({
      where: { id: betaStepRecord!.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) }
    });

    const resultFinal = await executor.execute(workflow, run.id);
    expect(resultFinal).toEqual({
      alpha: { result: "alpha-ok" },
      beta: { result: "beta-ok" }
    });
    expect(alphaCallCount).toBe(1); // Memoized, NEVER re-executed
    expect(betaCallCount).toBe(2);

    // Sibling-beta completed after retry
    const finalBetaRecord = await db.stepExecution.findUnique({
      where: { id: betaStepRecord!.id }
    });
    expect(finalBetaRecord?.status).toBe("COMPLETED");
    expect(finalBetaRecord?.attemptCount).toBe(2);
    expect(finalBetaRecord?.output).toEqual({ result: "beta-ok" });

    // Workflow completed
    const finalRun = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(finalRun?.status).toBe("COMPLETED");
    expect(finalRun?.output).toEqual({
      alpha: { result: "alpha-ok" },
      beta: { result: "beta-ok" }
    });

    // 4. Execution events audit trail verification
    const events = await db.executionEvent.findMany({
      where: { workflowRunId: run.id },
      orderBy: { id: "asc" }
    });
    const eventTypes = events.map((e) => e.eventType);

    expect(eventTypes).toContain("WORKFLOW_STARTED");
    expect(eventTypes).toContain("STEP_STARTED");
    expect(eventTypes).toContain("STEP_COMPLETED");
    expect(eventTypes).toContain("STEP_ATTEMPT_FAILED");
    expect(eventTypes).toContain("STEP_RETRY_SCHEDULED");
    expect(eventTypes).toContain("WORKFLOW_COMPLETED");

    // Sibling-alpha started and completed events
    const alphaStarted = events.filter(
      (e) => e.eventType === "STEP_STARTED" && (e.payload as any)?.stepKey === "sibling-alpha"
    );
    expect(alphaStarted).toHaveLength(1);

    const alphaCompleted = events.filter(
      (e) => e.eventType === "STEP_COMPLETED" && e.stepExecutionId === alphaStepRecord!.id
    );
    expect(alphaCompleted).toHaveLength(1);

    // Sibling-beta lifecycle events: attempt 1 started, failed, retry scheduled, attempt 2 started, completed
    const betaStarted = events.filter(
      (e) => e.eventType === "STEP_STARTED" && (e.payload as any)?.stepKey === "sibling-beta"
    );
    expect(betaStarted).toHaveLength(2);

    const betaAttemptFailed = events.filter(
      (e) => e.eventType === "STEP_ATTEMPT_FAILED" && e.stepExecutionId === betaStepRecord!.id
    );
    expect(betaAttemptFailed).toHaveLength(1);

    const betaRetryScheduled = events.filter(
      (e) => e.eventType === "STEP_RETRY_SCHEDULED" && e.stepExecutionId === betaStepRecord!.id
    );
    expect(betaRetryScheduled).toHaveLength(1);

    const betaCompleted = events.filter(
      (e) => e.eventType === "STEP_COMPLETED" && e.stepExecutionId === betaStepRecord!.id
    );
    expect(betaCompleted).toHaveLength(1);
  });
});


