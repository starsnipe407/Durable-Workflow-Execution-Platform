# Ticket 04: Retries, Exponential Backoff, and Timeouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Implement per-step failure management in step.run(key, options, fn). When a step handler throws or exceeds its timeout, the engine bounds execution with AbortController, records the failed/timed-out attempt in PostgreSQL, calculates exponential backoff with bounded jitter (U(0.8, 1.2)), sets step_executions.status = RETRY_WAIT with 
ext_retry_at, and suspends the workflow via WorkflowSuspendedError. If retries are exhausted, the step transitions to FAILED and fails the workflow run.

**Architecture:** Extend @durable/database with ailStepAttempt() which conditionally updates the failed attempt and transitions the step to RETRY_WAIT or FAILED within a short transaction. In @durable/workflow-sdk, calculate backoff delay, bound handler execution using native AbortController with 	imeoutMs, and during replay honor RETRY_WAIT (replaying only when 
ext_retry_at <= now).

**Tech Stack:** TypeScript 5.8+, @durable/database, @durable/workflow-sdk, Vitest 3+, PostgreSQL 16, Node.js 22+.

## Global Constraints

- Short-lived DB transactions: ailStepAttempt() commits immediately upon failure logging; no long locks.
- Retry policy specification:
  - Default: etries: 3 (one initial attempt + 3 retries = 4 total attempts).
  - Delay calculation for retry 
 (1-indexed): min(initialMs * 2^(n-1), maxMs) multiplied by jitter U(0.8, 1.2).
  - Default backoff: initialMs: 1000, maxMs: 30000, jitter: true.
- Timeout semantics:
  - Bounded by 	imeoutMs using Node AbortSignal.timeout(timeoutMs) or manual AbortController.
  - On timeout: attempt status becomes TIMED_OUT, 	imed_out = true.
- Atomic durable events: emit STEP_ATTEMPT_FAILED and either STEP_RETRY_SCHEDULED or STEP_FAILED alongside state mutations.
- Committer identity: Aztrek <starsnipe407@gmail.com>.

---

## Producer-to-Consumer Interface Check (Downstream: Ticket 05)

**Downstream consumer:** Ticket 05 (Parallel Steps and Sibling Isolation) consumes:
1. Parallel execution via native Promise.all([step.run("A", ...), step.run("B", ...)]).
2. Sibling failure isolation: when sibling A succeeds and sibling B retries or fails, sibling A''s COMPLETED state must remain intact in PostgreSQL.
3. In-flight promise tracking: awaiting sibling attempts before finishing replay.

Ticket 04 establishes the durable failure state machine (RETRY_WAIT vs FAILED) and ailStepAttempt transaction so that Ticket 05 can independently verify sibling step outcomes without changing retry/timeout interfaces.

---

## File Structure

- packages/database/src/repositories/step-repository.ts: Add ailStepAttempt() transaction.
- packages/database/src/types.ts: Update ClaimStepAttemptResult to include { status: "RETRY_WAIT"; nextRetryAt: Date } and add FailStepAttemptParams.
- packages/workflow-sdk/src/backoff.ts: Exponential backoff calculation with jitter.
- packages/workflow-sdk/src/types.ts: Update StepOptions with ackoff settings.
- packages/workflow-sdk/src/step-context.ts: Wrap handler in AbortController timeout, catch errors, calculate backoff, invoke ailStepAttempt(), and throw WorkflowSuspendedError.
- packages/workflow-sdk/test/step-retries.test.ts: Integration tests verifying retry backoff, attempt exhaustion, timeouts, and replay resumption.

---

### Task 1: Database Failure Repository (ailStepAttempt) & Types

**Files:**
- Modify: packages/database/src/types.ts
- Modify: packages/database/src/repositories/step-repository.ts
- Modify: packages/database/test/fenced-persistence.test.ts

**Interfaces:**
- Consumes: PrismaClient, ecordExecutionEvent
- Produces: ailStepAttempt() recording failed attempt, setting RETRY_WAIT or FAILED, and emitting durable events.

- [ ] **Step 1: Update packages/database/src/types.ts**

