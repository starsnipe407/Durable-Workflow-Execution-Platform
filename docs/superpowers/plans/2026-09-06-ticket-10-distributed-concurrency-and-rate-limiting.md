# Ticket 10: Distributed Concurrency and Rate Limiting Implementation Plan

## Goal
Implement distributed token-bucket rate limiting at the Fastify API boundary (failing closed to HTTP 503 when Redis is down, returning HTTP 429 with Retry-After on limit) and distributed workflow concurrency coordination in the worker runtime (global limit and per-key partition limits with lease TTLs and clean release) backed by original clean-room Redis Lua scripts.

## Downstream Producer-to-Consumer Interface Check (Ticket 11: Real-Time SSE Execution Streaming)
- **Downstream Ticket**: `11-real-time-sse-execution-streaming.md`
- **Consumer Requirements**: Ticket 11 implements `GET /runs/:runId/events` using Server-Sent Events (SSE). SSE connections are long-lived HTTP streams.
- **Interface Safeguards**:
  - The API rate-limiting plugin in `apps/api` must support route-level exclusion or configurable exemptions (e.g. exempting or having distinct limits for long-lived SSE streaming routes), or ensure token consumption occurs strictly on request initiation (`preHandler`) without terminating open SSE connection streams.
  - The worker concurrency coordinator manages workflow execution concurrency slots without altering the database schema of `execution_events` or `workflow_runs`, so Ticket 11's SSE query and replay mechanics are completely unblocked.

---

## Architecture & Components

### 1. Redis Token-Bucket API Rate Limiter (`apps/api/src/plugins/rate-limit.ts`)
- Original, clean-room Redis Lua script executing atomic token bucket calculations:
  - Keys: `ratelimit:{tenantId}` (or `{tenantId}:{route}`)
  - Arguments: `capacity`, `refillRatePerSec`, `cost` (default 1), `now` (epoch seconds or ms), `ttl`
  - Logic:
    - Compute token replenishment based on elapsed time since `lastRefill`.
    - Refill tokens up to `capacity`.
    - If `tokens >= cost`, decrement tokens, update `lastRefill`, and allow request.
    - If `tokens < cost`, compute `retryAfter = math.ceil((cost - tokens) / refillRatePerSec)` and deny request.
- Fastify plugin / preHandler:
  - Attached to authenticated requests using `request.tenantId`.
  - If limit exceeded: return HTTP 429 with `Retry-After: <seconds>` header and error JSON `{ statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded" }`.
  - Fail-closed invariant: If Redis fails, rejects, or is unavailable, catch error and return HTTP 503 with `{ statusCode: 503, error: "Service Unavailable", message: "Rate limiter unavailable" }`.

### 2. Distributed Concurrency Coordinator (`apps/worker/src/concurrency.ts`)
- Original, clean-room Redis Lua scripts executing atomic slot acquisition with lease TTL:
  - **Acquire Script**:
    - Keys: `concurrency:global:{workflowName}` (if global limit configured), `concurrency:key:{workflowName}:{partitionKey}` (if per-key limit configured).
    - Checks active slots in Redis Hash or Sorted Set. Expired leases (`timestamp < now`) are pruned automatically.
    - If `currentSlots < limit`, registers `runId` with expiry `now + ttl` and returns success `1`.
    - If either global or per-key limit is full, returns failure `0` (reverting any partial slot acquisition).
  - **Release Script**:
    - Atomically removes `runId` from the global and per-key concurrency sets.
  - **Heartbeat / Renew Script**:
    - Extends active lease TTL for running workflows.
- Integration into `WorkflowWorker.processJob()`:
  - Reads `workflow.config.concurrency`.
  - Evaluates global limit and per-key partition key (via `concurrency.key({ input: run.input })` and `concurrency.keyLimit`).
  - Before calling `executor.execute()`, attempts to acquire concurrency slot:
    - If slot acquired: start heartbeat timer, execute workflow, and in `finally` release slot and clear heartbeat.
    - If slot cannot be acquired: reschedule job with delay (`enqueueWorkflowRun(this.queue, job.data, { delay: 1000 })`) and exit `processJob` cleanly without marking run failed.
  - On worker shutdown (`worker.close()` or process exit): release active slots.

---

## Tasks

### Task 1: Redis Token-Bucket API Rate Limiter Plugin & Fail-Closed Guard
**Files:**
- Create: `apps/api/src/plugins/rate-limit.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/rate-limit.test.ts`

- [ ] **Step 1: Write failing tests for API rate limiting & fail-closed behavior (RED)**
  - Test rapid requests within capacity return HTTP 200/201.
  - Test requests exceeding capacity return HTTP 429 with `Retry-After` header.
  - Test tokens replenish over time allowing subsequent requests.
  - Test fail-closed: simulate Redis unavailability and verify requests return HTTP 503.
- [ ] **Step 2: Run test to verify it fails (RED)**
- [ ] **Step 3: Implement Redis Lua token-bucket rate limiter in `apps/api/src/plugins/rate-limit.ts` and mount in `apps/api/src/app.ts`**
- [ ] **Step 4: Run test to verify it passes (GREEN)**
- [ ] **Step 5: Run build and commit**

---

### Task 2: Distributed Concurrency Coordinator in Worker Runtime
**Files:**
- Modify: `packages/workflow-sdk/src/types.ts` (extend `WorkflowConfig.concurrency` with `keyLimit`)
- Create: `apps/worker/src/concurrency.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/test/concurrency.test.ts`

- [ ] **Step 1: Write failing tests for distributed concurrency coordinator (RED)**
  - Test global concurrency limit: with limit 2, 5 concurrent runs only allow 2 active simultaneously; remaining 3 delayed until slots freed.
  - Test per-key partition concurrency limit: with keyLimit 1 per customer, 2 runs for customer A and 2 for customer B; customer A runs serialize, while customer A and B run in parallel.
  - Test lease TTL & release: slots are cleanly released on workflow completion, and abandoned leases expire after TTL without deadlocking.
- [ ] **Step 2: Run test to verify it fails (RED)**
- [ ] **Step 3: Implement `ConcurrencyCoordinator` in `apps/worker/src/concurrency.ts` and integrate into `WorkflowWorker`**
- [ ] **Step 4: Run test to verify it passes (GREEN)**
- [ ] **Step 5: Run build and commit**

---

### Task 3: Issue Completion & Monorepo Verification Gate
**Files:**
- Modify: `.scratch/durable-engine/issues/10-distributed-concurrency-and-rate-limiting.md`

- [ ] **Step 1: Run full monorepo test suite across all workspace packages**
- [ ] **Step 2: Run full monorepo build (`pnpm build`)**
- [ ] **Step 3: Update Ticket 10 issue file with completed status, checklist, and Producer-to-Consumer verification**
- [ ] **Step 4: Stage and commit**
