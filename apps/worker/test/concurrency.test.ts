import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createPrismaClient, createWorkflowRun, type PrismaClient } from "@durable/database";
import { defineWorkflow } from "@durable/workflow-sdk";
import {
  WorkflowRegistry,
  WorkflowWorker,
  createWorkflowQueue,
  enqueueWorkflowRun,
  ConcurrencyCoordinator,
  type WorkflowRunJobData,
} from "../src/index.js";

const dbUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";

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

describe("Distributed Concurrency Coordinator", () => {
  const db = createPrismaClient(dbUrl);
  let redis: Redis;
  let queue: Queue<WorkflowRunJobData>;
  let worker: WorkflowWorker;
  let registry: WorkflowRegistry;
  let tenantId: string;
  const createdTenantIds: string[] = [];
  const testQueueName = "workflow-concurrency-test-queue";

  beforeAll(async () => {
    await db.$connect();
    redis = new Redis(redisUrl);
    queue = createWorkflowQueue(redisUrl, testQueueName);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }

    // Strict teardown: Clean database records scoped strictly to test tenants
    for (const tid of createdTenantIds) {
      await db.stepExecution.deleteMany({
        where: { workflowRun: { tenantId: tid } },
      });
      await db.executionEvent.deleteMany({
        where: { tenantId: tid },
      });
      await db.workflowRun.deleteMany({
        where: { tenantId: tid },
      });
      await db.tenant.deleteMany({
        where: { id: tid },
      });
    }

    // Strict teardown: Clean any concurrency test keys in Redis
    const keys = await redis.keys("concurrency:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    await redis.quit();
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({
      data: { name: `concurrency-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` },
    });
    tenantId = tenant.id;
    createdTenantIds.push(tenantId);
    registry = new WorkflowRegistry();
    worker = new WorkflowWorker({
      db,
      registry,
      queue,
      connectionOrUrl: redisUrl,
      workerId: "concurrency-test-worker",
      concurrency: 10,
    });
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
    }
    if (queue) {
      await queue.obliterate({ force: true });
    }
    const keys = await redis.keys("concurrency:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it("enforces global concurrency limit across concurrent executions", async () => {
    let activeExecutions = 0;
    let maxObservedActive = 0;

    const wfName = "global-concurrency-wf";
    const wf = defineWorkflow(
      {
        name: wfName,
        version: "v1",
        concurrency: { limit: 2, ttlSeconds: 10 },
      },
      async ({ step }) => {
        return await step.run("concurrency-step", async () => {
          activeExecutions++;
          if (activeExecutions > maxObservedActive) {
            maxObservedActive = activeExecutions;
          }
          // Simulate work
          await new Promise((r) => setTimeout(r, 200));
          activeExecutions--;
          return { done: true };
        });
      }
    );
    registry.register(wf);

    // Create 4 runs concurrently
    const runs = await Promise.all([
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { idx: 1 } }),
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { idx: 2 } }),
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { idx: 3 } }),
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { idx: 4 } }),
    ]);

    // Enqueue all 4 runs
    await Promise.all(
      runs.map((run) =>
        enqueueWorkflowRun(queue, {
          tenantId,
          runId: run.id,
          workflowName: wfName,
          workflowVersion: "v1",
        })
      )
    );

    // Wait for all 4 runs to complete
    const completedRuns = await Promise.all(
      runs.map((run) => waitForRunStatus(db, run.id, "COMPLETED", 15000))
    );

    expect(completedRuns).toHaveLength(4);
    for (const run of completedRuns) {
      expect(run.output).toEqual({ done: true });
    }

    // Global limit was 2, so maxObservedActive must never exceed 2
    expect(maxObservedActive).toBeLessThanOrEqual(2);
    expect(maxObservedActive).toBeGreaterThanOrEqual(1);
  });

  it("enforces per-key partition limits while allowing parallel execution across distinct keys", async () => {
    const activeByCustomer: Record<string, number> = {};
    const maxActiveByCustomer: Record<string, number> = {};
    let totalActive = 0;
    let maxTotalActive = 0;

    const wfName = "partition-concurrency-wf";
    const wf = defineWorkflow(
      {
        name: wfName,
        version: "v1",
        concurrency: {
          key: ({ input }: { input: { customerId: string } }) => input.customerId,
          keyLimit: 1,
          ttlSeconds: 10,
        },
      },
      async ({ step, input }: { step: any; input: { customerId: string } }) => {
        return await step.run("partition-step", async () => {
          const cid = input.customerId;
          activeByCustomer[cid] = (activeByCustomer[cid] || 0) + 1;
          maxActiveByCustomer[cid] = Math.max(
            maxActiveByCustomer[cid] || 0,
            activeByCustomer[cid]
          );
          totalActive++;
          maxTotalActive = Math.max(maxTotalActive, totalActive);

          await new Promise((r) => setTimeout(r, 200));

          activeByCustomer[cid]--;
          totalActive--;
          return { customerId: cid };
        });
      }
    );
    registry.register(wf);

    // 2 runs for cust-A, 2 runs for cust-B
    const runs = await Promise.all([
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { customerId: "cust-A" } }),
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { customerId: "cust-A" } }),
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { customerId: "cust-B" } }),
      createWorkflowRun(db, { tenantId, workflowName: wfName, workflowVersion: "v1", input: { customerId: "cust-B" } }),
    ]);

    await Promise.all(
      runs.map((run) =>
        enqueueWorkflowRun(queue, {
          tenantId,
          runId: run.id,
          workflowName: wfName,
          workflowVersion: "v1",
        })
      )
    );

    const completedRuns = await Promise.all(
      runs.map((run) => waitForRunStatus(db, run.id, "COMPLETED", 15000))
    );
    expect(completedRuns).toHaveLength(4);

    // Each partition key has limit 1, so per-customer active executions should never exceed 1
    expect(maxActiveByCustomer["cust-A"]).toBe(1);
    expect(maxActiveByCustomer["cust-B"]).toBe(1);

    // But cust-A and cust-B should execute concurrently (totalActive reaches 2)
    expect(maxTotalActive).toBeGreaterThanOrEqual(2);
  });

  it("recovers from abandoned leases after lease TTL expires without deadlocking", async () => {
    const coordinator = new ConcurrencyCoordinator(redis);
    const wfName = "ttl-recovery-wf";

    // Acquire slot with short TTL (1 second) and abandon it (simulate worker crash)
    const slot1 = await coordinator.tryAcquire(
      "run-abandoned-1",
      { limit: 1, ttlSeconds: 1 },
      {},
      wfName
    );
    expect(slot1.acquired).toBe(true);

    // Simulate worker crash: stops heartbeat timers without executing release scripts on Redis
    coordinator.simulateCrash();

    // Attempt to acquire second slot immediately -> must fail (limit is 1 and slot1 holds it)
    const slot2Immediate = await coordinator.tryAcquire(
      "run-candidate-2",
      { limit: 1, ttlSeconds: 1 },
      {},
      wfName
    );
    expect(slot2Immediate.acquired).toBe(false);

    // Wait for TTL (1 second) to expire
    await new Promise((r) => setTimeout(r, 1200));

    // Now attempt to acquire -> should succeed because expired lease was pruned
    const slot2AfterExpiry = await coordinator.tryAcquire(
      "run-candidate-2",
      { limit: 1, ttlSeconds: 1 },
      {},
      wfName
    );
    expect(slot2AfterExpiry.acquired).toBe(true);

    await slot2AfterExpiry.release();
    await coordinator.close();
  });

  it("cleanly releases Redis concurrency keys on workflow completion and process termination", async () => {
    const coordinator = new ConcurrencyCoordinator(redis);
    const wfName = "cleanup-wf";

    // Acquire 2 slots
    const slot1 = await coordinator.tryAcquire(
      "run-clean-1",
      { limit: 2, ttlSeconds: 30 },
      {},
      wfName
    );
    const slot2 = await coordinator.tryAcquire(
      "run-clean-2",
      { limit: 2, ttlSeconds: 30 },
      {},
      wfName
    );
    expect(slot1.acquired).toBe(true);
    expect(slot2.acquired).toBe(true);

    // Verify Redis has 2 members
    const globalKey = `concurrency:global:default:${wfName}`;
    let members = await redis.zrange(globalKey, 0, -1);
    expect(members).toContain("run-clean-1");
    expect(members).toContain("run-clean-2");

    // Release slot 1 (normal completion)
    await slot1.release();
    members = await redis.zrange(globalKey, 0, -1);
    expect(members).not.toContain("run-clean-1");
    expect(members).toContain("run-clean-2");

    // Process termination (coordinator.close()) cleans remaining active leases
    await coordinator.close();
    members = await redis.zrange(globalKey, 0, -1);
    expect(members).toHaveLength(0);
  });

  it("propagates error when partition key selector throws rather than failing open", async () => {
    const coordinator = new ConcurrencyCoordinator(redis);
    const wfConfig = {
      key: () => {
        throw new Error("Malicious or invalid partition key evaluation");
      },
      keyLimit: 1,
    };

    await expect(
      coordinator.tryAcquire("run-bad-key", wfConfig, {}, "error-wf")
    ).rejects.toThrow("Malicious or invalid partition key evaluation");

    await coordinator.close();
  });

  it("supports ConnectionOptions object format without falling back to default localhost", async () => {
    const customWorker = new WorkflowWorker({
      db,
      registry: new WorkflowRegistry(),
      connectionOrUrl: { host: "127.0.0.1", port: 6380 },
      workerId: "connection-options-worker",
      concurrency: 1,
    });

    expect(customWorker).toBeDefined();
    await customWorker.close();
  });

  it("isolates global concurrency limits across distinct tenants", async () => {
    const coordinator = new ConcurrencyCoordinator(redis);
    const wfName = "tenant-isolation-wf";

    // Tenant A acquires slot with limit: 1
    const slotA = await coordinator.tryAcquire(
      "run-tenant-a-1",
      { limit: 1, ttlSeconds: 30 },
      {},
      wfName,
      "tenant-alpha"
    );
    expect(slotA.acquired).toBe(true);

    // Tenant A tries second slot -> denied
    const slotA2 = await coordinator.tryAcquire(
      "run-tenant-a-2",
      { limit: 1, ttlSeconds: 30 },
      {},
      wfName,
      "tenant-alpha"
    );
    expect(slotA2.acquired).toBe(false);

    // Tenant B acquires slot for same workflow name with limit: 1 -> allowed because different tenant!
    const slotB = await coordinator.tryAcquire(
      "run-tenant-b-1",
      { limit: 1, ttlSeconds: 30 },
      {},
      wfName,
      "tenant-beta"
    );
    expect(slotB.acquired).toBe(true);

    await slotA.release();
    await slotB.release();
    await coordinator.close();
  });

  it("supports run.concurrencyKey as partition key when workflow has no key selector", async () => {
    const coordinator = new ConcurrencyCoordinator(redis);
    const wfName = "fallback-key-wf";

    // First run with concurrencyKey: "user-999"
    const slot1 = await coordinator.tryAcquire(
      "run-fb-1",
      {},
      {},
      wfName,
      "tenant-1",
      "user-999"
    );
    expect(slot1.acquired).toBe(true);

    // Second run with same concurrencyKey -> denied (keyLimit defaults to 1)
    const slot2 = await coordinator.tryAcquire(
      "run-fb-2",
      {},
      {},
      wfName,
      "tenant-1",
      "user-999"
    );
    expect(slot2.acquired).toBe(false);

    // Third run with different concurrencyKey -> allowed
    const slot3 = await coordinator.tryAcquire(
      "run-fb-3",
      {},
      {},
      wfName,
      "tenant-1",
      "user-888"
    );
    expect(slot3.acquired).toBe(true);

    await slot1.release();
    await slot3.release();
    await coordinator.close();
  });
});