Add FailStepAttemptParams and update ClaimStepAttemptResult:
`	ypescript
export type ClaimStepAttemptResult =
  | { status: "COMPLETED"; output: unknown }
  | { status: "RUNNING"; attemptId: string; attemptNumber: number; stepExecutionId: string }
  | { status: "LOCKED"; activeAttemptId: string; leaseExpiresAt: Date }
  | { status: "RETRY_WAIT"; nextRetryAt: Date; error?: unknown };

export interface FailStepAttemptParams {
  tenantId: string;
  workflowRunId: string;
  stepExecutionId: string;
  attemptId: string;
  error: { message: string; type?: string; metadata?: Record<string, unknown> };
  timedOut?: boolean;
  retryDelayMs?: number | null;
  nextRetryAt?: Date | null;
  isTerminalFailure: boolean;
}
`

- [ ] **Step 2: Implement failStepAttempt in packages/database/src/repositories/step-repository.ts**

Update claimStepAttempt to check for RETRY_WAIT:
- If existing.status === "RETRY_WAIT" and existing.next_retry_at && existing.next_retry_at > now, return { status: "RETRY_WAIT", nextRetryAt: existing.next_retry_at }.

Implement ailStepAttempt:
`	ypescript
export async function failStepAttempt(
  db: PrismaClient,
  params: FailStepAttemptParams
): Promise<void> {
  const {
    tenantId,
    workflowRunId,
    stepExecutionId,
    attemptId,
    error,
    timedOut = false,
    retryDelayMs = null,
    nextRetryAt = null,
    isTerminalFailure
  } = params;

  await db.(async (tx) => {
    // 1. Update attempt record
    await tx.stepAttempt.update({
      where: { id: attemptId },
      data: {
        status: timedOut ? "TIMED_OUT" : "FAILED",
        errorMessage: error.message,
        errorType: error.type ?? (timedOut ? "TimeoutError" : "Error"),
        errorMetadata: (error.metadata ?? {}) as any,
        retryDelayMs,
        timedOut,
        finishedAt: new Date()
      }
    });

    // 2. Record STEP_ATTEMPT_FAILED event
    await recordExecutionEvent(tx, {
      tenantId,
      workflowRunId,
      stepExecutionId,
      stepAttemptId: attemptId,
      eventType: "STEP_ATTEMPT_FAILED",
      payload: { error: error.message, timedOut, retryDelayMs }
    });

    // 3. Update step_executions
    if (isTerminalFailure) {
      await tx.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "FAILED",
          error: error as any,
          failedAt: new Date()
        }
      });

      await recordExecutionEvent(tx, {
        tenantId,
        workflowRunId,
        stepExecutionId,
        eventType: "STEP_FAILED",
        payload: { error: error.message }
      });
    } else {
      await tx.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "RETRY_WAIT",
          nextRetryAt,
          error: error as any
        }
      });

      await recordExecutionEvent(tx, {
        tenantId,
        workflowRunId,
        stepExecutionId,
        eventType: "STEP_RETRY_SCHEDULED",
        payload: { nextRetryAt, retryDelayMs }
      });
    }
  });
}
`

- [ ] **Step 3: Write test in packages/database/test/fenced-persistence.test.ts verifying failStepAttempt**

`	ypescript
it("records step attempt failure and transitions to RETRY_WAIT", async () => {
  const run = await createWorkflowRun(db, {
    tenantId,
    workflowName: "fail-wf",
    workflowVersion: "v1",
    input: {}
  });

  const claim = await claimStepAttempt(db, {
    tenantId,
    workflowRunId: run.id,
    stepKey: "step-fail",
    workerId: "worker-1",
    leaseDurationMs: 10_000
  });
  if (claim.status !== "RUNNING") throw new Error("claim failed");

  const nextRetryAt = new Date(Date.now() + 5000);
  await failStepAttempt(db, {
    tenantId,
    workflowRunId: run.id,
    stepExecutionId: claim.stepExecutionId,
    attemptId: claim.attemptId,
    error: { message: "Simulated failure" },
    retryDelayMs: 5000,
    nextRetryAt,
    isTerminalFailure: false
  });

  // Next claim before nextRetryAt must return RETRY_WAIT
  const retryClaim = await claimStepAttempt(db, {
    tenantId,
    workflowRunId: run.id,
    stepKey: "step-fail",
    workerId: "worker-1",
    leaseDurationMs: 10_000
  });
  expect(retryClaim.status).toBe("RETRY_WAIT");
});
`

