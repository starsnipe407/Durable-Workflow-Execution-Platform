# Ticket 06: BullMQ Scheduling and Worker Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

*Goal:* Implement asynchronous workflow run scheduling using Redis and BullMQ (`apps/worker`), decoupling workflow run triggering from execution. BullMQ jobs carry minimal descriptors (`runId, workflowName, workflowVersion, tenantId`), while worker daemon processes consume jobs, validate PostgreSQL authoritative run state, resolve version-pinned workflow definitions, execute the workflow replay loop, and gracefully handle unavailable versions and retry scheduling.

**Architecture:**
- `apps/worker` contains the queue producer and worker daemon (`@durable/worker`).
- **Queue Producer**: `createWorkflowQueue`, `enqueueWorkflowRun` pushes replay jobs to BullMQ `workflow-runs` queue with minimal payloads (`{ tenantId, runId, workflowName, workflowVersion }`) and optional delay for retries.
- **Workflow Registry**: In-memory registry `WorkflowRegistry` mapping `${name}:${version}` to `WorkflowDefinition`.
- **Workflow Worker Daemon**: Wraps BullMQ `Worker`. When processing a job:
  1. Queries PostgreSQL for authoritative `WorkflowRun`.
  2. If run not found or already terminal (`COMPLETED`, `FAILED`, `CANCELLED`): acknowledges and no-ops.
  3. Resolves workflow definition from `WorkflowRegistry`. If missing:
     - Sets `status = 'PENDING'`, `blockedReason = 'WORKFLOW_VERSION_UNAVAILABLE' `.
     - Writes `WORKFLOW_VERSION_UNAVAILABLE` event to `execution_events`.
     - Acknowledges job (reconciler in Ticket 07 will re-evaluate when a compatible worker joins).
  4. If definition exists:
     - Clears any previous `blockedReason`.
     - Invokes `WorkflowExecutor.execute(workflow, run.id)`.
     - If suspended (returns `undefined`), checks for steps in `RETRY_WAIR` and schedules delayed BullMQ replay job at `nextRetryAt`.

**Tech Stack:** TypeScript (strict, NodeNext), Redis 7, BullMQ, PostgreSQL 16, Prisma 6, Vitest, Turborepo.

## Global Constraints
- Ponytail intensity: `full` (lean, minimal code, standard library first, zero unneeded dependencies/abstractions).
- Author and committer on all commits must be: `Aztrek <starsnipe407@gmail.com>`.
- Strict TDD: Failing test first (RED), minimal implementation (GREEN), then clean refactor.
- Short-lived DB transactions: user handlers execute strictly outside database transactions.
- Invariant authority: `docs/spec/durable-workflow-execution-platform-spec.md`.
- Reuse Boundaries: Respect `docs/spec/reference-reuse-boundaries.md` (Approved commodity libraries: BullMQ, ioredis, Prisma. Core replay, routing, and state machine logic is original clean-room TypeScript).

## Producer-to-Consumer Interface Check (Ticket 07: Periodic Background Reconciler)
- **Downstream Consumer**: Ticket 07 (`apps/reconciler`) scans PostgreSQL for orphan PENDING runs and due step retries, and re-enqueues them into BullMQ.
- **Interfaces Produced**:
  - `WORKFLOW_QUEUE_NAME = "workflow-runs"`
  - `createWorkflowQueue(connectionOrUrl: string | ConnectionOptions): Queue<WorkflowRunJobData>`
  - `enqueueWorkflowRun(queue: Queue<WorkflowRunJobData>, data: WorkflowRunJobData, options?: { delay?: number; jobId?: string }): Promise<Job<WorkflowRunJobData>>`
  - `WorkflowRunJobData` interface: `; tenantId: string; runId: string; workflowName: string; workflowVersion: string; }`
- **Compatibility Verified**: Ticket 07 can directly import `createWorkflowQueue`, `enqueueWorkflowRun`, and `WORKFLOW_QUEUE_NAME` from `@Durable/worker` to enqueue replay jobs without duplicating queue connection logic.

---

### Task 1: Package Scaffolding (`apps/worker`) and BullMQ Queue Producer

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/types.ts`
- Create: `apps/worker/src/queue.ts`
- Create: `apps/worker/src/index.ts`
- Test: `apps/worker/test/queue.test.ts`

-[ ] **Step 1: Create `apps/worker` package structure and install dependencies**
-[ ] **Step 2: Write failing test for Queue Producer**
- [ ] **Step 3: Run test and confirm failure (RED)**
-[ ] **Step 4: Implement Queue Producer**
-[ ] **Step 5: Run test and confirm pass (GREEN)**
-[ ] **Step 6: Run build across workspace and commit**

---

### Task 2: WorkflowRegistry and WorkflowWorker Daemon Core

**Files:**
- Create: `apps/worker/src/registry.ts`
- Create: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/test/worker-routing.test.ts`

-[ ] **Step 1: Write failing tests for WorkflowRegistry and Worker Routing**
- [ ] **Step 2: Run test and confirm failure (RED)**
-[ ] **Step 3: Implement WorkflowRegistry and WorkflowWorker**
-[ ] **Step 4: Run test and confirm pass (GREEN)**
-[ ] **Step 5: Run build across workspace and commit**

---

### Task 3: End-to-End Async Execution & Delayed Retry Scheduling

**Files:**
- Modify: `apps/worker/src/worker.ts`
- Test: `apps/worker/test/worker-e2e.test.ts`

-[ ] **Step 1: Write failing end-to-end integration tests**
-[ ] **Step 2: Run test and confirm failure (RED)**
-[ ] **Step 3: Implement delayed retry scheduling on suspension**
-[ ] **Step 4: Run test and confirm pass (GREEN)**
-[ ] **Step 5: Run build across workspace and commit**

---

### Task 4: Issue Completion & Verification Gate

-[ ] **Step 1: Run full workspace tests and build**
- [ ] **Step 2: Update Ticket 06 issue file**
-[ ] **Step 3: Stage and commit**
