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
});

