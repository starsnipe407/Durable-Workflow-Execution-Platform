import { randomUUID } from "node:crypto";
import type { ChargeParams, ChargeRecord, ChargeResult } from "../types.js";

export class FakePaymentGateway {
  private readonly charges = new Map<string, ChargeRecord>();
  private readonly failedKeys = new Set<string>();

  async charge(params: ChargeParams): Promise<ChargeResult> {
    // If simulateFailure is true and this is the first call for this idempotency key: throw transient error
    if (
      params.simulateFailure &&
      !this.failedKeys.has(params.idempotencyKey) &&
      !this.charges.has(params.idempotencyKey)
    ) {
      this.failedKeys.add(params.idempotencyKey);
      throw new Error("Payment gateway network timeout (transient)");
    }

    // Deduplicate if already charged under this idempotency key
    if (this.charges.has(params.idempotencyKey)) {
      const existing = this.charges.get(params.idempotencyKey)!;
      return {
        chargeId: existing.chargeId,
        duplicate: true
      };
    }

    // New charge
    const chargeId = `ch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const record: ChargeRecord = {
      chargeId,
      amount: params.amount,
      customerId: params.customerId,
      timestamp: new Date()
    };

    this.charges.set(params.idempotencyKey, record);

    return {
      chargeId,
      duplicate: false
    };
  }

  getChargeCount(): number {
    return this.charges.size;
  }

  getCharge(idempotencyKey: string): ChargeRecord | undefined {
    return this.charges.get(idempotencyKey);
  }

  reset(): void {
    this.charges.clear();
    this.failedKeys.clear();
  }
}
