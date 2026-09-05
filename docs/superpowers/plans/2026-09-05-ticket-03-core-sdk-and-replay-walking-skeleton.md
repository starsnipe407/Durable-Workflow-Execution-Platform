# Ticket 03: Core SDK and Replay Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build the developer-facing workflow SDK (packages/workflow-sdk) and execution engine, proving the core durable execution guarantee: a two-step workflow (step-1 -> step-2) where step-1 commits, the worker crashes, and a fresh replay executes step-2 while returning the memoized result of step-1 (call count = 1).

**Architecture:** A lightweight, code-first durable workflow engine. defineWorkflow() registers an asynchronous workflow function receiving a run-bound StepContext. step.run(stepKey, handler) detects duplicate step keys in-memory (Set<string>), queries PostgreSQL for memoized results, claims new attempts via short-lived transactions, executes user handlers asynchronously outside open database transactions, and commits fenced completions with ctive_attempt_id. When non-runnable steps are encountered, WorkflowSuspendedError cleanly unwinds the replay stack. State transitions emit atomic durable execution events.

**Tech Stack:** TypeScript 5.8+, @durable/database, @durable/shared, Vitest 3+, PostgreSQL 16, Node.js 22+.

## Global Constraints

- Monorepo package: packages/workflow-sdk (@durable/workflow-sdk).
- Module format: ESM-first ("type": "module").
- Short-lived DB transactions: user step handlers MUST execute outside open database transactions.
- Replay invariants:
  - Memoized steps return outputs from PostgreSQL and do NOT re-execute their handlers.
  - Step key stability: duplicate step keys within the same replay invocation throw DuplicateStepKeyError.
  - Non-runnable or suspended steps throw WorkflowSuspendedError to unwind replay.
  - Execution events: WORKFLOW_STARTED, STEP_STARTED, STEP_COMPLETED, WORKFLOW_COMPLETED must be emitted atomically alongside state changes.
- Git author and committer identity: Aztrek <starsnipe407@gmail.com>.

---

## Producer-to-Consumer Interface Check (Downstream: Ticket 04)

**Downstream consumer:** Ticket 04 (Retries, Exponential Backoff, and Timeouts) will consume and extend:
1. step.run(key, options?, handler):
   - Ticket 03 introduces StepOptions signature: { retries?: number; timeoutMs?: number; idempotencyKey?: string } (overload supported).
   - Ticket 04 will expand options to handle backoff calculations and AbortController timeout bounding.
2. WorkflowExecutor.execute(runId):
   - Returns { status: "COMPLETED", output } or { status: "SUSPENDED" } or { status: "FAILED", error }.
3. WorkflowContext / StepContext:
   - step.run<T>(key: string, handler: () => Promise<T>): Promise<T>
   - step.run<T>(key: string, options: StepOptions, handler: () => Promise<T>): Promise<T>
4. Error hierarchy:
   - WorkflowSuspendedError
   - DuplicateStepKeyError

All signatures established in Ticket 03 directly support Ticket 04''s extensions without breaking changes.

---

## File Structure

- packages/workflow-sdk/package.json: Manifest for @durable/workflow-sdk depending on @durable/database and @durable/shared.
- packages/workflow-sdk/tsconfig.json: Extends root tsconfig.
- packages/workflow-sdk/src/errors.ts: DuplicateStepKeyError and WorkflowSuspendedError.
- packages/workflow-sdk/src/types.ts: WorkflowDefinition, WorkflowConfig, StepOptions, WorkflowHandler, StepContext.
- packages/workflow-sdk/src/workflow.ts: defineWorkflow() implementation.
- packages/workflow-sdk/src/step-context.ts: StepContextImpl implementing step.run() with memoization, claiming, and fenced completion.
- packages/workflow-sdk/src/executor.ts: WorkflowExecutor coordinating replay, run status transitions, in-memory key tracking, and execution events.
- packages/workflow-sdk/src/index.ts: Public exports.
- packages/workflow-sdk/test/replay-walking-skeleton.test.ts: Flagship integration test demonstrating step memoization, simulated crash, replay, and execution event persistence against PostgreSQL.

