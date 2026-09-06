import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { WorkflowExecutor, defineWorkflow } from "@durable/workflow-sdk";
import { FakePaymentGateway } from "../src/services/payment-gateway.js";
import type { OrderInput } from "../src/types.js";

describe("External Idempotency & Gateway Deduplication Tests", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.$connect();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "idempotency-test-tenant" } });
    tenantId = tenant.id;
  });

  it("deduplicates multiple charges with the same idempotency key", async () => {
    const gateway = new FakePaymentGateway();

    // First attempt: creates charge
    const res1 = await gateway.charge({
      idempotencyKey: "pay_test_dup_1",
      amount: 150.0,
      customerId: "cust_dup"
    });
    expect(res1.duplicate).toBe(false);
    expect(res1.chargeId).toMatch(/^ch_/);
    expect(gateway.getChargeCount()).toBe(1);

    // Second attempt with identical key: deduplicates, returns original chargeId
    const res2 = await gateway.charge({
      idempotencyKey: "pay_test_dup_1",
      amount: 150.0,
      customerId: "cust_dup"
    });
    expect(res2.duplicate).toBe(true);
    expect(res2.chargeId).toBe(res1.chargeId);

    // Third attempt with identical key: still 1 charge
    const res3 = await gateway.charge({
      idempotencyKey: "pay_test_dup_1",
      amount: 150.0,
      customerId: "cust_dup"
    });
    expect(res3.duplicate).toBe(true);
    expect(res3.chargeId).toBe(res1.chargeId);

    expect(gateway.getChargeCount()).toBe(1);

    // Call with different key creates a separate charge
    const resDifferent = await gateway.charge({
      idempotencyKey: "pay_test_dup_2",
      amount: 200.0,
      customerId: "cust_dup"
    });
    expect(resDifferent.duplicate).toBe(false);
    expect(resDifferent.chargeId).not.toBe(res1.chargeId);
    expect(gateway.getChargeCount()).toBe(2);
  });

  it("handles transient error when simulateFailure is true and succeeds on retry with same idempotency key", async () => {
    const gateway = new FakePaymentGateway();

    // First attempt throws transient network error
    await expect(
      gateway.charge({
        idempotencyKey: "pay_fail_retry_1",
        amount: 85.0,
        customerId: "cust_retry",
        simulateFailure: true
      })
    ).rejects.toThrow("Payment gateway network timeout (transient)");

    expect(gateway.getChargeCount()).toBe(0);

    // Second attempt with same idempotency key succeeds
    const res = await gateway.charge({
      idempotencyKey: "pay_fail_retry_1",
      amount: 85.0,
      customerId: "cust_retry",
      simulateFailure: true
    });

    expect(res.duplicate).toBe(false);
    expect(res.chargeId).toMatch(/^ch_/);
    expect(gateway.getChargeCount()).toBe(1);
  });

  it("guarantees exactly 1 physical charge when worker crashes AFTER external charge but BEFORE DB commit", async () => {
    const gateway = new FakePaymentGateway();
    let crashOnFirstAttempt = true;

    // A workflow step that calls payment gateway then crashes before returning
    const crashingWorkflow = defineWorkflow<OrderInput, { chargeId: string }>(
      { name: "crashing-payment-wf", version: "1.0.0" },
      async ({ input, step }) => {
        const paymentRes = await step.run("process-payment", async () => {
          const res = await gateway.charge({
            idempotencyKey: `pay_${input.orderId}`,
            amount: input.totalAmount,
            customerId: input.customerId
          });

          // Simulate worker crash / power failure immediately after external gateway side-effect
          if (crashOnFirstAttempt) {
            crashOnFirstAttempt = false;
            throw new Error("SIMULATED_WORKER_CRASH_AFTER_CHARGE");
          }

          return res;
        });

        return { chargeId: paymentRes.chargeId };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "crashing-payment-wf",
      workflowVersion: "1.0.0",
      input: {
        orderId: "ord_crash_recovery",
        customerId: "cust_crash",
        customerEmail: "crash@example.com",
        items: [{ sku: "ITEM-CRASH", quantity: 1, price: 99.0 }],
        totalAmount: 99.0
      }
    });

    const executor1 = new WorkflowExecutor({ db, workerId: "worker-crash-1" });

    // Worker 1 executes: charge is recorded in payment gateway, then worker crashes
    // Step is suspended in RETRY_WAIT
    const res1 = await executor1.execute(crashingWorkflow, run.id);
    expect(res1).toBeUndefined();

    // At this point, the gateway recorded 1 charge
    expect(gateway.getChargeCount()).toBe(1);

    // Verify step execution in DB is RETRY_WAIT (not yet COMPLETED)
    const stepRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "process-payment" } }
    });
    expect(stepRecord?.status).toBe("RETRY_WAIT");

    // Fast-forward nextRetryAt for recovery
    await db.stepExecution.update({
      where: { id: stepRecord!.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) }
    });

    // Replacement worker 2 picks up the workflow and replays
    const executor2 = new WorkflowExecutor({ db, workerId: "worker-crash-2" });
    const res2 = await executor2.execute(crashingWorkflow, run.id);

    expect(res2).toBeDefined();
    expect(res2?.chargeId).toMatch(/^ch_/);

    // CRITICAL INVARIANT:
    // Despite the worker crashing after the external charge and the handler being re-executed,
    // the external idempotency key prevented duplicate charging. Exactly 1 charge exists.
    expect(gateway.getChargeCount()).toBe(1);

    // Verify step is now COMPLETED in DB
    const finalStepRecord = await db.stepExecution.findUnique({
      where: { id: stepRecord!.id }
    });
    expect(finalStepRecord?.status).toBe("COMPLETED");
  });
});
