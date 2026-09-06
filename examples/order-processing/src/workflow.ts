import { defineWorkflow, type WorkflowDefinition } from "@durable/workflow-sdk";
import { FakePaymentGateway } from "./services/payment-gateway.js";
import {
  FakeInventoryService,
  FakeNotificationService,
  FakeCRMService,
  FakeWarehouseService
} from "./services/mock-services.js";
import type { OrderInput, OrderOutput } from "./types.js";

export const defaultPaymentGateway = new FakePaymentGateway();
export const defaultInventoryService = new FakeInventoryService();
export const defaultNotificationService = new FakeNotificationService();
export const defaultCRMService = new FakeCRMService();
export const defaultWarehouseService = new FakeWarehouseService();

export interface OrderWorkflowServices {
  gateway?: FakePaymentGateway;
  inventory?: FakeInventoryService;
  notification?: FakeNotificationService;
  crm?: FakeCRMService;
  warehouse?: FakeWarehouseService;
}

export function createProcessOrderWorkflow(
  servicesOrGateway: FakePaymentGateway | OrderWorkflowServices = defaultPaymentGateway
): WorkflowDefinition<OrderInput, OrderOutput> {
  const isGateway =
    servicesOrGateway instanceof FakePaymentGateway ||
    ("charge" in servicesOrGateway && typeof (servicesOrGateway as any).charge === "function");
  const gateway = isGateway
    ? (servicesOrGateway as FakePaymentGateway)
    : (servicesOrGateway.gateway ?? defaultPaymentGateway);
  const inventory = isGateway
    ? defaultInventoryService
    : (servicesOrGateway.inventory ?? defaultInventoryService);
  const notification = isGateway
    ? defaultNotificationService
    : (servicesOrGateway.notification ?? defaultNotificationService);
  const crm = isGateway
    ? defaultCRMService
    : (servicesOrGateway.crm ?? defaultCRMService);
  const warehouse = isGateway
    ? defaultWarehouseService
    : (servicesOrGateway.warehouse ?? defaultWarehouseService);

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
        const res = await inventory.reserve(input.orderId, input.items);
        return {
          reservationId: res.reservationId,
          reservedItems: res.items
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
        step.run("send-confirmation-email", async () => {
          const res = await notification.sendReceipt(input.customerEmail, input.orderId, input.totalAmount);
          return {
            sent: res.sent,
            recipient: input.customerEmail,
            messageId: res.messageId
          };
        }),
        step.run("update-crm-records", async () => {
          const res = await crm.updateCustomerLifetimeValue(input.customerId, input.totalAmount);
          return {
            updated: res.updated,
            customerId: input.customerId
          };
        }),
        step.run("dispatch-warehouse-fulfillment", async () => {
          const res = await warehouse.dispatchOrder(input.orderId, "WH-MAIN");
          return {
            dispatched: res.dispatched,
            warehouse: "WH-MAIN",
            trackingNumber: res.trackingNumber
          };
        })
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