---

### Task 1: Package Scaffolding, Domain Types, and Error Sentinels

**Files:**
- Create: packages/workflow-sdk/package.json
- Create: packages/workflow-sdk/tsconfig.json
- Create: packages/workflow-sdk/src/errors.ts
- Create: packages/workflow-sdk/src/types.ts
- Create: packages/workflow-sdk/src/workflow.ts

**Interfaces:**
- Consumes: @durable/database, @durable/shared
- Produces: defineWorkflow(), DuplicateStepKeyError, WorkflowSuspendedError, and workflow types.

- [ ] **Step 1: Create packages/workflow-sdk/package.json**

`json
{
  "name": "@durable/workflow-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run"
  },
  "dependencies": {
    "@durable/database": "workspace:*",
    "@durable/shared": "workspace:*"
  },
  "devDependencies": {
    "dotenv-cli": "^8.0.0",
    "typescript": "^5.8.2",
    "vitest": "^3.0.7"
  }
}
`

- [ ] **Step 2: Create packages/workflow-sdk/tsconfig.json**

`json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
`

- [ ] **Step 3: Create packages/workflow-sdk/src/errors.ts**

`	ypescript
export class DuplicateStepKeyError extends Error {
  constructor(stepKey: string) {
    super(Step key "" was invoked more than once in the same workflow run invocation. Step keys must be unique.);
    this.name = "DuplicateStepKeyError";
  }
}

export class WorkflowSuspendedError extends Error {
  constructor(reason = "Workflow execution suspended waiting for step completion or retry.") {
    super(reason);
    this.name = "WorkflowSuspendedError";
  }
}
`

- [ ] **Step 4: Create packages/workflow-sdk/src/types.ts**

`	ypescript
export interface StepOptions {
  retries?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface StepContext {
  run<T>(key: string, handler: () => Promise<T>): Promise<T>;
  run<T>(key: string, options: StepOptions, handler: () => Promise<T>): Promise<T>;
}

export interface WorkflowContext<TInput = unknown> {
  input: TInput;
  step: StepContext;
}

export type WorkflowHandler<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowContext<TInput>
) => Promise<TOutput>;

export interface WorkflowConfig<TInput = unknown> {
  name: string;
  version: string;
  trigger?: { event: string };
  concurrency?: {
    limit?: number;
    key?: (ctx: { input: TInput }) => string | undefined;
  };
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  config: WorkflowConfig<TInput>;
  handler: WorkflowHandler<TInput, TOutput>;
}
`

- [ ] **Step 5: Create packages/workflow-sdk/src/workflow.ts**

`	ypescript
import type { WorkflowConfig, WorkflowDefinition, WorkflowHandler } from "./types.js";

export function defineWorkflow<TInput = unknown, TOutput = unknown>(
  config: WorkflowConfig<TInput>,
  handler: WorkflowHandler<TInput, TOutput>
): WorkflowDefinition<TInput, TOutput> {
  return { config, handler };
}
`

- [ ] **Step 6: Run pnpm install and verify build**

Run: pnpm install
Run: pnpm --filter @durable/workflow-sdk build
Expected: Compiles cleanly to dist/.

- [ ] **Step 7: Commit**

`ash
git add packages/workflow-sdk pnpm-lock.yaml
git commit -m "feat(workflow-sdk): scaffold package, defineWorkflow, and error sentinels"
`

---

### Task 2: StepContext and In-Memory Duplicate Key Enforcement

**Files:**
- Create: packages/workflow-sdk/src/step-context.ts
- Create: packages/workflow-sdk/test/step-context.test.ts

**Interfaces:**
- Consumes: @durable/database (claimStepAttempt, completeStepAttempt), DuplicateStepKeyError, WorkflowSuspendedError
- Produces: StepContextImpl implementing step.run() with in-memory key tracking, memoization return, and short-lived attempt claims.

