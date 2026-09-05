# Ticket 08: Fastify Control API, Idempotency, and Client SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the HTTP Control API (`apps/api`) using Fastify providing API-key authentication, tenant resolution, run creation (`POST /runs`), run inspection (`GET /runs/:id`, `GET /runs`), and manual retry/cancel commands with `Idempotency-Key` deduplication. Implement the foundational client SDK (`packages/client`) providing `createWorkflowClient({ baseUrl, apiKey })` with `client.run()` and `client.runs.*` methods.

**Architecture:**
- `apps/api` (`@durable/api`) built on Fastify with Zod validation.
- API Key authentication hook parses `x-api-key` (or Bearer token), hashes with SHA-256 via `node:crypto`, and matches active tenant API key in PostgreSQL, populating `request.tenantId`.
- `POST /runs` executes an atomic transaction creating `workflow_runs(status: PENDING)` and `execution_events(eventType: 'WORKFLOW_CREATED')`, enqueues a BullMQ replay job, and enforces idempotent deduplication via `workflow_runs(tenant_id, request_idempotency_key)`.
- `GET /runs/:id` and `GET /runs` provide tenant-scoped inspection.
- `POST /runs/:id/retry` (transitions `FAILED -> PENDING` and enqueues replay) and `POST /runs/:id/cancel` (transitions `PENDING -> CANCELLED` or `RUNNING -> CANCEL_REQUESTED`).
- `packages/client` (`@durable/client`) exposes a type-safe HTTP client using native Node `fetch` to interact with the Control API.

**Tech Stack:** Fastify 5, Zod 3, Prisma 6, BullMQ 6, ioredis 6, TypeScript 5.9, Vitest 3.

## Global Constraints
- Ponytail intensity: `full` (lean, minimal code, standard library first, zero unneeded abstractions).
- Author and committer on all commits must be: `Aztrek <starsnipe407@gmail.com>`.
- Strict TDD: Failing test first (RED), minimal implementation (GREEN), then refactor.
- Invariant authority: `docs/spec/durable-workflow-execution-platform-spec.md`.
- Approved commodity boundaries: Fastify, Zod, BullMQ, Prisma, ioredis (respect `docs/spec/reference-reuse-boundaries.md`).
- Short-lived DB transactions: user handlers execute strictly outside database transactions.

## Producer-to-Consumer Interface Check (Ticket 09: Event Ingestion and Bindings)
- **Downstream Consumer**: Ticket 09 (`09-event-ingestion-and-bindings.md`) implements `POST /events` and extends the client with `client.sendEvent({ id, name, data })`.
- **Interfaces Produced**:
  - `apps/api`: Fastify app factory (`createApp({ prisma, queue })`) with modular route structure and `authenticateApiKey` preHandler hook.
  - `packages/client`: `WorkflowClient` class and `createWorkflowClient({ baseUrl, apiKey })` factory function with extensible method structure.
- **Compatibility Verified**: Ticket 09 directly mounts `POST /events` on the same Fastify app instance with identical authentication and attaches `client.sendEvent()` to the `WorkflowClient` without breaking existing signatures.

---

### Task 1: Scaffolding `apps/api` & API Key Authentication Plugin

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/plugins/auth.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/types.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/test/auth.test.ts`

- [ ] **Step 1: Create package.json and tsconfig.json for `apps/api` and install dependencies**
- [ ] **Step 2: Write failing tests for API key authentication (RED)**
  - Test missing API key returns 401 Unauthorized.
  - Test invalid API key hash returns 401 Unauthorized.
  - Test revoked API key returns 401 Unauthorized.
  - Test valid API key resolves correct `tenantId` on `request.tenantId` and returns 200.
- [ ] **Step 3: Run test to verify it fails (RED)**
- [ ] **Step 4: Implement auth plugin and Fastify app factory**
- [ ] **Step 5: Run test to verify it passes (GREEN)**
- [ ] **Step 6: Run build and commit**

---

### Task 2: `POST /runs` Endpoint with Zod Validation & Request Idempotency

**Files:**
- Create: `apps/api/src/routes/runs.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/runs-create.test.ts`

- [ ] **Step 1: Write failing tests for `POST /runs` and idempotency (RED)**
  - Test validation fails on missing `workflowName`.
  - Test creating run inserts `workflow_runs(PENDING)`, `execution_events(WORKFLOW_CREATED)`, enqueues BullMQ job, and returns 201 with run record.
  - Test `Idempotency-Key` header returns existing run on retry without duplicate inserts.
  - Test concurrent requests with identical idempotency key resolve to the same run without error.
- [ ] **Step 2: Run test to verify it fails (RED)**
- [ ] **Step 3: Implement `POST /runs` handler with atomic Prisma transaction and idempotency conflict handling**
- [ ] **Step 4: Run test to verify it passes (GREEN)**
- [ ] **Step 5: Run build and commit**

---

### Task 3: `GET /runs/:id`, `GET /runs`, `POST /runs/:id/retry`, `POST /runs/:id/cancel`

**Files:**
- Modify: `apps/api/src/routes/runs.ts`
- Test: `apps/api/test/runs-management.test.ts`

- [ ] **Step 1: Write failing tests for run inspection and commands (RED)**
  - Test `GET /runs/:id` returns 404 for non-existent or cross-tenant run.
  - Test `GET /runs/:id` returns run details for authenticated tenant.
  - Test `GET /runs` returns tenant-scoped list with pagination and status filter.
  - Test `POST /runs/:id/retry` transitions `FAILED -> PENDING`, increments attempt, records `WORKFLOW_RETRY_REQUESTED` event, enqueues replay job.
  - Test `POST /runs/:id/retry` fails with 400 if run status is not `FAILED`.
  - Test `POST /runs/:id/cancel` cancels `PENDING` run directly to `CANCELLED`, or marks `RUNNING` run as `CANCEL_REQUESTED`.
- [ ] **Step 2: Run test to verify it fails (RED)**
- [ ] **Step 3: Implement management routes in `runs.ts`**
- [ ] **Step 4: Run test to verify it passes (GREEN)**
- [ ] **Step 5: Run build and commit**

---

### Task 4: Foundational Client SDK (`packages/client`) & End-to-End Tests

**Files:**
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/src/index.ts`
- Create: `packages/client/src/client.ts`
- Create: `packages/client/src/types.ts`
- Test: `packages/client/test/client.test.ts`

- [ ] **Step 1: Create package.json and tsconfig.json for `packages/client`**
- [ ] **Step 2: Write failing tests for client SDK against Fastify test server (RED)**
  - Test `client.run()` with input and idempotencyKey.
  - Test `client.runs.get()` fetches run details.
  - Test `client.runs.list()` lists runs.
  - Test `client.runs.retry()` retries failed run.
  - Test `client.runs.cancel()` cancels active run.
  - Test error handling throws `WorkflowClientError` on 4xx/5xx responses.
- [ ] **Step 3: Run test to verify it fails (RED)**
- [ ] **Step 4: Implement `createWorkflowClient` and `WorkflowClient` using native fetch**
- [ ] **Step 5: Run test to verify it passes (GREEN)**
- [ ] **Step 6: Run build and commit**

---

### Task 5: Issue Completion & Monorepo Verification Gate

**Files:**
- Modify: `.scratch/durable-engine/issues/08-fastify-control-api-and-idempotency.md`

- [ ] **Step 1: Run full monorepo test suite across all workspace packages**
- [ ] **Step 2: Run full monorepo build (`pnpm build`)**
- [ ] **Step 3: Update Ticket 08 issue file with completed status, checklist, and Producer-to-Consumer verification**
- [ ] **Step 4: Stage and commit**
