import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';
import { Redis } from 'ioredis';
import { defineWorkflow } from '@durable/workflow-sdk';
import {
  WorkflowRegistry,
  WorkflowWorker,
  createWorkflowQueue,
  type WorkflowRunJobData,
} from '@durable/worker';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';
import { createWorkflowClient } from '../../../packages/client/src/index';
import type { Queue } from 'bullmq';

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
const redis = new Redis(redisUrl);

describe('Durable Workflow Platform: Full Pipeline End-to-End Smoke Run', () => {
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  let tenantId: string;
  let apiKey: string;
  let client: ReturnType<typeof createWorkflowClient>;
  let queue: Queue<WorkflowRunJobData>;
  let registry: WorkflowRegistry;
  let worker: WorkflowWorker;
  const queueName = `smoke-runs-${crypto.randomUUID()}`;

  beforeAll(async () => {
    console.log('\n===============================================================');
    console.log('🚀 INITIALIZING END-TO-END SMOKE RUN PIPELINE');
    console.log('===============================================================');

    // 1. Provision smoke tenant & hashed API key
    const tenant = await prisma.tenant.create({
      data: { name: `Smoke Enterprise ${crypto.randomUUID()}` },
    });
    tenantId = tenant.id;
    apiKey = `key_smoke_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey),
        tenantId,
        label: 'smoke-api-key',
      },
    });
    console.log(`✅ [1/5] Provisioned Smoke Tenant (${tenantId}) and API Key`);

    // 2. Setup Worker Runtime & Queue
    queue = createWorkflowQueue(redisUrl, queueName);
    registry = new WorkflowRegistry();

    // Register multi-step order fulfillment workflow
    const orderWorkflow = defineWorkflow(
      { name: 'OrderFulfillmentWorkflow', version: '1.0.0' },
      async ({ input, step }: { input: any; step: any }) => {
        // Step 1: Validate cart
        const validated = await step.run('validate-cart', async () => {
          if (!input.items || input.items.length === 0) throw new Error('Empty cart');
          const total = input.items.reduce((acc: number, i: any) => acc + i.price, 0);
          return { valid: true, total };
        });

        // Step 2: Charge payment
        const payment = await step.run('charge-payment', { retries: 2 }, async () => {
          return {
            transactionId: `txn_${crypto.randomUUID().slice(0, 8)}`,
            amount: validated.total,
            status: 'PAID',
          };
        });

        // Step 3: Parallel sibling steps
        const [email, inventory] = await Promise.all([
          step.run('send-receipt-email', async () => {
            return { sentTo: input.customerEmail, delivered: true };
          }),
          step.run('update-inventory', async () => {
            return { reservedUnits: input.items.length, status: 'CONFIRMED' };
          }),
        ]);

        // Step 4: Finalize order
        const result = await step.run('finalize-order', async () => {
          return {
            orderId: input.orderId,
            status: 'FULFILLED',
            transactionId: payment.transactionId,
            customerEmail: email.sentTo,
            units: inventory.reservedUnits,
          };
        });

        return result;
      }
    );

    registry.register(orderWorkflow);

    worker = new WorkflowWorker({
      db: prisma,
      registry,
      queue,
      connectionOrUrl: redisUrl,
      redis,
      workerId: `smoke-worker-${crypto.randomUUID().slice(0, 6)}`,
    });
    console.log('✅ [2/5] Registered Workflows and Started WorkflowWorker Daemon');

    // 3. Setup Fastify Control API with Queue, Redis, and SSE Multiplexer
    app = createApp({
      prisma,
      redis,
      queue,
      sseKeepaliveIntervalMs: 100,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
    console.log(`✅ [3/5] Control HTTP API Listening at ${baseUrl}`);

    // 4. Initialize Client SDK
    client = createWorkflowClient({ baseUrl, apiKey });
    console.log('✅ [4/5] Client SDK Connected and Ready');
    console.log('===============================================================\n');
  });

  afterAll(async () => {
    console.log('\n===============================================================');
    console.log('🧹 TEARING DOWN SMOKE PIPELINE & PURGING SMOKE TENANT');
    console.log('===============================================================');
    if (worker) await worker.close();
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
    }
    if (app) await app.close();

    // Clean up scoped tenant DB records
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
    console.log('✅ Teardown Complete. Zero Leaks.');
    console.log('===============================================================\n');
  });

  it('Pipeline Stage 1: Trigger run via Client SDK and stream events live via SSE to completion', async () => {
    console.log('\n▶️ STAGE 1: Client Run Trigger & Real-Time SSE Streaming');

    const inputData = {
      orderId: 'ord_smoke_1001',
      customerEmail: 'alice@durable.dev',
      items: [
        { name: 'TypeScript Book', price: 45.0 },
        { name: 'Mechanical Keyboard', price: 120.0 },
      ],
    };

    // Trigger workflow run
    const createdRun = await client.run({
      workflowName: 'OrderFulfillmentWorkflow',
      input: inputData,
      idempotencyKey: 'idemp_order_1001',
    });

    expect(createdRun).toBeDefined();
    expect(createdRun.id).toBeDefined();
    expect(createdRun.status).toBe('PENDING');
    console.log(`   Created Run ID: ${createdRun.id} (Status: ${createdRun.status})`);

    // Stream live events via SSE
    const events: any[] = [];
    console.log('   Streaming live Server-Sent Events (SSE):');

    for await (const event of client.runs.streamEvents(createdRun.id)) {
      events.push(event);
      const stepInfo = event.payload?.stepKey ? ` [step: ${event.payload.stepKey}]` : '';
      console.log(`   📡 [SSE EVENT #${events.length}] ${event.eventType}${stepInfo}`);
    }

    // Verify all stages streamed
    expect(events.length).toBeGreaterThanOrEqual(7);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('WORKFLOW_CREATED');
    expect(eventTypes).toContain('WORKFLOW_STARTED');
    expect(eventTypes).toContain('STEP_STARTED');
    expect(eventTypes).toContain('STEP_COMPLETED');
    expect(eventTypes).toContain('WORKFLOW_COMPLETED');

    // Verify final run state in DB
    const finalRun = await client.runs.get(createdRun.id);
    expect(finalRun.status).toBe('COMPLETED');
    expect((finalRun.output as any).status).toBe('FULFILLED');
    expect((finalRun.output as any).orderId).toBe('ord_smoke_1001');
    expect((finalRun.output as any).units).toBe(2);

    console.log('   🎉 Workflow Run Completed Successfully:');
    console.log(`      Output: ${JSON.stringify(finalRun.output)}`);
  });

  it('Pipeline Stage 2: Request idempotency prevents duplicate workflow execution', async () => {
    console.log('\n▶️ STAGE 2: Request Idempotency Verification');

    // Send the exact same request with the same idempotency key
    const duplicateRun = await client.run({
      workflowName: 'OrderFulfillmentWorkflow',
      input: { orderId: 'ord_smoke_1001' },
      idempotencyKey: 'idemp_order_1001',
    });

    // Must return the existing run with COMPLETED status
    expect(duplicateRun.status).toBe('COMPLETED');
    console.log(`   Retrieved Existing Run for Key: idemp_order_1001 (Status: ${duplicateRun.status})`);

    // Verify exactly one workflow run exists in DB for this idempotency key
    const runsCount = await prisma.workflowRun.count({
      where: { tenantId, requestIdempotencyKey: 'idemp_order_1001' },
    });
    expect(runsCount).toBe(1);
    console.log('   ✅ Idempotency Verified: 0 duplicate runs created.');
  });

  it('Pipeline Stage 3: Durable event replay starting after Last-Event-ID', async () => {
    console.log('\n▶️ STAGE 3: SSE Disconnection & Last-Event-ID Replay');

    const runs = await client.runs.list();
    const runId = runs.runs[0].id;

    // Fetch all events from DB to know the event IDs
    const allEvents = await prisma.executionEvent.findMany({
      where: { workflowRunId: runId },
      orderBy: { id: 'asc' },
    });
    expect(allEvents.length).toBeGreaterThan(2);

    // Replay starting after the second-to-last event
    const lastEventId = allEvents[allEvents.length - 2].id.toString();
    console.log(`   Reconnecting with Last-Event-ID: ${lastEventId}...`);

    const replayedEvents: any[] = [];
    for await (const event of client.runs.streamEvents(runId, { lastEventId })) {
      replayedEvents.push(event);
    }

    // Must replay only the final event
    expect(replayedEvents.length).toBe(1);
    expect(replayedEvents[0].eventType).toBe('WORKFLOW_COMPLETED');
    console.log(`   ✅ Replay Verified: Streamed exactly 1 event (WORKFLOW_COMPLETED) without duplicate history.`);
  });

  it('Pipeline Stage 4: Event-driven workflow triggering and deduplication', async () => {
    console.log('\n▶️ STAGE 4: Event Ingestion & Workflow Event Bindings');

    // Register event binding for event "smoke.order.created"
    await prisma.workflowEventBinding.create({
      data: {
        tenantId,
        eventName: 'smoke.order.created',
        workflowName: 'OrderFulfillmentWorkflow',
        workflowVersion: '1.0.0',
      },
    });

    // Ingest event via client SDK
    const eventPayload = {
      id: 'evt_smoke_auto_1',
      name: 'smoke.order.created',
      data: {
        orderId: 'ord_auto_777',
        customerEmail: 'bob@durable.dev',
        items: [{ name: 'Cloud Server Credit', price: 100.0 }],
      },
    };

    console.log(`   Ingesting Event: ${eventPayload.name} (id: ${eventPayload.id})...`);
    const res = await client.sendEvent(eventPayload);
    expect(res.status).toBe('processed');
    expect(res.runs.length).toBe(1);

    const triggeredRunId = res.runs[0].id;
    console.log(`   Triggered Run ID: ${triggeredRunId}`);

    // Stream events from the dynamically triggered run until completion
    let terminalEventReceived = false;
    for await (const event of client.runs.streamEvents(triggeredRunId)) {
      if (event.eventType === 'WORKFLOW_COMPLETED') {
        terminalEventReceived = true;
      }
    }
    expect(terminalEventReceived).toBe(true);

    const triggeredRun = await client.runs.get(triggeredRunId);
    expect(triggeredRun.status).toBe('COMPLETED');
    expect(triggeredRun.triggerType).toBe('EVENT');
    console.log('   ✅ Event-driven execution completed with triggerType: EVENT');

    // Test deduplication on re-ingesting identical event ID
    const duplicateRes = await client.sendEvent(eventPayload);
    expect(duplicateRes.status).toBe('duplicate');
    expect(duplicateRes.runs).toHaveLength(0);
    console.log('   ✅ Ingestion Deduplication Verified: Duplicate event rejected.');
  });
});
