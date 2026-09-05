import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createPrismaClient, createWorkflowRun, type PrismaClient } from "@durable/database";
import { createWorkflowQueue, type WorkflowRunJobData } from "@durable/worker";
import type { Queue } from "bullmq";
import { Reconciler } from "../src/index.js";

describe("Reconciler - Pending Runs", () => {
  const db: PrismaClient = createPrismaClient(process.env.DATABASE_URL);
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
  let queue: Queue<WorkflowRunJobData>;
  let reconciler: Reconciler;
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
    queue = createWorkflowQueue(redisUrl, "test-reconciler-pending");
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
        name: `tenant-rec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      },
    });
    tenantId = tenant.id;

    reconciler = new Reconciler({
      db,
      queue,
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

  it("reconciles orphan PENDING runs by re-enqueuing to BullMQ idempotently", async () => {
    // 1. Insert a PENDING workflow run in DB (no BullMQ job created)
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "test-pending-workflow",
      workflowVersion: "v1",
      input: { test: true },
    });

    expect(run.status).toBe("PENDING");

    // Verify initially no job exists in BullMQ
    const initialJob = await queue.getJob(`run_${run.id}`);
    expect(initialJob).toBeUndefined();

    // 2. Call reconcileOnce()
    const stats = await reconciler.reconcileOnce();
    expect(stats.pendingRunsReconciled).toBeGreaterThanOrEqual(1);

    // 3. Verify a job exists in BullMQ queue for that runId with correct data
    const job = await queue.getJob(`run_${run.id}`);
    expect(job).toBeDefined();
    expect(job?.data).toEqual({
      runId: run.id,
      tenantId: run.tenantId,
      workflowName: run.workflowName,
      workflowVersion: run.workflowVersion,
    });

    // 4. Call reconcileOnce() again and assert it does not duplicate the job (jobId idempotency)
    await reconciler.reconcileOnce();
    const waitingJobs = await queue.getWaiting();
    const matchingJobs = waitingJobs.filter((j) => j.id === `run_${run.id}`);
    expect(matchingJobs).toHaveLength(1);
  });

  it("ignores PENDING runs that are blocked due to WORKFLOW_VERSION_UNAVAILABLE", async () => {
    const blockedRun = await db.workflowRun.create({
      data: {
        tenantId,
        workflowName: "blocked-wf",
        workflowVersion: "v999",
        status: "PENDING",
        blockedReason: "WORKFLOW_VERSION_UNAVAILABLE",
        input: {},
      },
    });

    await reconciler.reconcileOnce();

    const job = await queue.getJob(`run_${blockedRun.id}`);
    expect(job).toBeUndefined();
  });
});

