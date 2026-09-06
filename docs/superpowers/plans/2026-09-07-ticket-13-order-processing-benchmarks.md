# Implementation Plan: Ticket 13 — Order Processing Example and Benchmarks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical order processing reference application (`examples/order-processing`), complete with event ingestion (`order.created`), external payment idempotency deduplication, simulated services, step-level retries, and parallel steps, along with a standalone benchmark and chaos suite (`benchmarks/`) measuring horizontal worker replica scaling (1/2/4/8 independent worker processes), real SIGKILL worker crash recovery, and Redis destruction reconciliation with zero lost or duplicate runs, archiving reproducible markdown and JSON artifacts.

**Architecture:** 
- `examples/order-processing`: Private workspace package exporting the `processOrderWorkflow` definition, mock payment service with idempotency store, and a standalone CLI dispatching `order.created` events and streaming execution progress via native SSE.
- `benchmarks`: Private workspace package containing modules for system hardware introspection (`sysinfo.ts`), multi-process worker replica throughput scaling with warmup and repetitions (`bench-throughput.ts`), abrupt SIGKILL chaos testing (`bench-chaos.ts`), Redis destruction reconciliation resilience (`bench-reconciliation.ts`), and artifact generation (`reporter.ts`).
- Vitest automated test suites asserting distributed invariants, external idempotency, and correctness (zero lost/duplicate runs) without brittle, machine-dependent performance gating in CI.

**Tech Stack:** Node.js 22+, TypeScript 5.6, Turborepo, Vitest 2.1, Prisma 6.19, Fastify 5, BullMQ 6, ioredis 6, native `node:child_process`.

## Global Constraints
- Ponytail intensity: FULL (lean, minimal code, zero unneeded abstractions, native fetch, native child_process/fork).
- Author and committer on all git commits: `Aztrek <starsnipe407@gmail.com>`.
- Strict clean-room implementation obeying `docs/spec/reference-reuse-boundaries.md`.
- No cross-tenant data leakage: all test and benchmark runs scoped cleanly with complete teardown in `afterAll`.
- CI asserts correctness (no lost runs, no duplicate side-effects, exact event matching), never arbitrary throughput or P95 thresholds.

---

### Task 1: Scaffolding `examples/order-processing`, External Idempotency & Workflow Definition
**Files:**
- Create: `examples/order-processing/package.json`
- Create: `examples/order-processing/tsconfig.json`
- Create: `examples/order-processing/src/types.ts`
- Create: `examples/order-processing/src/services/payment-gateway.ts`
- Create: `examples/order-processing/src/workflow.ts`
- Test: `examples/order-processing/test/order-workflow.test.ts`
- Test: `examples/order-processing/test/external-idempotency.test.ts`

**Interfaces:**
- Consumes: `@durable/workflow-sdk: defineWorkflow, StepContext`
- Produces: `processOrderWorkflow`, `FakePaymentGateway` (with idempotency map and charge record verification), `OrderInput`, `OrderOutput`

- [ ] **Step 1: Create package.json and tsconfig.json for examples/order-processing**
- [ ] **Step 2: Write failing tests for workflow execution and external payment idempotency crash recovery**
- [ ] **Step 3: Run tests to verify RED**
- [ ] **Step 4: Implement `payment-gateway.ts`, `types.ts`, and `workflow.ts`**
  - Sequential steps: `validate-cart`, `reserve-inventory`
  - Step with retry & external idempotency: `process-payment` (passes `idempotencyKey: \`pay_\${runId}\``; simulated gateway records charges; throws on first attempt if `simulatePaymentFailure: true`)
  - Parallel sibling steps: `Promise.all([send-confirmation-email, update-crm-records, dispatch-warehouse-fulfillment])`
  - Final step: `generate-invoice`
- [ ] **Step 5: Run tests to verify GREEN**
- [ ] **Step 6: Commit**

---

### Task 2: Event-Driven Binding, Mock Services & CLI Runner for Reference App
**Files:**
- Create: `examples/order-processing/src/services/mock-services.ts`
- Create: `examples/order-processing/src/cli.ts`
- Modify: `examples/order-processing/package.json` (add scripts: `"start": "tsx src/cli.ts"`)
- Test: `examples/order-processing/test/event-integration.test.ts`

**Interfaces:**
- Consumes: `@durable/client: createClient`, `@durable/worker: createWorker`, `@durable/api`, `processOrderWorkflow`
- Produces: Event-driven order dispatch via `order.created` event, automatic workflow execution, and CLI with SSE terminal streaming

- [ ] **Step 1: Write failing test verifying event-driven `order.created` ingestion triggers `processOrderWorkflow`**
- [ ] **Step 2: Run test to verify RED**
- [ ] **Step 3: Implement mock inventory/email services, event dispatch integration, and CLI runner**
- [ ] **Step 4: Run test to verify GREEN**
- [ ] **Step 5: Commit**

