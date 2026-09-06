import { describe, it } from 'vitest';
import { PrismaClient } from '../src/client.js';
import crypto from 'node:crypto';

function hashApiKey(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

describe('Seed Demo Data', () => {
  it('seeds database with rich demo runs and workflows', async () => {
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public',
        },
      },
    });

    const tenantId = '11111111-1111-1111-1111-111111111111';
    const apiKeyRaw = 'durable_live_demo_key';

    // 1. Upsert Tenant
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: { name: 'Acme Global Services' },
      create: {
        id: tenantId,
        name: 'Acme Global Services',
      },
    });

    // 2. Upsert API Key
    const keyHash = hashApiKey(apiKeyRaw);
    await prisma.apiKey.upsert({
      where: { keyHash },
      update: { revokedAt: null },
      create: {
        tenantId,
        keyHash,
        label: 'Demo Operator Key',
      },
    });

    // 3. Upsert Workflow Definitions
    const wfDefs = [
      { name: 'process-order', version: '1.0.0' },
      { name: 'process-order', version: '1.1.0' },
      { name: 'customer-onboarding', version: '1.0.0' },
      { name: 'inventory-sync', version: '2.0.0' },
      { name: 'payment-reconciliation', version: '1.0.0' },
    ];

    for (const def of wfDefs) {
      await prisma.workflowDefinition.upsert({
        where: {
          tenantId_name_version: {
            tenantId,
            name: def.name,
            version: def.version,
          },
        },
        update: {},
        create: {
          tenantId,
          name: def.name,
          version: def.version,
        },
      });
    }

    // 4. Upsert Event Bindings
    const eventBindings = [
      { eventName: 'order.placed', workflowName: 'process-order', workflowVersion: '1.1.0' },
      { eventName: 'customer.signup', workflowName: 'customer-onboarding', workflowVersion: '1.0.0' },
      { eventName: 'inventory.depleted', workflowName: 'inventory-sync', workflowVersion: '2.0.0' },
    ];

    for (const eb of eventBindings) {
      const existing = await prisma.workflowEventBinding.findFirst({
        where: { tenantId, eventName: eb.eventName, workflowName: eb.workflowName },
      });
      if (!existing) {
        await prisma.workflowEventBinding.create({
          data: {
            tenantId,
            eventName: eb.eventName,
            workflowName: eb.workflowName,
            workflowVersion: eb.workflowVersion,
          },
        });
      }
    }

    // Clean old demo runs for tenant
    await prisma.workflowRun.deleteMany({ where: { tenantId } });

    const now = Date.now();

    // Run 1: COMPLETED Flagship Run with Concurrent Steps
    const run1Id = 'aaaaaaaa-1111-4000-8000-000000000001';
    const run1Started = new Date(now - 120_000);
    const run1Completed = new Date(now - 85_000);

    const run1 = await prisma.workflowRun.create({
      data: {
        id: run1Id,
        tenantId,
        workflowName: 'process-order',
        workflowVersion: '1.1.0',
        status: 'COMPLETED',
        triggerType: 'EVENT',
        triggerEventId: '00000000-0000-0000-0000-000000000099',
        concurrencyKey: 'cust_9841',
        startedAt: run1Started,
        completedAt: run1Completed,
        createdAt: new Date(now - 122_000),
        input: {
          orderId: 'ORD-9841-XYZ',
          amount: 1299.99,
          currency: 'USD',
          customer: {
            id: 'cust_9841',
            name: 'Sarah Connor',
            email: 'sarah.connor@cyberdyne.org',
            tier: 'VIP',
          },
          items: [
            { sku: 'LAPTOP-PRO-16', qty: 1, unitPrice: 1299.99 },
          ],
        },
        output: {
          status: 'FULFILLED',
          trackingNumber: 'FEDEX-9821-4821',
          paymentTransactionId: 'txn_stripe_9841_ok',
          confirmationSent: true,
          inventoryReserved: true,
        },
      },
    });

    // Step 1: validate-cart
    const step1 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run1.id,
        stepKey: 'validate-cart',
        status: 'COMPLETED',
        attemptCount: 1,
        startedAt: new Date(now - 119_000),
        completedAt: new Date(now - 118_200),
        createdAt: new Date(now - 120_000),
        output: { valid: true, itemsInStock: true },
      },
    });
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step1.id,
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-daemon-node-1',
        startedAt: new Date(now - 119_000),
        finishedAt: new Date(now - 118_200),
      },
    });

    // Step 2: charge-payment
    const step2 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run1.id,
        stepKey: 'charge-payment',
        status: 'COMPLETED',
        attemptCount: 1,
        startedAt: new Date(now - 118_000),
        completedAt: new Date(now - 115_500),
        createdAt: new Date(now - 118_000),
        output: { transactionId: 'txn_stripe_9841_ok', amountCharged: 1299.99 },
      },
    });
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step2.id,
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-daemon-node-2',
        startedAt: new Date(now - 118_000),
        finishedAt: new Date(now - 115_500),
      },
    });

    // Step 3 (Concurrent with Step 4): send-receipt-email
    const step3 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run1.id,
        stepKey: 'send-receipt-email',
        status: 'COMPLETED',
        attemptCount: 1,
        startedAt: new Date(now - 115_000),
        completedAt: new Date(now - 105_000), // Overlaps with step4
        createdAt: new Date(now - 115_000),
        output: { emailSent: true, messageId: 'msg_9841_email' },
      },
    });
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step3.id,
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-daemon-node-1',
        startedAt: new Date(now - 115_000),
        finishedAt: new Date(now - 105_000),
      },
    });

    // Step 4 (Concurrent with Step 3): update-inventory
    const step4 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run1.id,
        stepKey: 'update-inventory',
        status: 'COMPLETED',
        attemptCount: 1,
        startedAt: new Date(now - 114_500),
        completedAt: new Date(now - 100_000), // Overlaps with step3
        createdAt: new Date(now - 114_500),
        output: { warehouse: 'WH-EAST-1', remainingStock: 42 },
      },
    });
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step4.id,
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-daemon-node-3',
        startedAt: new Date(now - 114_500),
        finishedAt: new Date(now - 100_000),
      },
    });

    // Step 5: finalize-order
    const step5 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run1.id,
        stepKey: 'finalize-order',
        status: 'COMPLETED',
        attemptCount: 1,
        startedAt: new Date(now - 99_000),
        completedAt: new Date(now - 85_000),
        createdAt: new Date(now - 99_000),
        output: { archived: true, state: 'FULFILLED' },
      },
    });
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: step5.id,
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-daemon-node-1',
        startedAt: new Date(now - 99_000),
        finishedAt: new Date(now - 85_000),
      },
    });

    // Run 2: FAILED Run (with Attempt Inspector and ready for "Retry Run")
    const run2Id = 'aaaaaaaa-2222-4000-8000-000000000002';
    const run2 = await prisma.workflowRun.create({
      data: {
        id: run2Id,
        tenantId,
        workflowName: 'process-order',
        workflowVersion: '1.0.0',
        status: 'FAILED',
        triggerType: 'DIRECT',
        startedAt: new Date(now - 60_000),
        failedAt: new Date(now - 45_000),
        createdAt: new Date(now - 62_000),
        input: {
          orderId: 'ORD-7721-FAIL',
          amount: 450.00,
          customer: { email: 'bad.payment@example.com' },
        },
        error: {
          code: 'PAYMENT_GATEWAY_DECLINE',
          message: 'Stripe Card Error: 402 Insufficient Funds on card ending in 4242',
          retryable: true,
        },
      },
    });

    const run2Step1 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run2.id,
        stepKey: 'validate-cart',
        status: 'COMPLETED',
        attemptCount: 1,
        startedAt: new Date(now - 59_000),
        completedAt: new Date(now - 58_000),
        createdAt: new Date(now - 60_000),
        output: { valid: true },
      },
    });
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: run2Step1.id,
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-daemon-node-1',
        startedAt: new Date(now - 59_000),
        finishedAt: new Date(now - 58_000),
      },
    });

    const run2Step2 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run2.id,
        stepKey: 'charge-card',
        status: 'FAILED',
        attemptCount: 2,
        startedAt: new Date(now - 57_000),
        failedAt: new Date(now - 45_000),
        createdAt: new Date(now - 58_000),
        error: {
          code: 'CARD_DECLINED',
          message: 'Insufficient Funds (code 402)',
        },
      },
    });

    // Attempt 1: TIMED_OUT
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: run2Step2.id,
        attemptNumber: 1,
        status: 'TIMED_OUT',
        workerId: 'worker-daemon-node-2',
        startedAt: new Date(now - 57_000),
        finishedAt: new Date(now - 52_000),
        errorType: 'TimeoutError',
        errorMessage: 'Gateway response timed out after 5000ms',
        timedOut: true,
        retryDelayMs: 2000,
      },
    });

    // Attempt 2: FAILED
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: run2Step2.id,
        attemptNumber: 2,
        status: 'FAILED',
        workerId: 'worker-daemon-node-1',
        startedAt: new Date(now - 50_000),
        finishedAt: new Date(now - 45_000),
        errorType: 'CardDeclinedError',
        errorMessage: 'Stripe Card Error: 402 Insufficient Funds',
        errorMetadata: {
          decline_code: 'insufficient_funds',
          charge_id: 'ch_fake_7721',
        },
      },
    });

    // Run 3: RUNNING Run (ready for "Cancel Run" testing)
    const run3Id = 'aaaaaaaa-3333-4000-8000-000000000003';
    const run3 = await prisma.workflowRun.create({
      data: {
        id: run3Id,
        tenantId,
        workflowName: 'inventory-sync',
        workflowVersion: '2.0.0',
        status: 'RUNNING',
        triggerType: 'DIRECT',
        startedAt: new Date(now - 15_000),
        createdAt: new Date(now - 16_000),
        input: {
          warehouseId: 'WH-CENTRAL-09',
          targetSKUs: ['SKU-100', 'SKU-200', 'SKU-300'],
        },
      },
    });

    const run3Step1 = await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run3.id,
        stepKey: 'fetch-warehouse-inventory',
        status: 'COMPLETED',
        attemptCount: 1,
        startedAt: new Date(now - 14_000),
        completedAt: new Date(now - 8_000),
        createdAt: new Date(now - 15_000),
        output: { fetchedItems: 1540 },
      },
    });
    await prisma.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId: run3Step1.id,
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-daemon-node-4',
        startedAt: new Date(now - 14_000),
        finishedAt: new Date(now - 8_000),
      },
    });

    await prisma.stepExecution.create({
      data: {
        tenantId,
        workflowRunId: run3.id,
        stepKey: 'broadcast-catalogue-updates',
        status: 'RUNNING',
        attemptCount: 1,
        startedAt: new Date(now - 7_000),
        createdAt: new Date(now - 8_000),
      },
    });

    // Additional completed runs for filtering/pagination
    for (let i = 5; i <= 10; i++) {
      await prisma.workflowRun.create({
        data: {
          id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
          tenantId,
          workflowName: i % 2 === 0 ? 'process-order' : 'payment-reconciliation',
          workflowVersion: '1.0.0',
          status: 'COMPLETED',
          triggerType: 'DIRECT',
          startedAt: new Date(now - i * 60_000),
          completedAt: new Date(now - i * 60_000 + 12_000),
          createdAt: new Date(now - i * 60_000 - 1_000),
          input: { batchNumber: `BATCH-2026-${i}` },
          output: { processedCount: i * 15, status: 'SUCCESS' },
        },
      });
    }

    console.log('✅ Demo database seeded successfully!');
    console.log(`Tenant ID: ${tenantId}`);
    console.log(`API Key:   ${apiKeyRaw}`);

    await prisma.$disconnect();
  });
});
