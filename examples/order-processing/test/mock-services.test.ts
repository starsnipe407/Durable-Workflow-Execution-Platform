import { describe, it, expect, beforeEach } from "vitest";
import {
  FakeInventoryService,
  FakeNotificationService,
  FakeCRMService,
  FakeWarehouseService
} from "../src/services/mock-services.js";

describe("Mock Downstream Services Unit Tests", () => {
  describe("FakeInventoryService", () => {
    let inventory: FakeInventoryService;

    beforeEach(() => {
      inventory = new FakeInventoryService();
    });

    it("reserves stock and allocates units per SKU", async () => {
      const res = await inventory.reserve("ord_100", [
        { sku: "SKU-A", quantity: 3 },
        { sku: "SKU-B", quantity: 2 }
      ]);

      expect(res.reservationId).toBe("res_ord_100");
      expect(res.items).toEqual(["SKU-A", "SKU-B"]);
      expect(inventory.getAllocatedStock("SKU-A")).toBe(3);
      expect(inventory.getAllocatedStock("SKU-B")).toBe(2);

      // Reserve more for another order
      await inventory.reserve("ord_101", [{ sku: "SKU-A", quantity: 5 }]);
      expect(inventory.getAllocatedStock("SKU-A")).toBe(8);
    });

    it("releases stock upon reservation cancellation", async () => {
      const res = await inventory.reserve("ord_200", [
        { sku: "SKU-X", quantity: 4 },
        { sku: "SKU-Y", quantity: 1 }
      ]);

      expect(inventory.getAllocatedStock("SKU-X")).toBe(4);
      expect(inventory.getAllocatedStock("SKU-Y")).toBe(1);

      await inventory.release(res.reservationId);

      expect(inventory.getAllocatedStock("SKU-X")).toBe(0);
      expect(inventory.getAllocatedStock("SKU-Y")).toBe(0);
    });
  });

  describe("FakeNotificationService", () => {
    it("sends email receipt and returns tracking messageId", async () => {
      const notification = new FakeNotificationService();
      const res = await notification.sendReceipt("alice@example.com", "ord_100", 250.0);

      expect(res.sent).toBe(true);
      expect(res.messageId).toMatch(/^msg_/);
      expect(notification.getReceipts()).toHaveLength(1);
      expect(notification.getReceipts()[0].email).toBe("alice@example.com");
      expect(notification.getReceipts()[0].amount).toBe(250.0);
    });
  });

  describe("FakeCRMService", () => {
    it("updates customer lifetime value", async () => {
      const crm = new FakeCRMService();
      const res1 = await crm.updateCustomerLifetimeValue("cust_1", 100.0);
      expect(res1.updated).toBe(true);
      expect(crm.getCustomerLifetimeValue("cust_1")).toBe(100.0);

      const res2 = await crm.updateCustomerLifetimeValue("cust_1", 50.0);
      expect(res2.updated).toBe(true);
      expect(crm.getCustomerLifetimeValue("cust_1")).toBe(150.0);
    });
  });

  describe("FakeWarehouseService", () => {
    it("dispatches order and returns tracking number", async () => {
      const warehouse = new FakeWarehouseService();
      const res = await warehouse.dispatchOrder("ord_100", "WH-WEST");

      expect(res.dispatched).toBe(true);
      expect(res.trackingNumber).toMatch(/^TRK-/);
      expect(warehouse.getDispatches()).toHaveLength(1);
      expect(warehouse.getDispatches()[0].destination).toBe("WH-WEST");
    });
  });
});
