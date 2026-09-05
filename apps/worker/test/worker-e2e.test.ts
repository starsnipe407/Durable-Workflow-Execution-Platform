import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Queue } from "bullmq";
import { createPrismaClient, createWorkflowRun, type PrismaClient } from "@durable/database";
import { defineWorkflow } from "@durable/workflow-sdk";
import {
  WorkflowRegistry,
  WorkflowWorker,
  createWorkflowQueue,
  enqueueWorkflowRun,
  type WorkflowRunJobData,
} from "../src/index.js";

async function waitForRunStatus(
  db: PrismaClient,
  runId: string,
  targetStatus: string,
  timeoutMs = 10000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await db.workflowRun.findUnique({ where: { id: runId } });
    if (run?.status === targetStatus) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for run ${runId} to reach status ${targetStatus}`);
}

describe("WorkflowWorker End-to-End", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
  let tenantId: string;
  let registry: WorkflowRegistry;
  let queue: Queue<WorkflowRunJobData>;
  let worker: WorkflowWorker;

  beforeAll(async () => {
    await db.$connect();
    queue = createWorkflowQueue(redisUrl, "workflow-e2e-runs");
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({
      data: { name: `e2e-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` },
    });
    tenantId = tenant.id;
    registry = new WorkflowRegistry();
    worker = new WorkflowWorker({
      db,
      registry,
      queue,
      connectionOrUrl: redisUrl,
      workerId: "e2e-worker",
    });
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
    }
    if (queue) {
      await queue.obliterate({ force: true });
    }
  });

  it("executes a multi-step workflow asynchronously via BullMQ job queue", async () => {
    const testWorkflow = defineWorkflow(
      { name: "e2e-parallel-wf", version: "v1" },
      async ({ step, input }: { step: any; input: { prefix: string } }) => {
        const [resA, resB] = await Promise.all([
          step.run("step-a", async () => `${input.prefix}-A`),
          step.run("step-b", async () => `${input.prefix}-B`),
        ]);
        const finalRes = await step.run("step-c", async () => `${resA}+${resB}`);
        return { result: finalRes };
      }
    );
    registry.register(testWorkflow);

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "e2e-parallel-wf",
      workflowVersion: "v1",
      input: { prefix: "test" },
    });

    await enqueueWorkflowRun(queue, {
      tenantId,
      runId: run.id,
      workflowName: "e2e-parallel-wf",
      workflowVersion: "v1",
    });

    const completedRun = await waitForRunStatus(db, run.id, "COMPLETED");
    expect(completedRun.output).toEqual({ result: "test-A+test-B" });

    const steps = await db.stepExecution.findMany({
      where: { workflowRunId: run.id },
      orderBy: { stepKey: "asc" },
    });
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => s.status === "COMPLETED")).toBe(true);
  });

  it("automatically schedules delayed replay and resumes after backoff elapses", async () => {
    let stepAttempts = 0;
    const retryWorkflow = defineWorkflow(
      { name: "e2e-retry-wf", version: "v1" },
      async ({ step }: { step: any }) => {
        const res = await step.run(
          "flaky-step",
          async () => {
            stepAttempts++;
            if (stepAttempts === 1) {
              throw new Error("Temporary network glitch");
            }
            return { recovered: true };
          },
          {
            retries: 1,
            backoff: { initialMs: 150, jitter: false },
          }
        );
        return res;
      }
    );
    registry.register(retryWorkflow);

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "e2e-retry-wf",
      workflowVersion: "v1",
      input: {},
    });

    await enqueueWorkflowRun(queue, {
      tenantId,
      runId: run.id,
      workflowName: "e2e-retry-wf",
      workflowVersion: "v1",
    });

    const completedRun = await waitForRunStatus(db, run.id, "COMPLETED");
    expect(completedRun.output).toEqual({ recovered: true });

    const step = await db.stepExecution.findFirst({
      where: { workflowRunId: run.id, stepKey: "flaky-step" },
    });
    expect(step?.status).toBe("COMPLETED");
    expect(step?.attemptCount).toBe(2);

    const events = await db.executionEvent.findMany({
      where: { workflowRunId: run.id },
      orderBy: { id: "asc" },
    });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("STEP_RETRY_SCHEDULED");
    expect(eventTypes).toContain("STEP_COMPLETED");
  });
});
