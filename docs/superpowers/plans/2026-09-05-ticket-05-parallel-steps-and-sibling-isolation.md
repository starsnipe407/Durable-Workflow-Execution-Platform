# Ticket 05: Parallel Steps and Sibling Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable robust concurrent step execution within durable workflows using native `Promise.all([step.run("A", ...), step.run("B", ...)])`, ensuring that when one sibling fails or retries, successful siblings remain durably committed, are never re-executed on subsequent replays, and all in-flight promises are safely settled before replay finalization.

**Architecture:** 
- In `StepContextImpl`, maintain a collection of in-flight step execution promises and provide a `settleInFlight(): Promise<void>` method using `Promise.allSettled`.
- In `WorkflowExecutor`, ensure `stepContext.settleInFlight()` is called whenever the workflow handler finishes (or rejects with error/suspension) so that background sibling steps are never abandoned midway through a database transaction.
- Sibling isolation is guaranteed by PostgreSQL row-level locks on `(workflow_run_id, step_key)` in `step_executions`. Completed siblings persist their output immediately outside of the workflow handler context and remain memoized on subsequent replay invocations.

**Tech Stack:** TypeScript (strict, ES2022/NodeNext), PostgreSQL, Prisma, Vitest, Turbo.

## Global Constraints
- Ponytail intensity: `full` (standard library first, zero unnecessary dependencies, lean and maintainable code).
- Author and committer on all commits must be: `Aztrek <starsnipe407@gmail.com>`.
- Strict TDD: Failing test first (RED), minimal implementation (GREEN), then clean refactor.
- Database transactions must be short-lived; user step handlers run strictly outside database transactions.
- Invariant authority: `docs/spec/durable-workflow-execution-platform-spec.md`.
- Reuse Boundaries: Respect `docs/spec/reference-reuse-boundaries.md` (no external workflow engine code, 100% original TypeScript implementation, standard library first).

## Producer-to-Consumer Interface Check (Ticket 06: BullMQ Scheduling and Worker Daemon)
- **Downstream Consumer**: Ticket 06 implements the worker daemon that consumes BullMQ jobs and calls `WorkflowExecutor.execute(workflow, runId)`.
- **Interfaces Produced**: `WorkflowExecutor.execute` returns `Promise<TOutput | undefined>` (`undefined` when suspended), safely settling all concurrent sibling promises before returning.
- **Compatibility Verified**: When a BullMQ worker job runs `executor.execute()`, parallel steps inside the workflow execute concurrently without leaking unhandled background promises or deadlocking database connections.

---

### Task 1: In-Flight Promise Tracking and Settlement in StepContext & WorkflowExecutor

**Files:**
- Modify: `packages/workflow-sdk/src/step-context.ts`
- Modify: `packages/workflow-sdk/src/executor.ts`
- Test: `packages/workflow-sdk/test/step-parallel.test.ts`

**Interfaces:**
- Consumes: `StepContextImpl`, `WorkflowExecutor`, `WorkflowSuspendedError`.
- Produces: `StepContextImpl.settleInFlight(): Promise<void>`.

- [ ] **Step 1: Write the failing test for in-flight step settlement**
Create `packages/workflow-sdk/test/step-parallel.test.ts` with a test verifying that when sibling B fails immediately and throws `WorkflowSuspendedError`, `WorkflowExecutor` waits for sibling A (which takes 100ms) to complete and persist its durable output before the executor finishes execution.

- [ ] **Step 2: Run test and confirm failure**
Run `npx dotenv-cli -e .env.test -- pnpm --filter @durable/workflow-sdk test` and verify that the test fails (RED).

- [ ] **Step 3: Implement in-flight tracking in `StepContextImpl` and settlement in `WorkflowExecutor`**
In `packages/workflow-sdk/src/step-context.ts`:
- Add `private readonly inFlightPromises: Set<Promise<unknown>> = new Set();`.
- In `run()`, wrap the execution promise, add to `inFlightPromises`, and delete from set on completion (`promise.finally(...)`).
- Implement `async settleInFlight(): Promise<void>` which calls `await Promise.allSettled(Array.from(this.inFlightPromises))`.
In `packages/workflow-sdk/src/executor.ts`:
- In `WorkflowExecutor.execute()`, wrap handler execution and ensure `await stepContext.settleInFlight()` is called before handling `WorkflowSuspendedError`, error propagation, or completion.

