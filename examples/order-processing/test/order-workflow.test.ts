import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { WorkflowExecutor } from "@durable/workflow-sdk";
import { processOrderWorkflow, defaultPaymentGateway, createProcessOrderWorkflow } from "../src/workflow.js";
import { FakePaymentGateway } from "../src/services/payment-gateway.js";
import type { OrderInput, OrderOutput } from "../src/types.js";

describe("processOrderWorkflow End-to-End Tests", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    for (const tId of tenantIds) {
      await db.executionEvent.deleteMany({ where: { tenantId: tId } });
      await db.stepAttempt.deleteMany({ where: { stepExecution: { workflowRun: { tenantId: tId } } } });
      await db.stepExecution.deleteMany({ where: { workflowRun: { tenantId: tId } } });
      await db.workflowRun.deleteMany({ where: { tenantId: tId } });
      await db.workflowEventBinding.deleteMany({ where: { tenantId: tId } });
      await db.ingestedEvent.deleteMany({ where: { tenantId: tId } });
      await db.apiKey.deleteMany({ where: { tenantId: tId } });
      await db.tenant.deleteMany({ where: { id: tId } });
    }
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "order-workflow-test-tenant" } });
    tenantId = tenant.id;
    tenantIds.push(tenant.id);
    defaultPaymentGateway.reset();
  });

  it("completes full order workflow end-to-end when all steps succeed", async () => {
    const input: OrderInput = {
      orderId: "ord_happy_path",
      customerId: "cust_101",
      customerEmail: "customer@example.com",
      items: [
        { sku: "ITEM-A", quantity: 2, price: 29.99 },
        { sku: "ITEM-B", quantity: 1, price: 40.02 }
      ],
      totalAmount: 100.00
    };

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "process-order",
      workflowVersion: "1.0.0",
      input
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-test-1" });
    const output = (await executor.execute(processOrderWorkflow, run.id)) as OrderOutput;

    // Verify final output
    expect(output).toBeDefined();
    expect(output.orderId).toBe("ord_happy_path");
    expect(output.status).toBe("FULFILLED");
    expect(output.chargeId).toMatch(/^ch_/);
    expect(output.inventoryReservationId).toBe("res_ord_happy_path");
    expect(output.invoiceId).toBe("inv_ord_happy_path");
    expect(output.emailSent).toBe(true);
    expect(output.crmUpdated).toBe(true);
    expect(output.warehouseDispatched).toBe(true);

    // Verify all steps committed in DB
    const stepExecutions = await db.stepExecution.findMany({
      where: { workflowRunId: run.id }
    });
    const stepKeys = stepExecutions.map((s) => s.stepKey).sort();
    expect(stepKeys).toEqual([
      "dispatch-warehouse-fulfillment",
      "generate-invoice",
      "process-payment",
      "reserve-inventory",
      "send-confirmation-email",
      "update-crm-records",
      "validate-cart"
    ]);

    expect(defaultPaymentGateway.getChargeCount()).toBe(1);

    // Verify workflow run status in DB
    const finalRun = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(finalRun?.status).toBe("COMPLETED");
  });

  it("handles transient payment failure with automatic retry: attempt 1 fails, attempt 2 succeeds", async () => {
    const customGateway = new FakePaymentGateway();
    const workflow = createProcessOrderWorkflow(customGateway);

    const input: OrderInput = {
      orderId: "ord_retry_flow",
      customerId: "cust_202",
      customerEmail: "retry@example.com",
      items: [{ sku: "ITEM-X", quantity: 1, price: 50.00 }],
      totalAmount: 50.00,
      simulatePaymentFailure: true
    };

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "process-order",
      workflowVersion: "1.0.0",
      input
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-test-1" });

    // Attempt 1: fails in process-payment step, workflow is gracefully suspended (returns undefined)
    const result1 = await executor.execute(workflow, run.id);
    expect(result1).toBeUndefined();

    // Check step status: process-payment should be in RETRY_WAIT
    const paymentStep = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "process-payment" } }
    });
    expect(paymentStep?.status).toBe("RETRY_WAIT");
    expect(paymentStep?.attemptCount).toBe(1);

    // Prior steps should be COMPLETED
    const validateStep = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "validate-cart" } }
    });
    expect(validateStep?.status).toBe("COMPLETED");

    const reserveStep = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "reserve-inventory" } }
    });
    expect(reserveStep?.status).toBe("COMPLETED");

    // Fast-forward nextRetryAt so retry is due immediately
    await db.stepExecution.update({
      where: { id: paymentStep!.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) }
    });

    // Attempt 2: retry succeeds, subsequent parallel and invoice steps execute, workflow completes
    const result2 = (await executor.execute(workflow, run.id)) as OrderOutput;
    expect(result2).toBeDefined();
    expect(result2.status).toBe("FULFILLED");
    expect(result2.chargeId).toMatch(/^ch_/);

    // Verify charge count: payment gateway charged successfully once on attempt 2
    expect(customGateway.getChargeCount()).toBe(1);

    const updatedPaymentStep = await db.stepExecution.findUnique({
      where: { id: paymentStep!.id }
    });
    expect(updatedPaymentStep?.status).toBe("COMPLETED");
    expect(updatedPaymentStep?.attemptCount).toBe(2);
  });

  it("memoizes completed steps and skips re-execution on replay after simulated worker crash", async () => {
    const input: OrderInput = {
      orderId: "ord_memoize",
      customerId: "cust_303",
      customerEmail: "memoize@example.com",
      items: [{ sku: "ITEM-M", quantity: 3, price: 15.00 }],
      totalAmount: 45.00
    };

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "process-order",
      workflowVersion: "1.0.0",
      input
    });

    // Worker 1 executes steps up to validate and reserve
    const executor1 = new WorkflowExecutor({ db, workerId: "worker-1" });
    const output1 = (await executor1.execute(processOrderWorkflow, run.id)) as OrderOutput;
    expect(output1.status).toBe("FULFILLED");

    // Worker 2 replays the already COMPLETED workflow run
    const executor2 = new WorkflowExecutor({ db, workerId: "worker-2" });
    const output2 = (await executor2.execute(processOrderWorkflow, run.id)) as OrderOutput;
    expect(output2).toEqual(output1);

    // Charge count should still be 1 (no duplicate charges)
    expect(defaultPaymentGateway.getChargeCount()).toBe(1);
  });

  it("rejects invalid cart input during validate-cart step", async () => {
    const invalidInput: OrderInput = {
      orderId: "ord_invalid",
      customerId: "cust_err",
      customerEmail: "err@example.com",
      items: [], // empty items
      totalAmount: 0
    };

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "process-order",
      workflowVersion: "1.0.0",
      input: invalidInput
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-test" });
    await expect(executor.execute(processOrderWorkflow, run.id)).rejects.toThrow(/Invalid cart/i);

    const finalRun = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(finalRun?.status).toBe("FAILED");
  });
});