---

### Task 3: Scaffolding `benchmarks/` Package, Hardware Introspection & Artifact Reporter
**Files:**
- Create: `benchmarks/package.json`
- Create: `benchmarks/tsconfig.json`
- Create: `benchmarks/src/types.ts`
- Create: `benchmarks/src/sysinfo.ts`
- Create: `benchmarks/src/reporter.ts`
- Test: `benchmarks/test/sysinfo-reporter.test.ts`

**Interfaces:**
- Produces: `collectSystemMetadata()`, `saveBenchmarkArtifact(result)` generating JSON & Markdown in `benchmarks/results/` with CPU, RAM, OS, Node, Git SHA, worker config, raw latency samples, and statistical percentiles (P50, P95, P99)

- [ ] **Step 1: Create package.json and tsconfig.json for benchmarks**
- [ ] **Step 2: Write failing test for system info collection, percentile calculation, and report formatting**
- [ ] **Step 3: Run test to verify RED**
- [ ] **Step 4: Implement `sysinfo.ts`, percentile calculations, and `reporter.ts`**
- [ ] **Step 5: Run test to verify GREEN**
- [ ] **Step 6: Commit**

---

### Task 4: Horizontal Multi-Worker Replica Scaling Benchmark Harness
**Files:**
- Create: `benchmarks/src/worker-runner.ts` (child process worker replica entrypoint)
- Create: `benchmarks/src/bench-throughput.ts`
- Modify: `benchmarks/package.json` (add `"bench:throughput": "tsx src/bench-throughput.ts"`)
- Test: `benchmarks/test/throughput-harness.test.ts`

**Interfaces:**
- Consumes: `node:child_process.fork`, `@durable/database: createPrismaClient`, `benchmarks/src/reporter.ts`
- Produces: Benchmark runner measuring completed workflows/sec across 1, 2, 4, and 8 independent worker processes with fixed per-worker concurrency, warmup phase, 3 measured repetitions, and raw sample persistence

- [ ] **Step 1: Write failing automated test for multi-process worker runner and harness orchestration**
- [ ] **Step 2: Run test to verify RED**
- [ ] **Step 3: Implement `worker-runner.ts` and `bench-throughput.ts` with child-process replica management, warmup, and repetition logic**
- [ ] **Step 4: Run test to verify GREEN (correctness verification only; no brittle throughput thresholds)**
- [ ] **Step 5: Commit**

---

### Task 5: Real SIGKILL Worker Chaos & Redis Destruction Reconciler Benchmarks
**Files:**
- Create: `benchmarks/src/bench-chaos.ts`
- Create: `benchmarks/src/bench-reconciliation.ts`
- Modify: `benchmarks/package.json` (add scripts: `"bench:chaos"`, `"bench:recovery"`, `"bench:all"`)
- Test: `benchmarks/test/chaos-reconciliation.test.ts`

**Interfaces:**
- Consumes: `process.kill(pid, 'SIGKILL')`, `@durable/reconciler: WorkflowReconciler`, `ioredis: FLUSHALL`
- Produces: Real process SIGKILL crash recovery latency runner and Redis complete destruction queue reconstruction runner

- [ ] **Step 1: Write failing automated tests for real worker SIGKILL recovery and Redis FLUSHALL queue reconstruction**
- [ ] **Step 2: Run tests to verify RED**
- [ ] **Step 3: Implement abrupt child-process `SIGKILL` mid-step chaos runner with lease expiry recovery (`bench-chaos.ts`)**
- [ ] **Step 4: Implement Redis `FLUSHALL` destruction & reconciler reconstruction runner asserting 0 lost/duplicate runs (`bench-reconciliation.ts`)**
- [ ] **Step 5: Run tests to verify GREEN**
- [ ] **Step 6: Commit**

---

### Task 6: Full Monorepo Verification & Benchmark Artifact Generation
**Files:**
- Run: `pnpm --filter @durable/benchmarks run bench:all`
- Generate: `benchmarks/results/benchmark-*.json` and `benchmarks/results/benchmark-*.md`
- Modify: `.scratch/durable-engine/issues/13-order-processing-example-and-benchmarks.md` (mark completed)

- [ ] **Step 1: Run full monorepo test suite (`pnpm test`) across all packages to ensure zero regressions**
- [ ] **Step 2: Execute benchmark runner to generate official markdown and JSON performance artifacts with environment metadata**
- [ ] **Step 3: Verify Turbo build (`pnpm run build`)**
- [ ] **Step 4: Update issue 13 checkboxes and status to completed**
- [ ] **Step 5: Commit**
