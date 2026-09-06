export interface OrderItem {
  sku: string;
  quantity: number;
  price: number;
}

export interface OrderInput {
  orderId: string;
  customerId: string;
  customerEmail: string;
  items: OrderItem[];
  totalAmount: number;
  simulatePaymentFailure?: boolean;
}

export interface OrderOutput {
  orderId: string;
  status: "FULFILLED";
  chargeId: string;
  inventoryReservationId: string;
  invoiceId: string;
  emailSent: boolean;
  crmUpdated: boolean;
  warehouseDispatched: boolean;
}

export interface ChargeParams {
  idempotencyKey: string;
  amount: number;
  customerId: string;
  simulateFailure?: boolean;
}

export interface ChargeResult {
  chargeId: string;
  duplicate: boolean;
}

export interface ChargeRecord {
  chargeId: string;
  amount: number;
  customerId: string;
  timestamp: Date;
}