- [ ] **Step 1: Write failing test in packages/workflow-sdk/test/step-context.test.ts**

`	ypescript
import { describe, it, expect, vi } from "vitest";
import { StepContextImpl } from "../src/step-context.js";
import { DuplicateStepKeyError, WorkflowSuspendedError } from "../src/errors.js";

describe("StepContextImpl", () => {
  it("throws DuplicateStepKeyError when the same step key is called twice in one replay pass", async () => {
    const fakeDb = {} as any;
    const seenKeys = new Set<string>();
    const context = new StepContextImpl({
      db: fakeDb,
      tenantId: "tenant-1",
      workflowRunId: "run-1",
      workerId: "worker-1",
      leaseDurationMs: 10_000,
      seenKeys
    });

    // Mock internal claim/execute for first call
    vi.spyOn(context as any, "executeStep").mockResolvedValue("first-result");

    const result1 = await context.run("my-step", async () => "first-result");
    expect(result1).toBe("first-result");

    // Second call with same key must throw DuplicateStepKeyError immediately
    await expect(context.run("my-step", async () => "second-result")).rejects.toThrow(
      DuplicateStepKeyError
    );
  });
});
`

- [ ] **Step 2: Run test to verify it fails**

Run: pnpm --filter @durable/workflow-sdk test
Expected: FAIL (step-context.js not found)

- [ ] **Step 3: Implement packages/workflow-sdk/src/step-context.ts**

`	ypescript
import type { PrismaClient } from "@durable/database";
import { claimStepAttempt, completeStepAttempt } from "@durable/database";
import { DuplicateStepKeyError, WorkflowSuspendedError } from "./errors.js";
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

  protected async executeStep<T>(key: string, _options: StepOptions, handler: () => Promise<T>): Promise<T> {
    // 1. Claim step attempt (short-lived DB transaction)
    const claim = await claimStepAttempt(this.db, {
      tenantId: this.tenantId,
      workflowRunId: this.workflowRunId,
      stepKey: key,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs
    });

    // 2. If already COMPLETED, return memoized result immediately
    if (claim.status === "COMPLETED") {
      return claim.output as T;
    }

    // 3. If locked by another worker, suspend replay
    if (claim.status === "LOCKED") {
      throw new WorkflowSuspendedError(Step "" is currently locked by attempt .);
    }

    // 4. Execute user handler OUTSIDE database transaction
    let output: T;
    try {
      output = await handler();
    } catch (err) {
      // In Ticket 04 we record attempt failure and calculate backoff; for now rethrow
      throw err;
    }

    // 5. Complete step attempt with fencing (short-lived DB transaction)
    await completeStepAttempt(this.db, {
      tenantId: this.tenantId,
      workflowRunId: this.workflowRunId,
      stepExecutionId: claim.stepExecutionId,
      attemptId: claim.attemptId,
      output
    });

    return output;
  }
}
`

- [ ] **Step 4: Run test to verify it passes**

Run: pnpm --filter @durable/workflow-sdk test
Expected: PASS (1 test passed)

- [ ] **Step 5: Commit**

`ash
git add packages/workflow-sdk/src/step-context.ts packages/workflow-sdk/test/step-context.test.ts
git commit -m "feat(workflow-sdk): implement StepContext with duplicate key check and short-lived claims"
`

---

### Task 3: WorkflowExecutor Replay Engine and Walking Skeleton Integration Test

**Files:**
- Create: packages/workflow-sdk/src/executor.ts
- Create: packages/workflow-sdk/src/index.ts
- Create: packages/workflow-sdk/test/replay-walking-skeleton.test.ts

**Interfaces:**
- Consumes: WorkflowDefinition, StepContextImpl, @durable/database (createWorkflowRun, ecordExecutionEvent, createPrismaClient)
- Produces: WorkflowExecutor and passing end-to-end crash-and-replay walking skeleton integration test.

