import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { PrismaClient } from "@durable/database";
import { Redis } from "ioredis";
import { createApp } from "@durable/api";
import { hashApiKey } from "@durable/api";
import {
  WorkflowRegistry,
  WorkflowWorker,
  createWorkflowQueue,
  type WorkflowRunJobData
} from "@durable/worker";
import type { Queue } from "bullmq";
import { processOrderWorkflow, defaultPaymentGateway } from "../src/workflow.js";
import { main } from "../src/cli.js";

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redis = new Redis(redisUrl);

describe("CLI Runner Integration Tests", () => {
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  let tenantId: string;
  let apiKey: string;
  let queue: Queue<WorkflowRunJobData>;
  let registry: WorkflowRegistry;
  let worker: WorkflowWorker;
  const queueName = `cli-tests-${crypto.randomUUID()}`;

  beforeAll(async () => {
    // 1. Provision isolated test tenant & API key
    const tenant = await prisma.tenant.create({
      data: { name: `CLI Test Tenant ${crypto.randomUUID()}` }
    });
    tenantId = tenant.id;
    apiKey = `key_cli_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey),
        tenantId,
        label: "cli-api-key"
      }
    });

    // 2. Setup Worker Runtime & Queue
    queue = createWorkflowQueue(redisUrl, queueName);
    registry = new WorkflowRegistry();
    registry.register(processOrderWorkflow);

    worker = new WorkflowWorker({
      db: prisma,
      registry,
      queue,
      connectionOrUrl: redisUrl,
      redis,
      workerId: `cli-worker-${crypto.randomUUID().slice(0, 6)}`
    });

    // 3. Setup Fastify Control API with Queue, Redis, and SSE Multiplexer
    app = createApp({
      prisma,
      redis,
      queue,
      sseKeepaliveIntervalMs: 100
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;

    // 4. Register Event Binding for process-order
    await prisma.workflowEventBinding.create({
      data: {
        tenantId,
        eventName: "order.created",
        workflowName: "process-order",
        workflowVersion: "1.0.0"
      }
    });
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
    }
    if (app) await app.close();

    // Clean up scoped tenant DB records (zero leaks)
    if (tenantId) {
      await prisma.workflowEventBinding.deleteMany({ where: { tenantId } });
      await prisma.ingestedEvent.deleteMany({ where: { tenantId } });
      await prisma.executionEvent.deleteMany({ where: { tenantId } });
      await prisma.stepAttempt.deleteMany({ where: { tenantId } });
      await prisma.stepExecution.deleteMany({ where: { tenantId } });
      await prisma.workflowRun.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await redis.quit();
    await prisma.$disconnect();
  });

  it("runs CLI in default event-dispatch mode to completion", async () => {
    defaultPaymentGateway.reset();
    await expect(
      main([], {
        API_URL: baseUrl,
        API_KEY: apiKey
      } as any)
    ).resolves.not.toThrow();

    const runs = await prisma.workflowRun.findMany({ where: { tenantId, triggerType: "EVENT" } });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("COMPLETED");
  });

  it("runs CLI in --direct mode to completion", async () => {
    defaultPaymentGateway.reset();
    await expect(
      main(["--direct"], {
        API_URL: baseUrl,
        API_KEY: apiKey
      } as any)
    ).resolves.not.toThrow();

    const runs = await prisma.workflowRun.findMany({ where: { tenantId, triggerType: "DIRECT" } });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("COMPLETED");
  });
});
