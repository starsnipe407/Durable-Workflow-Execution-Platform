import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { defineWorkflow } from "@durable/workflow-sdk";
import { WorkflowRegistry, WorkflowWorker } from "../src/index.js";

describe("WorkflowRegistry", () => {
  it("registers and retrieves workflow definitions by name and version", () => {
    const registry = new WorkflowRegistry();
    const wf = defineWorkflow(
      { name: "test-wf", version: "v1" },
      async () => "success"
    );

    registry.register(wf);

    expect(registry.get("test-wf", "v1")).toBe(wf);
    expect(registry.get("test-wf", "v2")).toBeUndefined();
    expect(registry.get("other-wf", "v1")).toBeUndefined();
  });
});

describe("WorkflowWorker Routing", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;
  let worker: WorkflowWorker;
  let registry: WorkflowRegistry;

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({
      data: { name: `routing-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` },
    });
    tenantId = tenant.id;
    registry = new WorkflowRegistry();
    worker = new WorkflowWorker({
      db,
      registry,
      workerId: "test-worker",
    });
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
    }
  });

  it("Terminal run no-op: if a run is already COMPLETED, CANCELLED, or FAILED, does not run workflow or modify run", async () => {
    let executionCount = 0;
    const testWorkflow = defineWorkflow(
      { name: "terminal-wf", version: "v1" },
      async ({ step }) => {
        return await step.run("step-1", async () => {
          executionCount++;
          return { done: true };
        });
      }
    );
    registry.register(testWorkflow);

    // Case 1: COMPLETED run
    const completedRun = await createWorkflowRun(db, {
      tenantId,
      workflowName: "terminal-wf",
      workflowVersion: "v1",
      input: { initial: "data" },
    });
    await db.workflowRun.update({
      where: { id: completedRun.id },
      data: {
        status: "COMPLETED",
        output: { original: true },
        completedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    await worker.processJob({
      data: {
        tenantId,
        runId: completedRun.id,
        workflowName: "terminal-wf",
        workflowVersion: "v1",
      },
    } as any);

    expect(executionCount).toBe(0);
    const runAfterCompleted = await db.workflowRun.findUnique({
      where: { id: completedRun.id },
    });
    expect(runAfterCompleted?.status).toBe("COMPLETED");
    expect(runAfterCompleted?.output).toEqual({ original: true });

    // Case 2: CANCELLED run
    const cancelledRun = await createWorkflowRun(db, {
      tenantId,
      workflowName: "terminal-wf",
      workflowVersion: "v1",
      input: { initial: "data" },
    });
    await db.workflowRun.update({
      where: { id: cancelledRun.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    await worker.processJob({
      data: {
        tenantId,
        runId: cancelledRun.id,
        workflowName: "terminal-wf",
        workflowVersion: "v1",
      },
    } as any);

    expect(executionCount).toBe(0);
    const runAfterCancelled = await db.workflowRun.findUnique({
      where: { id: cancelledRun.id },
    });
    expect(runAfterCancelled?.status).toBe("CANCELLED");

    // Case 3: FAILED run
    const failedRun = await createWorkflowRun(db, {
      tenantId,
      workflowName: "terminal-wf",
      workflowVersion: "v1",
      input: { initial: "data" },
    });
    await db.workflowRun.update({
      where: { id: failedRun.id },
      data: {
        status: "FAILED",
        failedAt: new Date("2026-01-01T00:00:00Z"),
        error: { message: "Original failure" },
      },
    });

    await worker.processJob({
      data: {
        tenantId,
        runId: failedRun.id,
        workflowName: "terminal-wf",
        workflowVersion: "v1",
      },
    } as any);

    expect(executionCount).toBe(0);
    const runAfterFailed = await db.workflowRun.findUnique({
      where: { id: failedRun.id },
    });
    expect(runAfterFailed?.status).toBe("FAILED");
    expect(runAfterFailed?.error).toEqual({ message: "Original failure" });
  });

  it("Missing workflow version: sets status=PENDING, blockedReason=WORKFLOW_VERSION_UNAVAILABLE and records execution event without throwing", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "wf-1",
      workflowVersion: "v99",
      input: { orderId: "123" },
    });

    expect(registry.get("wf-1", "v99")).toBeUndefined();

    await expect(
      worker.processJob({
        data: {
          tenantId,
          runId: run.id,
          workflowName: "wf-1",
          workflowVersion: "v99",
        },
      } as any)
    ).resolves.not.toThrow();

    const updatedRun = await db.workflowRun.findUnique({
      where: { id: run.id },
    });
    expect(updatedRun?.status).toBe("PENDING");
    expect(updatedRun?.blockedReason).toBe("WORKFLOW_VERSION_UNAVAILABLE");

    const events = await db.executionEvent.findMany({
      where: {
        workflowRunId: run.id,
        eventType: "WORKFLOW_VERSION_UNAVAILABLE",
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      workflowName: "wf-1",
      workflowVersion: "v99",
    });
  });

  it("Version resolution & execution: clears previous blockedReason and executes workflow to COMPLETED", async () => {
    let executed = false;
    const testWorkflow = defineWorkflow(
      { name: "wf-1", version: "v1" },
      async ({ step }) => {
        return await step.run("step-1", async () => {
          executed = true;
          return { resolved: true, value: 42 };
        });
      }
    );
    registry.register(testWorkflow);

    // Run previously blocked due to missing version
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "wf-1",
      workflowVersion: "v1",
      input: {},
    });
    await db.workflowRun.update({
      where: { id: run.id },
      data: {
        status: "PENDING",
        blockedReason: "WORKFLOW_VERSION_UNAVAILABLE",
      },
    });

    await worker.processJob({
      data: {
        tenantId,
        runId: run.id,
        workflowName: "wf-1",
        workflowVersion: "v1",
      },
    } as any);

    expect(executed).toBe(true);

    const finalRun = await db.workflowRun.findUnique({
      where: { id: run.id },
    });
    expect(finalRun?.status).toBe("COMPLETED");
    expect(finalRun?.blockedReason).toBeNull();
    expect(finalRun?.output).toEqual({ resolved: true, value: 42 });

    const events = await db.executionEvent.findMany({
      where: { workflowRunId: run.id },
      orderBy: { id: "asc" },
    });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("WORKFLOW_STARTED");
    expect(eventTypes).toContain("STEP_COMPLETED");
    expect(eventTypes).toContain("WORKFLOW_COMPLETED");
  });
});