- [ ] **Step 1: Write failing test in packages/workflow-sdk/test/replay-walking-skeleton.test.ts**

`	ypescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createPrismaClient, createWorkflowRun } from "@durable/database";
import { defineWorkflow } from "../src/workflow.js";
import { WorkflowExecutor } from "../src/executor.js";

describe("Replay Walking Skeleton Integration Test", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "replay-test-tenant" } });
    tenantId = tenant.id;
  });

  it("completes step 1, survives simulated worker crash, and replays step 1 from DB memoization before executing step 2", async () => {
    let step1CallCount = 0;
    let step2CallCount = 0;
    let shouldCrash = true;

    // Define 2-step workflow
    const testWorkflow = defineWorkflow<{ orderId: string }, { step1Done: boolean; step2Done: boolean }>(
      { name: "two-step-workflow", version: "v1" },
      async ({ input, step }) => {
        const res1 = await step.run("step-1", async () => {
          step1CallCount++;
          return { validated: true, id: input.orderId };
        });

        if (shouldCrash) {
          throw new Error("SIMULATED_WORKER_CRASH");
        }

        const res2 = await step.run("step-2", async () => {
          step2CallCount++;
          return { processed: true, fromStep1: res1.id };
        });

        return { step1Done: res1.validated, step2Done: res2.processed };
      }
    );

    // Create durable workflow run in DB
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "two-step-workflow",
      workflowVersion: "v1",
      input: { orderId: "ord_123" }
    });

    const executor1 = new WorkflowExecutor({ db, workerId: "worker-1", leaseDurationMs: 10_000 });

    // 1. Initial execution: runs Step 1, then crashes before Step 2
    await expect(executor1.execute(testWorkflow, run.id)).rejects.toThrow("SIMULATED_WORKER_CRASH");

    expect(step1CallCount).toBe(1);
    expect(step2CallCount).toBe(0);

    // Verify Step 1 is durably COMPLETED in PostgreSQL
    const step1Record = await db.stepExecution.findUnique({
      where: { workflowRunId_stepKey: { workflowRunId: run.id, stepKey: "step-1" } }
    });
    expect(step1Record?.status).toBe("COMPLETED");
    expect(step1Record?.output).toEqual({ validated: true, id: "ord_123" });

    // 2. Worker recovery / Replay on Worker 2:
    shouldCrash = false;
    const executor2 = new WorkflowExecutor({ db, workerId: "worker-2", leaseDurationMs: 10_000 });

    const result = await executor2.execute(testWorkflow, run.id);

    // Assert Invariants:
    // - Step 1 handler was NOT re-executed (call count remains 1, read from DB memoization)
    expect(step1CallCount).toBe(1);
    // - Step 2 executed successfully (call count = 1)
    expect(step2CallCount).toBe(1);
    // - Workflow returned final output
    expect(result).toEqual({ step1Done: true, step2Done: true });

    // - Workflow run in DB is COMPLETED
    const finalRun = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(finalRun?.status).toBe("COMPLETED");
    expect(finalRun?.output).toEqual({ step1Done: true, step2Done: true });

    // - Verify execution events were recorded atomically
    const events = await db.executionEvent.findMany({
      where: { workflowRunId: run.id },
      orderBy: { id: "asc" }
    });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("WORKFLOW_CREATED");
    expect(eventTypes).toContain("WORKFLOW_STARTED");
    expect(eventTypes).toContain("STEP_STARTED");
    expect(eventTypes).toContain("STEP_COMPLETED");
    expect(eventTypes).toContain("WORKFLOW_COMPLETED");
  });
});
`

- [ ] **Step 2: Run test to verify it fails**

Run: 
px dotenv-cli -e .env.test -- pnpm --filter @durable/workflow-sdk test
Expected: FAIL (WorkflowExecutor not found)

- [ ] **Step 3: Implement packages/workflow-sdk/src/executor.ts**

