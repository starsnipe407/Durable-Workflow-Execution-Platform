# Ticket 09: Event Ingestion and Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build event-driven workflow execution via `POST /events` in `apps/api` and extend `@durable/client` with `client.sendEvent({ id, name, data })`. Ingest producer events with mandatory producer-supplied event IDs for per-tenant deduplication, atomically match exact event-to-workflow bindings (`workflow_event_bindings`), create resulting `workflow_runs` in PostgreSQL, and enqueue BullMQ jobs with zero loss or duplication under concurrent requests.

**Architecture:**
- `apps/api` (`@durable/api`) registers `eventsRoutes` handling `POST /events`.
- Authenticated via existing API-key auth hook (`request.tenantId`).
- Validates `{ id: string, name: string, data?: unknown }` via Zod.
- Deduplicates via PostgreSQL unique constraint `UNIQUE(tenant_id, event_id)` on `ingested_events`.
- Inside `prisma.$transaction`:
  1. Inserts `ingested_events` record with `receivedAt` and `processedAt`.
  2. Queries `workflow_event_bindings` matching `tenantId` and `eventName`.
  3. For each matching binding, creates a `workflow_runs` record (`status: PENDING`, `triggerType: EVENT`, `triggerEventId: ingestedEvent.id`, `input: data`, `requestIdempotencyKey: event_${id}_binding_${binding.id}`) and logs `execution_events` (`WORKFLOW_CREATED`).
- Outside transaction, enqueues BullMQ execution jobs (`run_${run.id}`).
- Gracefully handles concurrent duplicates (`P2002`) returning HTTP 200 with the already ingested event.
- `@durable/client` extends `WorkflowClient` with `client.sendEvent({ id, name, data })`.

**Tech Stack:** Fastify 5, Zod 3, Prisma 6, BullMQ 6, TypeScript 5.9, Vitest 3.

## Global Constraints
- Ponytail intensity: `full` (lean, minimal code, standard library first, zero unneeded abstractions).
- Author and committer on all commits must be: `Aztrek <starsnipe407@gmail.com>`.
- Strict TDD: Failing test first (RED), minimal implementation (GREEN), then refactor.
- Invariant authority: `docs/spec/durable-workflow-execution-platform-spec.md`.
- Approved commodity boundaries: Fastify, Zod, BullMQ, Prisma, ioredis (respect `docs/spec/reference-reuse-boundaries.md`).
- Short-lived DB transactions: user handlers execute strictly outside database transactions.

## Producer-to-Consumer Interface Check (Ticket 10: Distributed Concurrency and Rate Limiting)
- **Downstream Consumer**: Ticket 10 (`10-distributed-concurrency-and-rate-limiting.md`) implements token-bucket rate limiting on API routes and distributed workflow concurrency on execution jobs.
- **Interfaces Produced**:
  - `POST /events` route mounted on Fastify app alongside `POST /runs`.
  - Event-triggered `workflow_runs` records created with `triggerType: 'EVENT'`, `triggerEventId`, and `input`.
  - Client SDK method `client.sendEvent()` in `@durable/client`.
- **Compatibility Verified**: Ticket 10 will wrap the Fastify route handler chain with rate limiting hooks without altering request schemas or binding logic, and event-triggered workflow runs will seamlessly participate in concurrency key partitions during worker execution.

---

### Task 1: `POST /events` Endpoint, Deduplication & Atomic Binding Resolution

**Files:**
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/events-ingestion.test.ts`

- [ ] **Step 1: Write failing tests for `POST /events` (RED)**
  - Test validation failure (missing `id` or `name`) returns 400.
  - Test event ingestion with no matching bindings inserts `ingested_events` and returns 201 with 0 runs created.
  - Test event ingestion with matching `workflow_event_bindings` atomically creates `workflow_runs` (in `PENDING` status with `triggerType: EVENT`), records `WORKFLOW_CREATED` events, enqueues BullMQ jobs, and returns 201 with runs array.
  - Test duplicate event with identical `id` returns HTTP 200 without creating duplicate events, runs, or BullMQ jobs.
  - Test concurrent requests with identical event ID (`Promise.all`) both succeed, creating exactly 1 event and 1 set of runs.
- [ ] **Step 2: Run test to verify it fails (RED)**
- [ ] **Step 3: Implement `POST /events` handler in `apps/api/src/routes/events.ts` and mount in `apps/api/src/app.ts`**
- [ ] **Step 4: Run test to verify it passes (GREEN)**
- [ ] **Step 5: Run build and commit**

---

### Task 2: Client SDK Extension (`client.sendEvent`) & E2E Integration Tests

**Files:**
- Modify: `packages/client/src/types.ts`
- Modify: `packages/client/src/client.ts`
- Test: `packages/client/test/events.test.ts`

- [ ] **Step 1: Write failing tests for `client.sendEvent()` against Fastify test server (RED)**
  - Test `client.sendEvent({ id, name, data })` ingests event and returns response.
  - Test `client.sendEvent` duplicate returns HTTP 200 status.
  - Test client error handling when sending invalid event throws `WorkflowClientError`.
- [ ] **Step 2: Run test to verify it fails (RED)**
- [ ] **Step 3: Implement `sendEvent` method and types in `@durable/client`**
- [ ] **Step 4: Run test to verify it passes (GREEN)**
- [ ] **Step 5: Run build and commit**

---

### Task 3: Issue Completion & Monorepo Verification Gate

**Files:**
- Modify: `.scratch/durable-engine/issues/09-event-ingestion-and-bindings.md`

- [ ] **Step 1: Run full monorepo test suite across all workspace packages**
- [ ] **Step 2: Run full monorepo build (`pnpm build`)**
- [ ] **Step 3: Update Ticket 09 issue file with completed status, checklist, and Producer-to-Consumer verification**
- [ ] **Step 4: Stage and commit**
