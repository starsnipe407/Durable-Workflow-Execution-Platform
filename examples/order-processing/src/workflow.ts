import { defineWorkflow, type WorkflowDefinition } from "@durable/workflow-sdk";
import { FakePaymentGateway } from "./services/payment-gateway.js";
import type { OrderInput, OrderOutput } from "./types.js";

export const defaultPaymentGateway = new FakePaymentGateway();

export function createProcessOrderWorkflow(
  gateway: FakePaymentGateway = defaultPaymentGateway
): WorkflowDefinition<OrderInput, OrderOutput> {
  return defineWorkflow<OrderInput, OrderOutput>(
    { name: "process-order", version: "1.0.0" },
    async ({ input, step }) => {
      // Step 1: validate cart
      await step.run(
        "validate-cart",
        { retries: 0 },
        async () => {
          if (!input.items || input.items.length === 0) {
            throw new Error("Invalid cart: items array must not be empty.");
          }
          for (const item of input.items) {
            if (item.quantity <= 0) {
              throw new Error(`Invalid cart: item quantity for SKU ${item.sku} must be greater than 0.`);
            }
            if (item.price <= 0) {
              throw new Error(`Invalid cart: item price for SKU ${item.sku} must be greater than 0.`);
            }
          }
          if (input.totalAmount <= 0) {
            throw new Error("Invalid cart: total amount must be greater than 0.");
          }
          return { validated: true, itemCount: input.items.length };
        }
      );

      // Step 2: reserve inventory
      const inventoryRes = await step.run("reserve-inventory", async () => {
        return {
          reservationId: `res_${input.orderId}`,
          reservedItems: input.items.map((i) => i.sku)
        };
      });

      // Step 3: process payment with retries and external idempotency
      const paymentRes = await step.run(
        "process-payment",
        async () => {
          return await gateway.charge({
            idempotencyKey: `pay_${input.orderId}`,
            amount: input.totalAmount,
            customerId: input.customerId,
            simulateFailure: input.simulatePaymentFailure
          });
        },
        { retry: { maxAttempts: 3, backoff: "exponential" } }
      );

      // Step 4: parallel confirmations via Promise.all
      const [emailRes, crmRes, warehouseRes] = await Promise.all([
        step.run("send-confirmation-email", async () => ({
          sent: true,
          recipient: input.customerEmail
        })),
        step.run("update-crm-records", async () => ({
          updated: true,
          customerId: input.customerId
        })),
        step.run("dispatch-warehouse-fulfillment", async () => ({
          dispatched: true,
          warehouse: "WH-MAIN"
        }))
      ]);

      // Step 5: generate invoice
      const invoiceRes = await step.run("generate-invoice", async () => {
        return {
          invoiceId: `inv_${input.orderId}`
        };
      });

      const output: OrderOutput = {
        orderId: input.orderId,
        status: "FULFILLED",
        chargeId: paymentRes.chargeId,
        inventoryReservationId: inventoryRes.reservationId,
        invoiceId: invoiceRes.invoiceId,
        emailSent: emailRes.sent,
        crmUpdated: crmRes.updated,
        warehouseDispatched: warehouseRes.dispatched
      };

      return output;
    }
  );
}

export const processOrderWorkflow = createProcessOrderWorkflow(defaultPaymentGateway);
