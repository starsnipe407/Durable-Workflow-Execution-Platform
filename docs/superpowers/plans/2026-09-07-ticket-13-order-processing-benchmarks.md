# Implementation Plan: Ticket 13 — Order Processing Example and Benchmarks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical order processing reference application (`examples/order-processing`), complete with simulated services, step-level retries, and parallel steps, along with a standalone benchmark and chaos suite (`benchmarks/`) measuring throughput scaling, crash recovery latency, and Redis reconstruction with zero data loss, archiving reproducible markdown and JSON artifacts.

**Architecture:** 
- `examples/order-processing` as a private workspace package exporting the `processOrderWorkflow` definition and a standalone CLI demonstrating real-time SSE execution streaming.
- `benchmarks` as a private workspace package containing modules for system hardware introspection (`sysinfo.ts`), multi-worker throughput scaling (`bench-throughput.ts`), crash chaos testing (`bench-chaos.ts`), Redis flush reconciliation resilience (`bench-reconciliation.ts`), and report generation (`reporter.ts`).
- Vitest automated test suites validating functional correctness and asserting performance invariants in CI/CD.

**Tech Stack:** Node.js 22+, TypeScript 5.6, Turborepo, Vitest 2.1, Prisma 6.19, Fastify 5, BullMQ 6, ioredis 6.

## Global Constraints
- Ponytail intensity: FULL (lean, minimal code, zero unneeded abstractions, native fetch, native child_process/cluster).
- Author and committer on all git commits: `Aztrek <starsnipe407@gmail.com>`.
- Strict clean-room implementation obeying `docs/spec/reference-reuse-boundaries.md`.
- No cross-tenant data leakage: all test and benchmark runs scoped cleanly with complete teardown in `afterAll`.

---

### Task 1: Scaffolding `examples/order-processing` & Core Workflow Definition
**Files:**
- Create: `examples/order-processing/package.json`
- Create: `examples/order-processing/tsconfig.json`
- Create: `examples/order-processing/src/types.ts`
- Create: `examples/order-processing/src/workflow.ts`
- Test: `examples/order-processing/test/order-workflow.test.ts`

**Interfaces:**
- Consumes: `@durable/workflow-sdk: defineWorkflow, StepContext`
- Produces: `processOrderWorkflow`, `OrderInput`, `OrderOutput`

- [ ] **Step 1: Create package.json and tsconfig.json for examples/order-processing**
- [ ] **Step 2: Write failing test in `examples/order-processing/test/order-workflow.test.ts`**
- [ ] **Step 3: Run test to verify RED**
- [ ] **Step 4: Implement types and workflow in `src/types.ts` and `src/workflow.ts`**
  - Sequential steps: `validate-cart`, `reserve-inventory`
  - Step with retry: `process-payment` (with exponential backoff, testing transient failure flag)
  - Parallel sibling steps: `Promise.all([send-confirmation-email, update-crm-records, dispatch-warehouse-fulfillment])`
  - Final step: `generate-invoice`
- [ ] **Step 5: Run test to verify GREEN**
- [ ] **Step 6: Commit**

---

### Task 2: Interactive CLI Runner & Simulated Services for Reference App
**Files:**
- Create: `examples/order-processing/src/services/mock-services.ts`
- Create: `examples/order-processing/src/cli.ts`
- Modify: `examples/order-processing/package.json` (add scripts: `"start": "tsx src/cli.ts"`)
- Test: `examples/order-processing/test/cli-runner.test.ts`

**Interfaces:**
- Consumes: `@durable/client: createClient`, `@durable/worker: createWorker`, `processOrderWorkflow`
- Produces: Runnable CLI for manual/demo live order execution with SSE terminal updates

- [ ] **Step 1: Write failing test for mock services & CLI execution**
- [ ] **Step 2: Run test to verify RED**
- [ ] **Step 3: Implement mock payment, inventory, email services and CLI runner**
- [ ] **Step 4: Run test to verify GREEN**
- [ ] **Step 5: Verify standalone execution via tsx**
- [ ] **Step 6: Commit**