- [ ] **Step 4: Run test and confirm pass**
Run `npx dotenv-cli -e .env.test -- pnpm --filter @durable/workflow-sdk test` and verify test passes (GREEN).

- [ ] **Step 5: Run monorepo build and commit**
Run `pnpm build`.
Stage and commit:
```bash
git add packages/workflow-sdk
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "feat(workflow-sdk): implement in-flight step promise tracking and settlement"
```

---

### Task 2: Sibling Isolation and Partial Failure Replay Test

**Files:**
- Test: `packages/workflow-sdk/test/step-parallel.test.ts`

**Interfaces:**
- Consumes: `defineWorkflow`, `WorkflowExecutor`, `StepContextImpl`.
- Produces: Sibling isolation verified integration test.

- [ ] **Step 1: Write the failing integration test for sibling isolation and replay resumption**
In `packages/workflow-sdk/test/step-parallel.test.ts`:
- Define a workflow with `Promise.all([step.run("sibling-a", ...), step.run("sibling-b", ...)])`.
- Sibling A succeeds on attempt 1.
- Sibling B throws an error on attempt 1 with `retries: 1, backoff: { initialMs: 1000 }`.
- First execution: workflow suspends (`undefined`).
- Assert: Sibling A is `COMPLETED` with output in `step_executions`.
- Assert: Sibling B is `RETRY_WAIT` with `attemptCount = 1`.
- Fast-forward `nextRetryAt` on Sibling B.
- Second execution: Sibling A handler is NOT called (call count remains 1, loaded from memoized output). Sibling B handler is called (call count 2) and succeeds.
- Workflow run completes with combined output `{ a: "...", b: "..." }`.

- [ ] **Step 2: Run test and verify behavior**
Run `npx dotenv-cli -e .env.test -- pnpm --filter @durable/workflow-sdk test` to ensure it passes cleanly.

- [ ] **Step 3: Stage and commit**
```bash
git add packages/workflow-sdk/test/step-parallel.test.ts
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "test(workflow-sdk): verify sibling isolation and memoization across replays"
```

---

### Task 3: Concurrent Concurrency Stress & Issue Completion

**Files:**
- Test: `packages/workflow-sdk/test/step-parallel.test.ts`
- Modify: `.scratch/durable-engine/issues/05-parallel-steps-and-sibling-isolation.md`

**Interfaces:**
- Consumes: `WorkflowExecutor`, PostgreSQL `step_executions` locking.
- Produces: Concurrency stress verification, completed Ticket 05 issue file.

- [ ] **Step 1: Add concurrency stress test**
In `packages/workflow-sdk/test/step-parallel.test.ts`:
- Add a test that runs 10 parallel sibling steps concurrently via `Promise.all`.
- Each sibling step performs an async operation with simulated variable delay (10-50ms).
- Verify that all 10 steps execute, commit their distinct outputs without deadlock, and the workflow run completes with all 10 outputs intact.

- [ ] **Step 2: Run full monorepo test suite and build**
Run `npx dotenv-cli -e .env.test -- pnpm test` (all tests pass).
Run `pnpm build` (clean build).

- [ ] **Step 3: Update Ticket 05 issue file**
Update `.scratch/durable-engine/issues/05-parallel-steps-and-sibling-isolation.md`:
- Mark all checklist items `[x]`.
- Set `Status: completed`.
- Include the Producer-to-Consumer interface check for Ticket 06.

- [ ] **Step 4: Stage and commit**
```bash
git add packages/workflow-sdk/test/step-parallel.test.ts .scratch/durable-engine/issues/05-parallel-steps-and-sibling-isolation.md
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "chore(ticket-05): verify concurrent sibling stress and mark ticket complete"
```