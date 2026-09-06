import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { PrismaClient } from "@durable/database";
import { Redis } from "ioredis";
import { createApp } from "@durable/api";
import { hashApiKey } from "@durable/api";
import { DurableClient, type WorkflowExecutionEvent } from "@durable/client";
import {
  WorkflowRegistry,
  WorkflowWorker,
  createWorkflowQueue,
  type WorkflowRunJobData
} from "@durable/worker";
import type { Queue } from "bullmq";
import { processOrderWorkflow, defaultPaymentGateway } from "../src/workflow.js";
import type { OrderInput, OrderOutput } from "../src/types.js";

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
const redis = new Redis(redisUrl);

describe("Event-Driven Integration & SSE Runner E2E", () => {
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  let tenantId: string;
  let apiKey: string;
  let client: DurableClient;
  let queue: Queue<WorkflowRunJobData>;
  let registry: WorkflowRegistry;
  let worker: WorkflowWorker;
  const queueName = `order-events-${crypto.randomUUID()}`;

  beforeAll(async () => {
    // 1. Provision isolated test tenant & API key
    const tenant = await prisma.tenant.create({
      data: { name: `Order Event Tenant ${crypto.randomUUID()}` }
    });
    tenantId = tenant.id;
    apiKey = `key_event_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey),
        tenantId,
        label: "order-event-api-key"
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
      workerId: `order-worker-${crypto.randomUUID().slice(0, 6)}`
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

    // 4. Initialize Client SDK
    client = new DurableClient({ baseUrl, apiKey });

    // 5. Register Event Binding for process-order
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

  it("triggers process-order workflow via order.created event and streams SSE events to completion", async () => {
    defaultPaymentGateway.reset();

    const eventId = `evt_${crypto.randomUUID()}`;
    const orderInput: OrderInput = {
      orderId: "ord_stream_001",
      customerId: "cust_event_99",
      customerEmail: "event-customer@example.com",
      items: [
        { sku: "ITEM-X", quantity: 2, price: 49.99 },
        { sku: "ITEM-Y", quantity: 1, price: 20.02 }
      ],
      totalAmount: 120.00
    };

    // 1. Dispatch event via client.sendEvent with eventId and payload
    const res = await client.sendEvent({
      name: "order.created",
      eventId,
      payload: orderInput
    });

    expect(res.status).toBe("processed");
    expect(res.eventId).toBe(eventId);
    expect(res.runs).toHaveLength(1);

    const triggeredRunId = res.runs[0].id;
    expect(triggeredRunId).toBeDefined();

    // 2. Stream execution events live via SSE
    const receivedEvents: WorkflowExecutionEvent[] = [];
    for await (const event of client.runs.streamEvents(triggeredRunId)) {
      receivedEvents.push(event);
      if (event.eventType === "WORKFLOW_COMPLETED") {
        break;
      }
    }

    const eventTypes = receivedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain("WORKFLOW_CREATED");
    expect(eventTypes).toContain("WORKFLOW_STARTED");
    expect(eventTypes).toContain("STEP_STARTED");
    expect(eventTypes).toContain("STEP_COMPLETED");
    expect(eventTypes).toContain("WORKFLOW_COMPLETED");

    // 3. Verify workflow run record in DB & client
    const completedRun = await client.runs.get(triggeredRunId);
    expect(completedRun.status).toBe("COMPLETED");
    expect(completedRun.triggerType).toBe("EVENT");
    expect(completedRun.triggerEventId).toBeDefined();

    const output = completedRun.output as OrderOutput;
    expect(output.orderId).toBe("ord_stream_001");
    expect(output.status).toBe("FULFILLED");
    expect(output.chargeId).toMatch(/^ch_/);
    expect(output.inventoryReservationId).toBe("res_ord_stream_001");
    expect(output.invoiceId).toBe("inv_ord_stream_001");
    expect(output.emailSent).toBe(true);
    expect(output.crmUpdated).toBe(true);
    expect(output.warehouseDispatched).toBe(true);

    // 4. Verify deduplication: re-sending the same event returns duplicate and creates 0 new runs
    const dupRes = await client.sendEvent({
      name: "order.created",
      eventId,
      payload: orderInput
    });
    expect(dupRes.status).toBe("duplicate");
    expect(dupRes.eventId).toBe(eventId);
    expect(dupRes.runs).toHaveLength(0);

    const runsForTenant = await prisma.workflowRun.findMany({ where: { tenantId } });
    expect(runsForTenant).toHaveLength(1);
  });

  it("executes workflow directly via client.startWorkflow when direct mode is invoked", async () => {
    defaultPaymentGateway.reset();

    const directOrderInput: OrderInput = {
      orderId: "ord_direct_002",
      customerId: "cust_direct_42",
      customerEmail: "direct@example.com",
      items: [{ sku: "DIRECT-SKU", quantity: 1, price: 99.00 }],
      totalAmount: 99.00
    };

    const run = await client.startWorkflow("process-order", directOrderInput);
    expect(run).toBeDefined();
    expect(run.status).toBe("PENDING");

    // Stream SSE events until completion
    let completed = false;
    for await (const event of client.runs.streamEvents(run.id)) {
      if (event.eventType === "WORKFLOW_COMPLETED") {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);

    const completedRun = await client.runs.get(run.id);
    expect(completedRun.status).toBe("COMPLETED");
    const output = completedRun.output as OrderOutput;
    expect(output.orderId).toBe("ord_direct_002");
    expect(output.status).toBe("FULFILLED");
  });
});