- [ ] **Step 4: Run test and verify PASS**

Run: 
px dotenv-cli -e .env.test -- pnpm --filter @durable/database test
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

`ash
git add packages/database
git commit -m "feat(database): implement failStepAttempt and RETRY_WAIT claim checks"
`

---

### Task 2: Exponential Backoff Calculator and StepOptions Expansion

**Files:**
- Create: packages/workflow-sdk/src/backoff.ts
- Modify: packages/workflow-sdk/src/types.ts
- Create: packages/workflow-sdk/test/backoff.test.ts

**Interfaces:**
- Consumes: None
- Produces: calculateBackoffDelay(attemptNumber, options) returning delay in ms with bounded jitter.

- [ ] **Step 1: Write failing test in packages/workflow-sdk/test/backoff.test.ts**

`	ypescript
import { describe, it, expect } from "vitest";
import { calculateBackoffDelay } from "../src/backoff.js";

describe("calculateBackoffDelay", () => {
  it("calculates exponential delay with bounded jitter U(0.8, 1.2)", () => {
    const options = {
      type: "exponential" as const,
      initialMs: 1000,
      maxMs: 30000,
      jitter: true
    };

    // Attempt 1 (first retry): base = 1000ms, with jitter [800, 1200]
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
      type: "exponential" as const,
      initialMs: 500,
      maxMs: 5000,
      jitter: false
    };

    expect(calculateBackoffDelay(1, options)).toBe(500);
    expect(calculateBackoffDelay(2, options)).toBe(1000);
    expect(calculateBackoffDelay(3, options)).toBe(2000);
    expect(calculateBackoffDelay(5, options)).toBe(5000); // capped at maxMs
  });
});
`

- [ ] **Step 2: Run test to verify it fails**

Run: pnpm --filter @durable/workflow-sdk test
Expected: FAIL (ackoff.js not found)

- [ ] **Step 3: Implement packages/workflow-sdk/src/backoff.ts and update types.ts**

In packages/workflow-sdk/src/types.ts:
`	ypescript
export interface BackoffOptions {
  type?: "exponential";
  initialMs?: number;
  maxMs?: number;
  jitter?: boolean;
}

export interface StepOptions {
  retries?: number;
  backoff?: BackoffOptions;
  timeoutMs?: number;
  idempotencyKey?: string;
}
`

In packages/workflow-sdk/src/backoff.ts:
`	ypescript
import type { BackoffOptions } from "./types.js";

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  type: "exponential",
  initialMs: 1000,
  maxMs: 30000,
  jitter: true
};

export function calculateBackoffDelay(
  attemptNumber: number,
  options?: BackoffOptions
): number {
  const initialMs = options?.initialMs ?? DEFAULT_BACKOFF.initialMs;
  const maxMs = options?.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const useJitter = options?.jitter ?? DEFAULT_BACKOFF.jitter;

  // delay = min(initialMs * 2^(attemptNumber - 1), maxMs)
  const baseDelay = Math.min(initialMs * Math.pow(2, Math.max(0, attemptNumber - 1)), maxMs);

  if (!useJitter) {
    return Math.round(baseDelay);
  }

  // Bounded jitter U(0.8, 1.2)
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.round(baseDelay * jitterFactor);
}
`

- [ ] **Step 4: Run test to verify it passes**

Run: pnpm --filter @durable/workflow-sdk test
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

`ash
git add packages/workflow-sdk/src packages/workflow-sdk/test/backoff.test.ts
git commit -m "feat(workflow-sdk): implement exponential backoff calculation with jitter"
`

---

### Task 3: Step Failure Handling, Timeouts, and Replay Integration

**Files:**
- Modify: packages/workflow-sdk/src/step-context.ts
- Modify: packages/workflow-sdk/src/index.ts
- Create: packages/workflow-sdk/test/step-retries.test.ts

**Interfaces:**
- Consumes: ailStepAttempt, calculateBackoffDelay, StepOptions
- Produces: Integrated timeout aborts (AbortController), retry suspension with backoff delay, and attempt exhaustion failure.

- [ ] **Step 1: Write failing integration test in packages/workflow-sdk/test/step-retries.test.ts**

