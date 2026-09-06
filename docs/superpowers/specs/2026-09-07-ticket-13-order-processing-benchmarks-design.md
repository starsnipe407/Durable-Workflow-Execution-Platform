# Design Specification: Ticket 13 — Order Processing Example and Benchmarks

## 1. Overview & Objectives
This specification outlines the architecture, components, and verification protocols for **Ticket 13: Order Processing Example and Benchmarks**.
Ticket 13 represents the final milestone of the platform specification, delivering:
1. A production-grade canonical reference application (`examples/order-processing`) driven by event ingestion with external idempotency and step retries.
2. An automated benchmark and chaos suite (`benchmarks/`) measuring horizontal worker replica scaling, genuine worker-process kill recovery latency, and full Redis destruction/reconciliation with zero data loss.
3. Persistent, reproducible performance artifacts in JSON and Markdown with full hardware metadata, warmup, multiple repetitions, raw latency samples, and statistical percentiles (P50, P95, P99).

---

## 2. Downstream & Upstream Interface Checks
- **Upstream Inputs**:
  - `@durable/workflow-sdk`: `defineWorkflow`, `step.run`, `DuplicateStepKeyError`.
  - `@durable/worker`: `WorkflowWorker`, `createWorker`, concurrency coordinator, lease heartbeats.
  - `@durable/client`: `DurableClient`, `createClient`, event ingestion (`sendEvent`), SSE event streaming.
  - `@durable/api`: REST control endpoints (`POST /events`, `POST /runs`, `GET /runs/:id`, `GET /metrics`, `GET /workflows`).
  - `@durable/reconciler`: `WorkflowReconciler` stateless repair loop.
- **Downstream Consumers**:
  - Final integration gate and performance validation for the entire platform.
  - Demonstrates full real-world usage of all prior 12 tickets.

---

## 3. Architecture & Components

### 3.1 Canonical Reference Application (`examples/order-processing`)
- **Location**: `examples/order-processing/`
- **Package**: `@example/order-processing` (private workspace package in monorepo).
- **Event-Driven Binding**:
  - Workflow bound to event: `order.created`.
  - Primary dispatch mechanism sends `order.created` with a unique producer event ID (`evt_${orderId}`).
  - Workflow run is triggered automatically via database event binding. (Direct-run mode available as an optional flag).
- **Workflow Definition (`process-order`)**:
  - `workflowName`: `'process-order'`
  - `workflowVersion`: `'1.0.0'`
  - **Input Schema**:
    ```ts
    {
      orderId: string;
      customerId: string;
      customerEmail: string;
      items: Array<{ sku: string; quantity: number; price: number }>;
      totalAmount: number;
      simulatePaymentFailure?: boolean; // Injects transient error to exercise step retries
    }
    ```
  - **Execution Steps**:
    1. `step.run('validate-cart')`: Validates SKU inventory format, order boundaries, positive amounts.
    2. `step.run('reserve-inventory')`: Checkpoints inventory holds with SKU allocation identifiers.
    3. `step.run('process-payment', { retry: { maxAttempts: 3, backoff: 'exponential' } })`: Calls `PaymentGateway.charge({ amount, idempotencyKey: \`pay_\${runId}\` })`.
       - The simulated payment gateway persists external charges by `idempotencyKey`.
       - If invoked twice with the same idempotency key, it deduplicates and returns the existing charge ID.
       - If `simulatePaymentFailure: true`, the gateway throws a transient network drop on the initial attempt, triggering step-level retry backoff.
    4. `Promise.all([ ... ])`: Parallel execution of:
       - `step.run('send-confirmation-email')`: Dispatches customer receipt.
       - `step.run('update-crm-records')`: Updates customer lifetime value records.
       - `step.run('dispatch-warehouse-fulfillment')`: Emits shipping label generation.
    5. `step.run('generate-invoice')`: Finalizes billing PDF ledger and closes order.
  - **External Idempotency Verification**:
    - Includes a dedicated verification case: crash after payment gateway side-effect but before step completion is committed to PostgreSQL; subsequent attempt invokes payment gateway with identical idempotency key, proving exactly one charge was recorded.
  - **Interactive CLI Runner (`examples/order-processing/src/cli.ts`)**:
    - Dispatches `order.created` event via `@durable/client`.
    - Discovers triggered workflow run and streams execution events in real time using native SSE to terminal.

