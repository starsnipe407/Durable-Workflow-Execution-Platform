import { describe, it, expect } from "vitest";
import { calculateBackoffDelay } from "../src/backoff.js";

describe("calculateBackoffDelay", () => {
  it("calculates exponential delay with bounded jitter U(0.8, 1.2)", () => {
    const options = {
      initialMs: 1000,
      maxMs: 30000,
      jitter: true,
    };

    // Attempt 1: base = 1000ms, with jitter [800, 1200]
    const d1 = calculateBackoffDelay(1, options);
    expect(d1).toBeGreaterThanOrEqual(800);
    expect(d1).toBeLessThanOrEqual(1200);

    // Attempt 2: base = 2000ms, with jitter [1600, 2400]
    const d2 = calculateBackoffDelay(2, options);
    expect(d2).toBeGreaterThanOrEqual(1600);
    expect(d2).toBeLessThanOrEqual(2400);

    // Caps at maxMs = 30000ms, with jitter [24000, 36000]
    const d10 = calculateBackoffDelay(10, options);
    expect(d10).toBeLessThanOrEqual(36000);
  });

  it("calculates exact delay without jitter", () => {
    const options = {
      initialMs: 500,
      maxMs: 5000,
      jitter: false,
    };

    expect(calculateBackoffDelay(1, options)).toBe(500);
    expect(calculateBackoffDelay(2, options)).toBe(1000);
    expect(calculateBackoffDelay(3, options)).toBe(2000);
    expect(calculateBackoffDelay(5, options)).toBe(5000); // capped at maxMs
  });
});