---

### Task 3: Scaffolding `benchmarks/` Package, Hardware Introspection & Reporter
**Files:**
- Create: `benchmarks/package.json`
- Create: `benchmarks/tsconfig.json`
- Create: `benchmarks/src/types.ts`
- Create: `benchmarks/src/sysinfo.ts`
- Create: `benchmarks/src/reporter.ts`
- Test: `benchmarks/test/sysinfo-reporter.test.ts`

**Interfaces:**
- Produces: `collectSystemMetadata()`, `saveBenchmarkArtifact(result)` generating JSON & Markdown in `benchmarks/results/`

- [ ] **Step 1: Create package.json and tsconfig.json for benchmarks**
- [ ] **Step 2: Write failing test for system info collection and report formatting**
- [ ] **Step 3: Run test to verify RED**
- [ ] **Step 4: Implement `sysinfo.ts` (OS, CPU cores, RAM, Git SHA) and `reporter.ts`**
- [ ] **Step 5: Run test to verify GREEN**
- [ ] **Step 6: Commit**

---

### Task 4: Multi-Worker Throughput Scaling Benchmark
**Files:**
- Create: `benchmarks/src/bench-throughput.ts`
- Modify: `benchmarks/package.json` (add `"bench:throughput": "tsx src/bench-throughput.ts"`)
- Test: `benchmarks/test/throughput.test.ts`

**Interfaces:**
- Consumes: `@durable/worker: createWorker`, `@durable/database: createPrismaClient`, `benchmarks/src/reporter.ts`
- Produces: Benchmark runner measuring completed workflows/sec across 1, 2, 4, and 8 worker concurrency slots with p50/p95/p99 latency metrics

- [ ] **Step 1: Write failing automated integration test for throughput measurement**
- [ ] **Step 2: Run test to verify RED**
- [ ] **Step 3: Implement `bench-throughput.ts` with worker cluster concurrency loop and high-resolution timing**
- [ ] **Step 4: Run test to verify GREEN**
- [ ] **Step 5: Commit**

---

### Task 5: Crash Recovery Chaos & Redis Flush Reconciler Benchmarks
**Files:**
- Create: `benchmarks/src/bench-chaos.ts`
- Create: `benchmarks/src/bench-reconciliation.ts`
- Modify: `benchmarks/package.json` (add scripts: `"bench:chaos"`, `"bench:recovery"`, `"bench:all"`)
- Test: `benchmarks/test/chaos-reconciliation.test.ts`

**Interfaces:**
- Consumes: `@durable/reconciler: WorkflowReconciler`, `@durable/worker: createWorker`, `ioredis`
- Produces: Chaos recovery latency benchmark and Redis flush zero-loss verification benchmark

- [ ] **Step 1: Write failing automated tests for worker kill/recovery latency and Redis flush queue reconstruction**
- [ ] **Step 2: Run tests to verify RED**
- [ ] **Step 3: Implement worker abrupt termination & lease expiry recovery runner (`bench-chaos.ts`)**
- [ ] **Step 4: Implement Redis flush & reconciler queue rebuild runner (`bench-reconciliation.ts`)**
- [ ] **Step 5: Run tests to verify GREEN**
- [ ] **Step 6: Commit**

---

### Task 6: Full Verification Gate & Performance Artifact Generation
**Files:**
- Run: `pnpm bench:all` or Vitest benchmark suites
- Generate: `benchmarks/results/benchmark-*.json` and `benchmarks/results/benchmark-*.md`
- Modify: `.scratch/durable-engine/issues/13-order-processing-example-and-benchmarks.md` (mark completed)

- [ ] **Step 1: Run full monorepo test suite (`pnpm test`) across all packages**
- [ ] **Step 2: Execute benchmark suite to generate official markdown and JSON artifacts**
- [ ] **Step 3: Verify Turbo build (`pnpm run build`)**
- [ ] **Step 4: Update issue 13 checkboxes and status to completed**
- [ ] **Step 5: Commit**
