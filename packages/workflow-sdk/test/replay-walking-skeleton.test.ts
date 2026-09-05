import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { defineWorkflow } from "../src/workflow.js";
import { WorkflowExecutor } from "../src/executor.js";

describe("Replay Walking Skeleton Integration Test", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "replay-test-tenant" } });
    tenantId = tenant.id;
  });

  it("completes step 1, survives simulated worker crash, and replays step 1 from DB memoization before executing step 2", async () => {
    let step1CallCount = 0;
    let step2CallCount = 0;
    let shouldCrash = true;

    // Define 2-step workflow
    const testWorkflow = defineWorkflow<{ orderId: string }, { step1Done: boolean; step2Done: boolean }>(
      { name: "two-step-workflow", version: "v1" },
      async ({ input, step }) => {
        const res1 = await step.run("step-1", async () => {
          step1CallCount++;
          return { validated: true, id: input.orderId };
        });

        if (shouldCrash) {
          throw new Error("SIMULATED_WORKER_CRASH");
        }

        const res2 = await step.run("step-2", async () => {
          step2CallCount++;
          return { processed: true, fromStep1: res1.id };
        });

        return { step1Done: res1.validated, step2Done: res2.processed };
      }
    );

    // Create durable workflow run in DB
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "two-step-workflow",
      workflowVersion: "v1",
      input: { orderId: "ord_123" }
    });

    const executor1 = new WorkflowExecutor({ db, workerId: "worker-1", leaseDurationMs: 10_000 });

    // 1. Initial execution: runs Step 1, then crashes before Step 2
    await expect(executor1.execute(testWorkflow, run.id)).rejects.toThrow("SIMULATED_WORKER_CRASH");

    expect(step1CallCount).toBe(1);
    expect(step2CallCount).toBe(0);

    // Verify Step 1 is durably COMPLETED in PostgreSQL
    const step1Record = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "step-1" } }
    });
    expect(step1Record?.status).toBe("COMPLETED");
    expect(step1Record?.output).toEqual({ validated: true, id: "ord_123" });

    // 2. Worker recovery / Replay on Worker 2:
    shouldCrash = false;
    const executor2 = new WorkflowExecutor({ db, workerId: "worker-2", leaseDurationMs: 10_000 });

    const result = await executor2.execute(testWorkflow, run.id);

    // Assert Invariants:
    // - Step 1 handler was NOT re-executed (call count remains 1, read from DB memoization)
    expect(step1CallCount).toBe(1);
    // - Step 2 executed successfully (call count = 1)
    expect(step2CallCount).toBe(1);
    // - Workflow returned final output
    expect(result).toEqual({ step1Done: true, step2Done: true });

    // - Workflow run in DB is COMPLETED
    const finalRun = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(finalRun?.status).toBe("COMPLETED");
    expect(finalRun?.output).toEqual({ step1Done: true, step2Done: true });

    // - Verify execution events were recorded atomically
    const events = await db.executionEvent.findMany({
      where: { workflowRunId: run.id },
      orderBy: { id: "asc" }
    });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("WORKFLOW_CREATED");
    expect(eventTypes).toContain("WORKFLOW_STARTED");
    expect(eventTypes).toContain("STEP_STARTED");
    expect(eventTypes).toContain("STEP_COMPLETED");
    expect(eventTypes).toContain("WORKFLOW_COMPLETED");
  });
});