`	ypescript
import type { PrismaClient } from "@durable/database";
import { recordExecutionEvent } from "@durable/database";
import { StepContextImpl } from "./step-context.js";
import { WorkflowSuspendedError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

export interface WorkflowExecutorOptions {
  db: PrismaClient;
  workerId: string;
  leaseDurationMs?: number;
}

export class WorkflowExecutor {
  private readonly db: PrismaClient;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;

  constructor(options: WorkflowExecutorOptions) {
    this.db = options.db;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
  }

  async execute<TInput, TOutput>(
    workflow: WorkflowDefinition<TInput, TOutput>,
    runId: string
  ): Promise<TOutput | undefined> {
    const run = await this.db.workflowRun.findUnique({
      where: { id: runId }
    });

    if (!run) {
      throw new Error(Workflow run  not found.);
    }

    if (run.status === "COMPLETED" || run.status === "CANCELLED") {
      return run.output as TOutput;
    }

    const now = new Date();
    // Transition to RUNNING and record WORKFLOW_STARTED if PENDING
    if (run.status === "PENDING") {
      await this.db.(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: { status: "RUNNING", startedAt: now }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_STARTED",
          payload: { workerId: this.workerId, startedAt: now }
        });
      });
    }

    const seenKeys = new Set<string>();
    const stepContext = new StepContextImpl({
      db: this.db,
      tenantId: run.tenantId,
      workflowRunId: runId,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      seenKeys
    });

    try {
      const output = await workflow.handler({
        input: run.input as TInput,
        step: stepContext
      });

      // Mark workflow COMPLETED and record event
      await this.db.(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: {
            status: "COMPLETED",
            output: output as any,
            completedAt: new Date()
          }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_COMPLETED",
          payload: { output }
        });
      });

      return output;
    } catch (err) {
      if (err instanceof WorkflowSuspendedError) {
        // Workflow gracefully suspended waiting for retry/lock; do not mark run failed
        return undefined;
      }

      // Record failure on workflow run
      await this.db.(async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            error: { message: (err as Error).message } as any,
            failedAt: new Date()
          }
        });
        await recordExecutionEvent(tx, {
          tenantId: run.tenantId,
          workflowRunId: runId,
          eventType: "WORKFLOW_FAILED",
          payload: { error: (err as Error).message }
        });
      });

      throw err;
    }
  }
}
`

- [ ] **Step 4: Create packages/workflow-sdk/src/index.ts**

`	ypescript
export * from "./types.js";
export * from "./errors.js";
export * from "./workflow.js";
export * from "./step-context.js";
export * from "./executor.js";
`

- [ ] **Step 5: Run tests and verify PASS**

Run: 
px dotenv-cli -e .env.test -- pnpm --filter @durable/workflow-sdk test
Expected: PASS (all tests pass, including replay walking skeleton)

- [ ] **Step 6: Run build across workspace**

Run: pnpm build
Expected: Clean build across all packages.

- [ ] **Step 7: Commit**

`ash
git add packages/workflow-sdk
git commit -m "feat(workflow-sdk): implement WorkflowExecutor and replay walking skeleton test"
`

---

### Task 4: Final Verification and Ticket 03 Completion Gate

**Files:**
- Modify: .scratch/durable-engine/issues/03-core-sdk-and-replay-walking-skeleton.md

- [ ] **Step 1: Execute full test suite across the monorepo**

Run: 
px dotenv-cli -e .env.test -- pnpm test
Expected: All tests pass across @durable/shared, @durable/database, and @durable/workflow-sdk.

- [ ] **Step 2: Update Ticket 03 issue file**

Modify: .scratch/durable-engine/issues/03-core-sdk-and-replay-walking-skeleton.md
Mark all acceptance criteria checkboxes checked [x] and update status to completed.

- [ ] **Step 3: Commit**

`ash
git add .scratch/durable-engine/issues/03-core-sdk-and-replay-walking-skeleton.md
git commit -m "chore(ticket-03): mark core sdk and replay walking skeleton complete"
`
