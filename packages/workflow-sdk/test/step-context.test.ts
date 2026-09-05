import { describe, it, expect, vi } from "vitest";
import { StepContextImpl } from "../src/step-context.js";
import { DuplicateStepKeyError, WorkflowSuspendedError } from "../src/errors.js";
import type { PrismaClient } from "@durable/database";
import * as dbModule from "@durable/database";

describe("StepContextImpl", () => {
  it("throws DuplicateStepKeyError when the same step key is called twice in one replay pass", async () => {
    const seenKeys = new Set<string>();
    const context = new StepContextImpl({
      db: {} as PrismaClient,
      tenantId: "tenant-1",
      workflowRunId: "run-1",
      workerId: "worker-1",
      leaseDurationMs: 30000,
      seenKeys
    });

    vi.spyOn(context as any, "executeStep").mockImplementation(async (_key: string, _options: any, handler: () => Promise<any>) => {
      return await handler();
    });

    const first = await context.run("my-step", async () => "first-result");
    expect(first).toBe("first-result");

    await expect(
      context.run("my-step", async () => "second-result")
    ).rejects.toThrow(DuplicateStepKeyError);
  });

  it("supports both (key, handler) and (key, options, handler) overloads", async () => {
    const seenKeys = new Set<string>();
    const context = new StepContextImpl({
      db: {} as PrismaClient,
      tenantId: "tenant-1",
      workflowRunId: "run-1",
      workerId: "worker-1",
      leaseDurationMs: 30000,
      seenKeys
    });

    const executeSpy = vi
      .spyOn(context as any, "executeStep")
      .mockImplementation(async (_key: string, _options: any, handler: () => Promise<any>) => {
        return await handler();
      });

    const res1 = await context.run("step-1", async () => 42);
    expect(res1).toBe(42);
    expect(executeSpy).toHaveBeenLastCalledWith("step-1", {}, expect.any(Function));

    const res2 = await context.run("step-2", { retries: 3 }, async () => "hello");
    expect(res2).toBe("hello");
    expect(executeSpy).toHaveBeenLastCalledWith("step-2", { retries: 3 }, expect.any(Function));
  });

  it("returns memoized result when claimStepAttempt returns COMPLETED without executing handler", async () => {
    const seenKeys = new Set<string>();
    const context = new StepContextImpl({
      db: {} as PrismaClient,
      tenantId: "tenant-1",
      workflowRunId: "run-1",
      workerId: "worker-1",
      leaseDurationMs: 30000,
      seenKeys
    });

    vi.spyOn(dbModule, "claimStepAttempt").mockResolvedValue({
      status: "COMPLETED",
      output: { memoized: true }
    });
    const handler = vi.fn().mockResolvedValue({ memoized: false });

    const result = await context.run("step-memo", handler);
    expect(result).toEqual({ memoized: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("throws WorkflowSuspendedError when claimStepAttempt returns LOCKED", async () => {
    const seenKeys = new Set<string>();
    const context = new StepContextImpl({
      db: {} as PrismaClient,
      tenantId: "tenant-1",
      workflowRunId: "run-1",
      workerId: "worker-1",
      leaseDurationMs: 30000,
      seenKeys
    });

    vi.spyOn(dbModule, "claimStepAttempt").mockResolvedValue({
      status: "LOCKED",
      activeAttemptId: "att-123",
      leaseExpiresAt: new Date(Date.now() + 10000)
    });

    await expect(
      context.run("step-locked", async () => "val")
    ).rejects.toThrow(WorkflowSuspendedError);
  });

  it("claims attempt, executes handler outside db tx, and completes attempt with fencing", async () => {
    const seenKeys = new Set<string>();
    const context = new StepContextImpl({
      db: {} as PrismaClient,
      tenantId: "tenant-1",
      workflowRunId: "run-1",
      workerId: "worker-1",
      leaseDurationMs: 30000,
      seenKeys
    });

    vi.spyOn(dbModule, "claimStepAttempt").mockResolvedValue({
      status: "RUNNING",
      attemptId: "att-new",
      attemptNumber: 1,
      stepExecutionId: "step-exec-1"
    });
    const completeSpy = vi.spyOn(dbModule, "completeStepAttempt").mockResolvedValue({} as any);

    const handler = vi.fn().mockResolvedValue({ calculated: 123 });
    const result = await context.run("step-run", handler);

    expect(result).toEqual({ calculated: 123 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tenant-1",
      workflowRunId: "run-1",
      stepExecutionId: "step-exec-1",
      attemptId: "att-new",
      output: { calculated: 123 }
    });
  });
});
