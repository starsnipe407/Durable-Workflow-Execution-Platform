import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createPrismaClient, type PrismaClient } from "@durable/database";
import { createWorkflowQueue, type WorkflowRunJobData } from "@durable/worker";
import type { Queue } from "bullmq";
import { Reconciler } from "../src/index.js";

describe("Reconciler - Retries and Expired Leases", () => {
  const db: PrismaClient = createPrismaClient(process.env.DATABASE_URL);
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
  let queue: Queue<WorkflowRunJobData>;
  let reconciler: Reconciler;
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
    queue = createWorkflowQueue(redisUrl, "test-reconciler-retries-leases");
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
        name: `tenant-rl-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      },
    });
    tenantId = tenant.id;

    reconciler = new Reconciler({
      db,
      queue,
      tenantId,
    });
  });

  afterEach(async () => {
    if (reconciler) {
      await reconciler.stop();
    }
    if (queue) {
      await queue.obliterate({ force: true });
    }
  });

  it("reconciles due step retries by re-enqueuing replay jobs to BullMQ", async () => {
    const run = await db.workflowRun.create({
      data: {
        tenantId,
        workflowName: "retry-workflow",
        workflowVersion: "v1",
        status: "RUNNING",
        input: { test: true },
      },
    });

    const step = await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run.id,
        stepKey: "step-due-retry",
        status: "RETRY_WAIT",
        attemptCount: 1,
        retryLimit: 3,
        nextRetryAt: new Date(Date.now() - 1000), // Due in the past
      },
    });

    // Also create a step with nextRetryAt in the future that should NOT be reconciled yet
    const futureStep = await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run.id,
        stepKey: "step-future-retry",
        status: "RETRY_WAIT",
        attemptCount: 1,
        retryLimit: 3,
        nextRetryAt: new Date(Date.now() + 60000), // 1 min in the future
      },
    });

    const stats = await reconciler.reconcileOnce();
    expect(stats.dueRetriesReconciled).toBeGreaterThanOrEqual(1);

    // Verify replay job for due step
    const expectedJobId = `retry_${run.id}_${step.id}_${step.attemptCount}`;
    const job = await queue.getJob(expectedJobId);
    expect(job).toBeDefined();
    expect(job?.data).toEqual({
      runId: run.id,
      tenantId: run.tenantId,
      workflowName: run.workflowName,
      workflowVersion: run.workflowVersion,
    });

    // Future step should not be enqueued
    const futureJobId = `retry_${run.id}_${futureStep.id}_${futureStep.attemptCount}`;
    const futureJob = await queue.getJob(futureJobId);
    expect(futureJob).toBeUndefined();
  });

  it("reconciles expired attempt leases by marking ABANDONED and scheduling retry", async () => {
    const run = await db.workflowRun.create({
      data: {
        tenantId,
        workflowName: "abandon-workflow",
        workflowVersion: "v1",
        status: "RUNNING",
        input: {},
      },
    });

    const step = await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run.id,
        stepKey: "step-abandon",
        status: "RUNNING",
        attemptCount: 1,
        retryLimit: 3,
      },
    });

    const attempt = await db.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step.id,
        attemptNumber: 1,
        status: "RUNNING",
        workerId: "crashed-worker-1",
        startedAt: new Date(Date.now() - 5000),
        leaseExpiresAt: new Date(Date.now() - 1000), // Expired lease
      },
    });

    await db.stepExecution.update({
      where: { id: step.id },
      data: { activeAttemptId: attempt.id },
    });

    const stats = await reconciler.reconcileOnce();
    expect(stats.expiredLeasesReconciled).toBeGreaterThanOrEqual(1);

    // Verify attempt marked ABANDONED
    const updatedAttempt = await db.stepAttempt.findUnique({
      where: { id: attempt.id },
    });
    expect(updatedAttempt?.status).toBe("ABANDONED");
    expect(updatedAttempt?.finishedAt).not.toBeNull();
    expect(updatedAttempt?.errorMessage).toContain("Lease expired");

    // Verify execution event recorded
    const events = await db.executionEvent.findMany({
      where: { workflowRunId: run.id },
    });
    const abandonedEvent = events.find(
      (e) => e.eventType === "STEP_ATTEMPT_ABANDONED" || e.eventType === "STEP_ATTEMPT_FAILED"
    );
    expect(abandonedEvent).toBeDefined();

    // Verify step scheduled for retry
    const updatedStep = await db.stepExecution.findUnique({
      where: { id: step.id },
    });
    expect(updatedStep?.activeAttemptId).toBeNull();
    expect(updatedStep?.status).toBe("RETRY_WAIT");
    expect(updatedStep?.nextRetryAt).not.toBeNull();

    // Verify BullMQ replay job
    const expectedJobId = `retry_${run.id}_${step.id}_${step.attemptCount}`;
    const job = await queue.getJob(expectedJobId);
    expect(job).toBeDefined();
    expect(job?.data.runId).toBe(run.id);
  });

  it("marks attempt ABANDONED and transitions step to FAILED when retryLimit is exhausted", async () => {
    const run = await db.workflowRun.create({
      data: {
        tenantId,
        workflowName: "exhausted-workflow",
        workflowVersion: "v1",
        status: "RUNNING",
        input: {},
      },
    });

    const step = await db.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run.id,
        stepKey: "step-exhausted",
        status: "RUNNING",
        attemptCount: 3,
        retryLimit: 3,
      },
    });

    const attempt = await db.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step.id,
        attemptNumber: 3,
        status: "RUNNING",
        workerId: "crashed-worker-3",
        startedAt: new Date(Date.now() - 5000),
        leaseExpiresAt: new Date(Date.now() - 1000), // Expired lease
      },
    });

    await db.stepExecution.update({
      where: { id: step.id },
      data: { activeAttemptId: attempt.id },
    });

    const stats = await reconciler.reconcileOnce();
    expect(stats.expiredLeasesReconciled).toBeGreaterThanOrEqual(1);

    // Verify attempt marked ABANDONED
    const updatedAttempt = await db.stepAttempt.findUnique({
      where: { id: attempt.id },
    });
    expect(updatedAttempt?.status).toBe("ABANDONED");

    // Verify step marked FAILED
    const updatedStep = await db.stepExecution.findUnique({
      where: { id: step.id },
    });
    expect(updatedStep?.status).toBe("FAILED");
    expect(updatedStep?.failedAt).not.toBeNull();

    // Verify STEP_FAILED event recorded
    const events = await db.executionEvent.findMany({
      where: { workflowRunId: run.id },
    });
    const failedEvent = events.find((e) => e.eventType === "STEP_FAILED");
    expect(failedEvent).toBeDefined();

    // Verify replay job enqueued to resume/fail workflow
    const expectedJobId = `retry_${run.id}_${step.id}_${step.attemptCount}`;
    const job = await queue.getJob(expectedJobId);
    expect(job).toBeDefined();
  });
});
