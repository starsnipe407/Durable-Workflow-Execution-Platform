# Design Specification: Ticket 13 — Order Processing Example and Benchmarks

## 1. Overview & Objectives
This specification outlines the architecture, components, and verification protocols for **Ticket 13: Order Processing Example and Benchmarks**.
Ticket 13 represents the final milestone of the platform specification, delivering:
1. A production-grade canonical reference application (`examples/order-processing`).
2. An automated benchmark and chaos suite (`benchmarks/`) measuring throughput scaling, crash recovery latency, and Redis reconstruction with zero data loss.
3. Persistent, reproducible performance artifacts in JSON and Markdown with full hardware and environment metadata.

---

## 2. Downstream & Upstream Interface Checks
- **Upstream Inputs**:
  - `@durable/workflow-sdk`: `defineWorkflow`, `step.run`, `DuplicateStepKeyError`.
  - `@durable/worker`: `WorkflowWorker`, `createWorker`, concurrency coordinator, lease heartbeats.
  - `@durable/client`: `DurableClient`, `createClient`, event ingestion, SSE event streaming.
  - `@durable/api`: REST control endpoints (`POST /runs`, `GET /runs/:id`, `GET /metrics`, `GET /workflows`).
  - `@durable/reconciler`: `WorkflowReconciler` stateless repair loop.
- **Downstream Consumers**:
  - Final integration gate and performance validation for the entire platform.
  - Demonstrates full real-world usage of all prior 12 tickets.

---

## 3. Architecture & Components

### 3.1 Canonical Reference Application (`examples/order-processing`)
- **Location**: `examples/order-processing/`
- **Package**: `@example/order-processing` (private workspace package in monorepo).
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
    3. `step.run('process-payment', { retry: { maxAttempts: 3, backoff: 'exponential' } })`: Simulates payment gateway with external idempotency key (`${runId}-payment`). Simulates transient gateway failure if `simulatePaymentFailure: true` to demonstrate automatic backoff retry.
    4. `Promise.all([ ... ])`: Parallel execution of:
       - `step.run('send-confirmation-email')`: Dispatches customer receipt.
       - `step.run('update-crm-records')`: Updates customer lifetime value records.
       - `step.run('dispatch-warehouse-fulfillment')`: Emits shipping label generation.
    5. `step.run('generate-invoice')`: Finalizes billing PDF ledger and closes order.
  - **Interactive CLI Runner (`examples/order-processing/src/cli.ts`)**:
    - Can trigger sample orders against `@durable/api` or directly with local workers.
    - Demonstrates live SSE streaming in the terminal using native SSE reader.

---

### 3.2 Automated Benchmark & Chaos Suites (`benchmarks/`)
- **Location**: `benchmarks/`
- **Package**: `@durable/benchmarks`
- **Modules**:
  1. **System Metadata Collector (`benchmarks/src/sysinfo.ts`)**:
     - Captures Node.js version, OS platform & release, CPU architecture & model, CPU core count, total memory, and Git SHA commit.
  2. **Throughput Scaling Benchmark (`benchmarks/src/bench-throughput.ts`)**:
     - Measures completed workflows per second across worker concurrency scaling: **1, 2, 4, 8 workers**.
     - Executes a batch of workflows per concurrency tier (default 50-100 runs).
     - Records wall-clock duration, completed runs/sec, p50, p95, and p99 completion latency.
  3. **Crash Recovery & Chaos Suite (`benchmarks/src/bench-chaos.ts`)**:
     - Starts workflow runs and abruptly terminates (kills) the executing worker mid-step.
     - Spawns a replacement worker with lease expiry recovery enabled.
     - Measures recovery latency (time from worker kill to workflow completion via lease expiration and fence check).
     - Asserts zero duplicate step invocations on previously completed steps.
  4. **Redis Flush & Reconciler Resilience Benchmark (`benchmarks/src/bench-reconciliation.ts`)**:
     - Submits active runs into PostgreSQL.
     - Flushes Redis completely (`FLUSHALL` via ioredis).
     - Triggers `WorkflowReconciler` to rebuild BullMQ queues from PostgreSQL authoritative truth.
     - Measures queue reconstruction timing and verifies:
       - 0 lost durable runs.
       - 0 duplicate runs executed.
       - 100% completion of reconstructed runs.
  5. **Artifact Generator (`benchmarks/src/reporter.ts`)**:
     - Writes machine-readable JSON: `benchmarks/results/benchmark-<timestamp>.json`.
     - Writes human-readable Markdown summary: `benchmarks/results/benchmark-<timestamp>.md`.

---

## 4. Automated Verification Matrix
1. **Reference Application Test**:
   - `examples/order-processing/test/order-processing.test.ts`: Verifies successful execution, step memoization, transient payment retry, and parallel sibling step execution.
2. **Benchmark & Chaos Vitest Suite**:
   - `benchmarks/test/benchmarks.test.ts`: Runs throughput, chaos recovery, and Redis flush reconciler tests in automated CI mode to prevent performance regressions.
3. **Artifact Verification**:
   - Verifies generation of valid JSON and Markdown reports with non-empty hardware metadata and latency metrics.

---

## 5. Non-Functional Invariants
- Zero foreign workflow engines or unapproved dependencies.
- Monorepo clean-room standards with author `Aztrek <starsnipe407@gmail.com>`.
- Strict multi-tenant isolation and database cleanup in test teardown.