---

### 3.2 Automated Benchmark & Chaos Suites (`benchmarks/`)
- **Location**: `benchmarks/`
- **Package**: `@durable/benchmarks`
- **Modules**:
  1. **System Metadata & Introspection (`benchmarks/src/sysinfo.ts`)**:
     - Captures Node.js version, OS platform & release, CPU model & architecture, physical/logical CPU core count, total RAM, and Git commit SHA.
     - Captures execution configuration: worker replica count, concurrency per worker, lease TTL, database engine & Redis server versions.
  2. **Multi-Worker Horizontal Scaling Benchmark (`benchmarks/src/bench-throughput.ts`)**:
     - Evaluates true horizontal worker scaling: spawns **1, 2, 4, and 8 independent worker processes** (via `node:child_process.fork` / cluster replicas) with a fixed concurrency per worker (e.g. 5 concurrency slots).
     - Execution protocol:
       - **Warm-up phase**: Runs 10 unmeasured workflow executions to warm caches and JIT.
       - **Measured repetitions**: Runs 3 distinct measured iterations per scaling tier with fixed workload sizes (e.g., 50 workflows per iteration).
       - **Metrics captured**: Median completed workflows/sec, P50, P95, and P99 completion latency, plus raw timing sample arrays saved to the artifact.
  3. **Real Worker Termination Chaos Benchmark (`benchmarks/src/bench-chaos.ts`)**:
     - Launches an independent worker child process executing an in-flight workflow.
     - Sends `SIGKILL` (`process.kill(child.pid, 'SIGKILL')`) abruptly mid-step.
     - Launches a replacement worker process with reconciler heartbeat expiration active.
     - Measures recovery duration (elapsed time from SIGKILL until the replacement worker claims the abandoned lease and completes the workflow).
     - Asserts zero duplicate step invocations on previously committed steps.
  4. **Redis Destruction & Reconciler Resilience Benchmark (`benchmarks/src/bench-reconciliation.ts`)**:
     - Submits active workflow runs to PostgreSQL.
     - Destroys Redis scheduling state completely (`FLUSHALL` via ioredis) while runs are pending/running.
     - Invokes `WorkflowReconciler` to rebuild BullMQ queues strictly from PostgreSQL authoritative truth.
     - Replaces workers and drains the queue.
     - Invariants asserted:
       - 0 lost durable runs.
       - 0 duplicate runs executed.
       - 100% completion of reconstructed runs.
  5. **Artifact Generator (`benchmarks/src/reporter.ts`)**:
     - Writes machine-readable JSON: `benchmarks/results/benchmark-<timestamp>.json` with full raw samples, configuration, and statistical metrics.
     - Writes human-readable Markdown: `benchmarks/results/benchmark-<timestamp>.md` with formatted tables.

---

## 4. Automated Verification Matrix
1. **CI Correctness vs. Benchmark Separation**:
   - **Vitest Suites (`benchmarks/test/` and `examples/order-processing/test/`)**:
     - Validate functional correctness, external payment idempotency, child-process SIGKILL crash recovery, and Redis destruction reconciliation.
     - **No machine-dependent throughput or latency pass/fail thresholds in CI**. CI fails only on correctness violations (e.g. lost runs, duplicate runs, unhandled errors, broken leases).
   - **Dedicated Benchmark CLI (`pnpm bench:all` / `pnpm bench:throughput`)**:
     - Standalone scripts executed explicitly to collect empirical performance data, calculate percentiles, and generate official persistent artifacts.

---

## 5. Non-Functional Invariants
- Zero foreign workflow engines or unapproved dependencies.
- Monorepo clean-room standards with author `Aztrek <starsnipe407@gmail.com>`.
- Strict multi-tenant isolation and database cleanup in test teardown.
