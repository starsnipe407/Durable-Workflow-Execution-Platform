import { randomUUID } from "node:crypto";

export interface StockReservationItem {
  sku: string;
  quantity: number;
}

export interface InventoryReservationResult {
  reservationId: string;
  items: string[];
}

export class FakeInventoryService {
  private readonly allocatedStock = new Map<string, number>();
  private readonly reservations = new Map<string, StockReservationItem[]>();

  async reserve(
    orderId: string,
    items: Array<{ sku: string; quantity: number }>
  ): Promise<InventoryReservationResult> {
    const reservationId = `res_${orderId}`;
    for (const item of items) {
      const current = this.allocatedStock.get(item.sku) ?? 0;
      this.allocatedStock.set(item.sku, current + item.quantity);
    }
    this.reservations.set(reservationId, [...items]);
    return {
      reservationId,
      items: items.map((i) => i.sku)
    };
  }

  async release(reservationId: string): Promise<void> {
    const items = this.reservations.get(reservationId);
    if (!items) return;

    for (const item of items) {
      const current = this.allocatedStock.get(item.sku) ?? 0;
      const updated = Math.max(0, current - item.quantity);
      if (updated === 0) {
        this.allocatedStock.delete(item.sku);
      } else {
        this.allocatedStock.set(item.sku, updated);
      }
    }
    this.reservations.delete(reservationId);
  }

  getAllocatedStock(sku: string): number {
    return this.allocatedStock.get(sku) ?? 0;
  }

  reset(): void {
    this.allocatedStock.clear();
    this.reservations.clear();
  }
}

export interface EmailReceiptRecord {
  email: string;
  orderId: string;
  amount: number;
  messageId: string;
  timestamp: Date;
}

export class FakeNotificationService {
  private readonly receipts: EmailReceiptRecord[] = [];

  async sendReceipt(
    email: string,
    orderId: string,
    amount: number
  ): Promise<{ sent: boolean; messageId: string }> {
    const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.receipts.push({
      email,
      orderId,
      amount,
      messageId,
      timestamp: new Date()
    });
    return {
      sent: true,
      messageId
    };
  }

  getReceipts(): EmailReceiptRecord[] {
    return [...this.receipts];
  }

  reset(): void {
    this.receipts.length = 0;
  }
}

export class FakeCRMService {
  private readonly customerLTV = new Map<string, number>();

  async updateCustomerLifetimeValue(
    customerId: string,
    amount: number
  ): Promise<{ updated: boolean }> {
    const current = this.customerLTV.get(customerId) ?? 0;
    this.customerLTV.set(customerId, current + amount);
    return { updated: true };
  }

  getCustomerLifetimeValue(customerId: string): number {
    return this.customerLTV.get(customerId) ?? 0;
  }

  reset(): void {
    this.customerLTV.clear();
  }
}

export interface DispatchRecord {
  orderId: string;
  destination: string;
  trackingNumber: string;
  timestamp: Date;
}

export class FakeWarehouseService {
  private readonly dispatches: DispatchRecord[] = [];

  async dispatchOrder(
    orderId: string,
    destination: string
  ): Promise<{ dispatched: boolean; trackingNumber: string }> {
    const trackingNumber = `TRK-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    this.dispatches.push({
      orderId,
      destination,
      trackingNumber,
      timestamp: new Date()
    });
    return {
      dispatched: true,
      trackingNumber
    };
  }

  getDispatches(): DispatchRecord[] {
    return [...this.dispatches];
  }

  reset(): void {
    this.dispatches.length = 0;
  }
}