`	ypescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { defineWorkflow } from "../src/workflow.js";
import { WorkflowExecutor } from "../src/executor.js";

describe("Step Retries, Backoff, and Timeouts", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "retry-test-tenant" } });
    tenantId = tenant.id;
  });

  it("retries a failing step with backoff, then succeeds on subsequent replay", async () => {
    let attemptCount = 0;
    const workflow = defineWorkflow<{ id: string }, { done: boolean }>(
      { name: "retry-wf", version: "v1" },
      async ({ input, step }) => {
        await step.run(
          "flaky-step",
          { retries: 2, backoff: { initialMs: 100, jitter: false } },
          async () => {
            attemptCount++;
            if (attemptCount === 1) {
              throw new Error("TEMPORARY_NETWORK_FAILURE");
            }
            return "success";
          }
        );
        return { done: true };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "retry-wf",
      workflowVersion: "v1",
      input: { id: "test-1" }
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-1" });

    // Execution 1: fails attempt 1, transitions step to RETRY_WAIT, suspends workflow
    const result1 = await executor.execute(workflow, run.id);
    expect(result1).toBeUndefined();
    expect(attemptCount).toBe(1);

    const stepRecord = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "flaky-step" } }
    });
    expect(stepRecord?.status).toBe("RETRY_WAIT");
    expect(stepRecord?.attemptCount).toBe(1);

    // Fast-forward nextRetryAt to simulate time elapsed
    await db.stepExecution.update({
      where: { id: stepRecord!.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) }
    });

    // Execution 2: due retry executes attempt 2 and succeeds
    const result2 = await executor.execute(workflow, run.id);
    expect(result2).toEqual({ done: true });
    expect(attemptCount).toBe(2);

    const finalStep = await db.stepExecution.findUnique({
      where: { id: stepRecord!.id }
    });
    expect(finalStep?.status).toBe("COMPLETED");
  });

  it("aborts handler when timeoutMs is exceeded and marks attempt TIMED_OUT", async () => {
    const workflow = defineWorkflow<{ id: string }, { done: boolean }>(
      { name: "timeout-wf", version: "v1" },
      async ({ input, step }) => {
        await step.run(
          "slow-step",
          { retries: 0, timeoutMs: 50 },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return "ok";
          }
        );
        return { done: true };
      }
    );

    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "timeout-wf",
      workflowVersion: "v1",
      input: { id: "test-timeout" }
    });

    const executor = new WorkflowExecutor({ db, workerId: "worker-1" });

    // Should fail because retries: 0 and timeout exceeded
    await expect(executor.execute(workflow, run.id)).rejects.toThrow();

    const attempt = await db.stepAttempt.findFirst({
      where: { tenantId, stepExecution: { stepKey: "slow-step" } }
    });
    expect(attempt?.status).toBe("TIMED_OUT");
    expect(attempt?.timedOut).toBe(true);
  });
});
`

- [ ] **Step 2: Run test to verify it fails**

Run: 
px dotenv-cli -e .env.test -- pnpm --filter @durable/workflow-sdk test
Expected: FAIL (step failure handling not wired in step-context.ts)

- [ ] **Step 3: Update packages/workflow-sdk/src/step-context.ts to handle failures, retries, and timeouts**

