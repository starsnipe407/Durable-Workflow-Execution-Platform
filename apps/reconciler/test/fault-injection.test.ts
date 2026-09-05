import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createPrismaClient, createWorkflowRun, type PrismaClient } from "@durable/database";
import { defineWorkflow } from "@durable/workflow-sdk";
import {
  WorkflowRegistry,
  WorkflowWorker,
  createWorkflowQueue,
  type WorkflowRunJobData,
} from "@durable/worker";
import type { Queue } from "bullmq";
import { Reconciler } from "../src/index.js";

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

describe("Reconciler - Fault Injection Resilience", () => {
  const db: PrismaClient = createPrismaClient(process.env.DATABASE_URL);
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
  let queue: Queue<WorkflowRunJobData>;
  let reconciler: Reconciler;
  let worker: WorkflowWorker | null = null;
  let registry: WorkflowRegistry;
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
    queue = createWorkflowQueue(redisUrl, "test-reconciler-fault-injection");
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
      data: {
        name: `tenant-fault-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      },
    });
    tenantId = tenant.id;

    registry = new WorkflowRegistry();

    reconciler = new Reconciler({
      db,
      queue,
      tenantId,
    });
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = null;
    }
    if (reconciler) {
      await reconciler.stop();
    }
    if (queue) {
      await queue.obliterate({ force: true });
    }
  });

  it("fully reconstructs BullMQ queue from PostgreSQL after complete Redis flush with zero data loss", async () => {
    const normalWorkflow = defineWorkflow(
      { name: "fault-flush-normal", version: "v1" },
      async ({ step, input }: { step: any; input: { val: number } }) => {
        const res = await step.run("compute", async () => input.val * 2);
        return { result: res };
      }
    );
    registry.register(normalWorkflow);

    const retryWorkflow = defineWorkflow(
      { name: "fault-flush-retry", version: "v1" },
      async ({ step, input }: { step: any; input: { msg: string } }) => {
        const r1 = await step.run("step-1", async () => `hello-${input.msg}`);
        const r2 = await step.run("step-2", async () => `${r1}-resumed`);
        return { result: r2 };
      }
    );
    registry.register(retryWorkflow);

    // 1. Create 3 runs in PENDING in PostgreSQL
    const run1 = await createWorkflowRun(db, {
      tenantId,
      workflowName: "fault-flush-normal",
      workflowVersion: "v1",
      input: { val: 1 },
    });
    const run2 = await createWorkflowRun(db, {
      tenantId,
      workflowName: "fault-flush-normal",
      workflowVersion: "v1",
      input: { val: 2 },
    });
    const run3 = await createWorkflowRun(db, {
      tenantId,
      workflowName: "fault-flush-normal",
      workflowVersion: "v1",
      input: { val: 3 },
    });

    // 2. Create 1 run with a step in RETRY_WAIT (nextRetryAt <= now)
    const run4 = await db.workflowRun.create({
      data: {
        tenantId,
        workflowName: "fault-flush-retry",
        workflowVersion: "v1",
        status: "RUNNING",
        input: { msg: "world" },
      },
    });

    const run4Step1 = await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run4.id,
        stepKey: "step-1",
        status: "COMPLETED",
        attemptCount: 1,
        retryLimit: 3,
        output: "hello-world",
        completedAt: new Date(),
      },
    });
    await db.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: run4Step1.id,
        attemptNumber: 1,
        status: "COMPLETED",
        workerId: "crashed-worker-old",
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(Date.now() - 4000),
      },
    });

    await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run4.id,
        stepKey: "step-2",
        status: "RETRY_WAIT",
        attemptCount: 1,
        retryLimit: 3,
        nextRetryAt: new Date(Date.now() - 1000),
      },
    });

    // 3. Obliterate Redis queue (simulates total Redis loss/flush)
    await queue.obliterate({ force: true });

    // 4. Assert queue is completely empty
    const counts = await queue.getJobCounts();
    const totalJobs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(totalJobs).toBe(0);

    // 5. Start WorkflowWorker with registered workflows
    worker = new WorkflowWorker({
      db,
      registry,
      queue,
      connectionOrUrl: redisUrl,
      workerId: "recovery-worker",
    });

    // 6. Run reconciler.reconcileOnce() scanning PostgreSQL
    const stats = await reconciler.reconcileOnce();
    expect(stats.pendingRunsReconciled).toBe(3);
    expect(stats.dueRetriesReconciled).toBe(1);

    // 7. Wait for all workflows to reach COMPLETED
    const completedRun1 = await waitForRunStatus(db, run1.id, "COMPLETED");
    const completedRun2 = await waitForRunStatus(db, run2.id, "COMPLETED");
    const completedRun3 = await waitForRunStatus(db, run3.id, "COMPLETED");
    const completedRun4 = await waitForRunStatus(db, run4.id, "COMPLETED");

    // 8. Assert all runs in PostgreSQL are COMPLETED with expected outputs and zero data loss
    expect(completedRun1.output).toEqual({ result: 2 });
    expect(completedRun2.output).toEqual({ result: 4 });
    expect(completedRun3.output).toEqual({ result: 6 });
    expect(completedRun4.output).toEqual({ result: "hello-world-resumed" });
  });

  it("atomically marks expired attempts ABANDONED after worker crash and retries to completion", async () => {
    const crashWorkflow = defineWorkflow(
      { name: "crash-recovery-wf", version: "v1" },
      async ({ step, input }: { step: any; input: { value: number } }) => {
        const s1 = await step.run("step-1", async () => input.value + 10);
        const s2 = await step.run("step-2", async () => s1 * 2);
        return { final: s2 };
      }
    );
    registry.register(crashWorkflow);

    // 1. Create run where step 1 completes, step 2 is claimed by "worker-crashed" as RUNNING
    const run = await db.workflowRun.create({
      data: {
        tenantId,
        workflowName: "crash-recovery-wf",
        workflowVersion: "v1",
        status: "RUNNING",
        input: { value: 5 },
      },
    });

    const step1 = await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run.id,
        stepKey: "step-1",
        status: "COMPLETED",
        attemptCount: 1,
        retryLimit: 3,
        output: 15,
        completedAt: new Date(Date.now() - 6000),
      },
    });
    await db.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step1.id,
        attemptNumber: 1,
        status: "COMPLETED",
        workerId: "worker-crashed",
        startedAt: new Date(Date.now() - 7000),
        finishedAt: new Date(Date.now() - 6000),
      },
    });

    const step2 = await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run.id,
        stepKey: "step-2",
        status: "RUNNING",
        attemptCount: 1,
        retryLimit: 3,
      },
    });

    // 2. Simulate worker crash by setting leaseExpiresAt to past (-1000ms)
    const attempt1 = await db.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step2.id,
        attemptNumber: 1,
        status: "RUNNING",
        workerId: "worker-crashed",
        startedAt: new Date(Date.now() - 5000),
        leaseExpiresAt: new Date(Date.now() - 1000), // Expired lease
      },
    });
    await db.stepExecution.update({
      where: { id: step2.id },
      data: { activeAttemptId: attempt1.id },
    });

    // 3. Start fresh WorkflowWorker
    worker = new WorkflowWorker({
      db,
      registry,
      queue,
      connectionOrUrl: redisUrl,
      workerId: "fresh-worker",
    });

    // 4. Run reconciler.reconcileOnce()
    const stats = await reconciler.reconcileOnce();
    expect(stats.expiredLeasesReconciled).toBe(1);

    // 5. Fresh worker picks up replay, step 1 returns memoized, attempt 2 of step 2 executes and completes
    const completedRun = await waitForRunStatus(db, run.id, "COMPLETED");
    expect(completedRun.output).toEqual({ final: 30 });

    // 6. Assert step 2 has 2 attempts (attempt 1 ABANDONED, attempt 2 COMPLETED)
    const attempts = await db.stepAttempt.findMany({
      where: { stepExecutionId: step2.id },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts).toHaveLength(2);

    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].status).toBe("ABANDONED");
    expect(attempts[0].workerId).toBe("worker-crashed");
    expect(attempts[0].errorMessage).toContain("Lease expired without heartbeat");
    expect(attempts[0].finishedAt).not.toBeNull();

    expect(attempts[1].attemptNumber).toBe(2);
    expect(attempts[1].status).toBe("COMPLETED");
    expect(attempts[1].workerId).toBe("fresh-worker");

    const updatedStep2 = await db.stepExecution.findUnique({
      where: { id: step2.id },
    });
    expect(updatedStep2?.status).toBe("COMPLETED");
    expect(updatedStep2?.attemptCount).toBe(2);
    expect(updatedStep2?.output).toBe(30);
  });
});