`	ypescript
import type { PrismaClient } from "@durable/database";
import { claimStepAttempt, completeStepAttempt, failStepAttempt } from "@durable/database";
import { DuplicateStepKeyError, WorkflowSuspendedError } from "./errors.js";
import { calculateBackoffDelay } from "./backoff.js";
import type { StepContext, StepOptions } from "./types.js";

export interface StepContextOptions {
  db: PrismaClient;
  tenantId: string;
  workflowRunId: string;
  workerId: string;
  leaseDurationMs: number;
  seenKeys: Set<string>;
}

export class StepContextImpl implements StepContext {
  private readonly db: PrismaClient;
  private readonly tenantId: string;
  private readonly workflowRunId: string;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly seenKeys: Set<string>;

  constructor(options: StepContextOptions) {
    this.db = options.db;
    this.tenantId = options.tenantId;
    this.workflowRunId = options.workflowRunId;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs;
    this.seenKeys = options.seenKeys;
  }

  run<T>(key: string, handler: () => Promise<T>): Promise<T>;
  run<T>(key: string, options: StepOptions, handler: () => Promise<T>): Promise<T>;
  async run<T>(
    key: string,
    optionsOrHandler: StepOptions | (() => Promise<T>),
    maybeHandler?: () => Promise<T>
  ): Promise<T> {
    if (this.seenKeys.has(key)) {
      throw new DuplicateStepKeyError(key);
    }
    this.seenKeys.add(key);

    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler!;
    const options = typeof optionsOrHandler === "object" ? optionsOrHandler : {};

    return await this.executeStep<T>(key, options, handler);
  }

  protected async executeStep<T>(key: string, options: StepOptions, handler: () => Promise<T>): Promise<T> {
    const claim = await claimStepAttempt(this.db, {
      tenantId: this.tenantId,
      workflowRunId: this.workflowRunId,
      stepKey: key,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs
    });

    if (claim.status === "COMPLETED") {
      return claim.output as T;
    }

    if (claim.status === "LOCKED") {
      throw new WorkflowSuspendedError(Step "" is currently locked by attempt .);
    }

    if (claim.status === "RETRY_WAIT") {
      throw new WorkflowSuspendedError(Step "" is in RETRY_WAIT until .);
    }

    const maxRetries = options.retries ?? 3; // 1 initial + 3 retries
    const timeoutMs = options.timeoutMs;

    let output: T;
    let timedOut = false;

    try {
      if (timeoutMs && timeoutMs > 0) {
        output = await this.executeWithTimeout(handler, timeoutMs);
      } else {
        output = await handler();
      }
    } catch (err: any) {
      timedOut = err.name === "TimeoutError" || err.message?.includes("timed out");
      const isTerminalFailure = claim.attemptNumber > maxRetries;
      let retryDelayMs: number | null = null;
      let nextRetryAt: Date | null = null;

      if (!isTerminalFailure) {
        retryDelayMs = calculateBackoffDelay(claim.attemptNumber, options.backoff);
        nextRetryAt = new Date(Date.now() + retryDelayMs);
      }

      await failStepAttempt(this.db, {
        tenantId: this.tenantId,
        workflowRunId: this.workflowRunId,
        stepExecutionId: claim.stepExecutionId,
        attemptId: claim.attemptId,
        error: { message: err instanceof Error ? err.message : String(err), type: err.name },
        timedOut,
        retryDelayMs,
        nextRetryAt,
        isTerminalFailure
      });

      if (isTerminalFailure) {
        throw err;
      }

      throw new WorkflowSuspendedError(Step "" failed attempt , retry scheduled in ms.);
    }

    // Commit completion with fencing
    await completeStepAttempt(this.db, {
      tenantId: this.tenantId,
      workflowRunId: this.workflowRunId,
      stepExecutionId: claim.stepExecutionId,
      attemptId: claim.attemptId,
      output
    });

    return output;
  }

  private executeWithTimeout<T>(handler: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutErr = new Error(Step execution timed out after ms.);
        timeoutErr.name = "TimeoutError";
        reject(timeoutErr);
      }, timeoutMs);

      handler()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
`

- [ ] **Step 4: Run tests and verify PASS**

Run: 
px dotenv-cli -e .env.test -- pnpm --filter @durable/workflow-sdk test
Expected: PASS (all tests pass, including retries and timeouts).

- [ ] **Step 5: Run workspace build**

Run: pnpm build
Expected: Clean build across workspace.

- [ ] **Step 6: Commit**

`ash
git add packages/workflow-sdk
git commit -m "feat(workflow-sdk): implement step failure handling, retries, and timeouts"
`

---

### Task 4: Final Verification and Ticket 04 Completion Gate

**Files:**
- Modify: .scratch/durable-engine/issues/04-retries-backoff-and-timeouts.md

- [ ] **Step 1: Run full test suite across the monorepo**

Run: 
px dotenv-cli -e .env.test -- pnpm test
Expected: All tests pass across @durable/shared, @durable/database, and @durable/workflow-sdk.

- [ ] **Step 2: Update Ticket 04 issue file**

Modify: .scratch/durable-engine/issues/04-retries-backoff-and-timeouts.md
Mark all acceptance criteria checkboxes checked [x] and update status to completed.

- [ ] **Step 3: Commit**

`ash
git add .scratch/durable-engine/issues/04-retries-backoff-and-timeouts.md
git commit -m "chore(ticket-04): mark retries, exponential backoff, and timeouts complete"
`
