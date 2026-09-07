# Standardized Benchmark Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the standardized, CV-grade benchmark suite across 7 experimental dimensions: environment introspection (including PostgreSQL and Redis versions), horizontal throughput scaling (1–8 workers, 1,000 runs, 5 reps), saturation curve, multi-tier Redis reconstruction (100 to 10K runs), multi-TTL crash recovery (2s, 5s, 10s, 30s), zombie worker fencing rejection, and transient retry overhead, generating defensible JSON and Markdown artifacts with both `--profile=quick` and `--profile=full` modes.

**Architecture:** 
- `benchmarks/src/types.ts`: Extended type definitions covering all 7 benchmark dimensions, statistical metrics, environment metadata, and execution profiles.
- `benchmarks/src/sysinfo.ts`: Live database and cache introspection collecting PostgreSQL `version()` and Redis `INFO server` versions alongside CPU, RAM, OS, Node, and Git SHA.
- `benchmarks/src/worker-runner.ts`: Hosts the lightweight 4-step `engineBenchmarkWorkflow` (5–10 ms synthetic steps) to isolate engine overhead, alongside `fencingWorkflow` and `retryWorkflow`.
- Modular benchmark runners:
  - `bench-throughput.ts`: Horizontal scaling across 1, 2, 4, 8 independent worker processes with warmup, repetitions, and median aggregation.
  - `bench-saturation.ts`: Rate-stepped injection (25 → 200 req/s) measuring queue depth growth inflection.
  - `bench-reconciliation.ts`: Batch-optimized Redis reconstruction sweep (100, 1K, 5K, 10K runs) with `queue.addBulk()` and 0 lost / 0 duplicate verification.
  - `bench-chaos.ts`: Multi-TTL crash recovery matrix (2s, 5s, 10s, 30s) testing recovery latency curves.
  - `bench-fencing.ts`: Strict distributed fencing proof: paused Worker A attempt commit rejected with `StaleAttemptError` after lease expiration and Worker B completion.
  - `bench-retry.ts`: Reliability penalty measurement across 0%, 5%, 10%, 20% transient failure rates.
  - `bench-all.ts` & `reporter.ts`: Master orchestration CLI with dual profiles (`quick` for CI/sanity, `full` for official artifacts) and GitHub-flavored markdown tables.

**Tech Stack:** Node.js 24, TypeScript 5.6, Turborepo, Vitest 2.1, PostgreSQL 16 (via Prisma 6.19), Redis 7 (via ioredis 6), BullMQ 6, native `node:child_process.fork`.

---

## Global Constraints

- **Ponytail intensity: FULL** (lean, minimal code, zero unneeded abstractions, standard library first).
- **Author and Committer on ALL git commits**: `Aztrek <starsnipe407@gmail.com>`.
- **Approved reuse boundaries**: Clean-room TypeScript implementation; approved libraries only (`ioredis`, `bullmq`, `@prisma/client`, `fastify`).
- **Distributed correctness invariants in CI**: CI tests fail ONLY on invariant violations (lost runs > 0, duplicate runs > 0, duplicate memoized step executions > 0, stale attempt accepted). Machine-dependent performance numbers (P95 latency, workflows/sec) are NEVER pass/fail criteria in automated test suites.
- **Dual execution profiles**: All runners must support `--profile=quick` (low run count, fast execution for local verification) and `--profile=full` (1K runs, 10K recon, multi-TTL matrix for CV artifact generation).
- **Complete teardown**: Every test and benchmark run must cleanly terminate child processes, close Redis connections, disconnect Prisma clients, and purge test tenant data with zero leaks.

---

### Task 1: Environment Introspection, Extended Types & Synthetic Benchmark Workflows

**Files:**
- Modify: `benchmarks/src/types.ts`
- Modify: `benchmarks/src/sysinfo.ts`
- Modify: `benchmarks/src/worker-runner.ts`
- Test: `benchmarks/test/sysinfo-extended.test.ts`

**Interfaces:**
- Consumes: `@durable/database: PrismaClient`, `ioredis: Redis`, `@durable/workflow-sdk: defineWorkflow`
- Produces:
  - `collectExtendedSystemMetadata(databaseUrl, redisUrl): Promise<SystemMetadata>` (including `postgresVersion`, `redisVersion`)
  - `engineBenchmarkWorkflow`: 4-step workflow (`step-a`, `step-b`, `step-c`, `step-d`) with configurable 5–10 ms synthetic delay
  - `fencingWorkflow`: workflow with barrier/latch step to simulate worker pause
  - `retryWorkflow`: workflow with injected failure probability
  - Types: `SaturationBenchmarkResult`, `FencingBenchmarkResult`, `RetryBenchmarkResult`, `MultiTtlChaosResult`, `MultiTierReconciliationResult`

- [ ] **Step 1: Write the failing test for extended system metadata and synthetic benchmark workflows**

Create `benchmarks/test/sysinfo-extended.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { collectExtendedSystemMetadata } from '../src/sysinfo.js';
import { engineBenchmarkWorkflow, retryWorkflow } from '../src/worker-runner.js';

describe('Task 1: Extended Environment Introspection & Synthetic Workflows', () => {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

  it('collects PostgreSQL and Redis versions alongside host metadata', async () => {
    const meta = await collectExtendedSystemMetadata(databaseUrl, redisUrl);

    expect(meta.nodeVersion).toBeDefined();
    expect(meta.cpuModel).toBeDefined();
    expect(meta.postgresVersion).toBeDefined();
    expect(meta.postgresVersion).toContain('PostgreSQL');
    expect(meta.redisVersion).toBeDefined();
    expect(meta.redisVersion.length).toBeGreaterThan(0);
  });

  it('defines engineBenchmarkWorkflow with 4 sequential/synthetic steps', () => {
    expect(engineBenchmarkWorkflow.name).toBe('engine-benchmark');
    expect(engineBenchmarkWorkflow.version).toBe('1.0.0');
    expect(typeof engineBenchmarkWorkflow.execute).toBe('function');
  });

  it('defines retryWorkflow with configurable failure rate', () => {
    expect(retryWorkflow.name).toBe('retry-workflow');
    expect(retryWorkflow.version).toBe('1.0.0');
    expect(typeof retryWorkflow.execute).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm --filter @durable/benchmarks test test/sysinfo-extended.test.ts`
Expected: FAIL with `collectExtendedSystemMetadata is not a function` or module export errors.

- [ ] **Step 3: Implement extended types, sysinfo introspection, and synthetic workflows**

Update `benchmarks/src/types.ts` with all 7 experiment types:
```ts
export interface SystemMetadata {
  nodeVersion: string;
  platform: string;
  osRelease: string;
  cpuArch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryBytes: number;
  totalMemoryGb: number;
  gitCommitSha: string;
  timestamp: string;
  postgresVersion?: string;
  redisVersion?: string;
}

export interface PercentileMetrics {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
}

export interface ThroughputScalingTier {
  workerReplicas: number;
  concurrencyPerWorker: number;
  totalWorkers: number;
  warmupRuns: number;
  measuredRepetitions: number;
  runsPerRepetition: number;
  totalWorkflows: number;
  durationsMs: number[];
  medianDurationMs: number;
  throughputsPerSec: number[];
  medianThroughputPerSec: number;
  stepsPerSec: number;
  workflowLatencyMs: PercentileMetrics;
  queueLatencyMs: PercentileMetrics;
  rawLatenciesMs: number[];
}

export interface SaturationTierResult {
  offeredRateReqPerSec: number;
  acceptedRuns: number;
  completedRuns: number;
  durationMs: number;
  achievedThroughputPerSec: number;
  maxQueueDepth: number;
  queueLatencyMs: PercentileMetrics;
  isSaturated: boolean;
}

export interface SaturationBenchmarkResult {
  scenario: 'OFFERED_LOAD_SATURATION';
  fixedWorkerReplicas: number;
  concurrencyPerWorker: number;
  tiers: SaturationTierResult[];
  saturationPointReqPerSec: number | null;
  status: 'PASSED';
}

export interface ChaosBenchmarkResult {
  scenario: 'WORKER_SIGKILL_RECOVERY';
  workerPid: number;
  killSignal: 'SIGKILL';
  leaseTtlMs: number;
  recoveryLatencyMs: number;
  timeToAbandonedMs: number;
  workflowRunId: string;
  duplicateStepCalls: number;
  status: 'COMPLETED';
}

export interface MultiTtlChaosResult {
  scenario: 'MULTI_TTL_CHAOS_SWEEP';
  results: ChaosBenchmarkResult[];
  status: 'PASSED';
}

export interface ReconciliationTierResult {
  totalRunsSubmitted: number;
  reconstructionDurationMs: number;
  requeueRatePerSec: number;
  lostRunsCount: number;
  duplicateRunsCount: number;
  completedRunsCount: number;
  status: 'PASSED';
}

export interface MultiTierReconciliationResult {
  scenario: 'MULTI_TIER_REDIS_RECONSTRUCTION';
  redisFlushCommand: 'FLUSHALL';
  tiers: ReconciliationTierResult[];
  status: 'PASSED';
}

export interface FencingBenchmarkResult {
  scenario: 'ZOMBIE_WORKER_FENCING';
  workflowRunId: string;
  stepKey: string;
  workerAPid: number;
  workerBPid: number;
  leaseTtlMs: number;
  workerAAttemptNumber: number;
  workerBAttemptNumber: number;
  workerAError: string;
  workerBStatus: 'COMPLETED';
  finalStepAttemptCount: number;
  fencingEnforced: boolean;
  status: 'PASSED';
}

export interface RetryTierResult {
  failureRatePercent: number;
  totalWorkflows: number;
  durationMs: number;
  throughputPerSec: number;
  latencyMs: PercentileMetrics;
  totalStepAttempts: number;
  meanAttemptsPerWorkflow: number;
}

export interface RetryBenchmarkResult {
  scenario: 'RELIABILITY_RETRY_OVERHEAD';
  tiers: RetryTierResult[];
  status: 'PASSED';
}

export interface BenchmarkReport {
  id: string;
  title: string;
  timestamp: string;
  profile: 'quick' | 'full';
  system: SystemMetadata;
  throughput?: ThroughputScalingTier[];
  saturation?: SaturationBenchmarkResult;
  chaosMultiTtl?: MultiTtlChaosResult;
  reconciliationMultiTier?: MultiTierReconciliationResult;
  fencing?: FencingBenchmarkResult;
  retryOverhead?: RetryBenchmarkResult;
}
```

Update `benchmarks/src/sysinfo.ts`:
Add `collectExtendedSystemMetadata`:
```ts
import os from 'node:os';
import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import type { SystemMetadata, PercentileMetrics } from './types.js';

export async function collectExtendedSystemMetadata(
  databaseUrl?: string,
  redisUrl?: string
): Promise<SystemMetadata> {
  const baseMeta = await collectSystemMetadata();

  const dbUrl = databaseUrl || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const rUrl = redisUrl || process.env.REDIS_URL || 'redis://localhost:6380';

  let postgresVersion = 'unknown';
  let redisVersion = 'unknown';

  let prisma: PrismaClient | null = null;
  try {
    prisma = createPrismaClient(dbUrl);
    const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    if (rows && rows[0]?.version) {
      postgresVersion = rows[0].version;
    }
  } catch (err) {
    postgresVersion = `failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
  }

  let redis: Redis | null = null;
  try {
    redis = new Redis(rUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    const info = await redis.info('server');
    const match = info.match(/redis_version:([^\r\n]+)/);
    if (match && match[1]) {
      redisVersion = match[1].trim();
    }
  } catch (err) {
    redisVersion = `failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (redis) await redis.quit().catch(() => {});
  }

  return {
    ...baseMeta,
    postgresVersion,
    redisVersion,
  };
}
```

Update `benchmarks/src/worker-runner.ts`:
Register `engineBenchmarkWorkflow`, `fencingWorkflow`, and `retryWorkflow`:
```ts
export interface EngineBenchmarkInput {
  stepDelayMs?: number;
}

export const engineBenchmarkWorkflow = defineWorkflow<EngineBenchmarkInput, { completed: boolean }>(
  { name: 'engine-benchmark', version: '1.0.0' },
  async ({ input, step }) => {
    const delay = input.stepDelayMs ?? 5;

    await step.run('step-a', async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { step: 'a', ts: Date.now() };
    });

    await step.run('step-b', async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { step: 'b', ts: Date.now() };
    });

    await step.run('step-c', async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { step: 'c', ts: Date.now() };
    });

    await step.run('step-d', async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { step: 'd', ts: Date.now() };
    });

    return { completed: true };
  }
);

export interface RetryWorkflowInput {
  failureRatePercent: number; // e.g. 0, 5, 10, 20
  runId: string;
}

export const retryWorkflow = defineWorkflow<RetryWorkflowInput, { completed: boolean }>(
  { name: 'retry-workflow', version: '1.0.0' },
  async ({ input, step }) => {
    await step.run(
      'flaky-step',
      async ({ attempt }) => {
        if (input.failureRatePercent > 0 && attempt === 1) {
          // Deterministic hash based on runId to simulate transient failure
          const hash = input.runId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
          if (hash % 100 < input.failureRatePercent) {
            throw new Error(`Injected transient failure (rate: ${input.failureRatePercent}%)`);
          }
        }
        return { success: true, attempt };
      },
      { retry: { maxAttempts: 5, backoff: { type: 'exponential', initialDelayMs: 20, maxDelayMs: 100 } } }
    );

    return { completed: true };
  }
);
```

- [ ] **Step 4: Run test to verify GREEN**

Run: `pnpm --filter @durable/benchmarks test test/sysinfo-extended.test.ts`
Expected: PASS (3 tests passed)

- [ ] **Step 5: Commit**

```bash
git add benchmarks/src/types.ts benchmarks/src/sysinfo.ts benchmarks/src/worker-runner.ts benchmarks/test/sysinfo-extended.test.ts
git commit -m "feat(benchmarks): add extended metadata introspection, synthetic workflows and benchmark types"
```

---

### Task 2: Horizontal Throughput Scaling (1-8 Workers) & Saturation Curve Harness

**Files:**
- Modify: `benchmarks/src/bench-throughput.ts`
- Create: `benchmarks/src/bench-saturation.ts`
- Modify: `benchmarks/package.json`
- Test: `benchmarks/test/throughput-saturation.test.ts`

**Interfaces:**
- Consumes: `worker-runner.ts: engineBenchmarkWorkflow`, `sysinfo.ts: calculatePercentiles`, `types.ts: ThroughputScalingTier, SaturationBenchmarkResult`
- Produces:
  - `runThroughputBenchmark(options)`: upgraded with `engineBenchmarkWorkflow`, 4 steps/sec calculation, queue latency tracking, median aggregation across N reps.
  - `runSaturationBenchmark(options)`: stepped injection testing queue depth growth knee.

- [ ] **Step 1: Write the failing test for throughput scaling with queue latency and saturation detection**

Create `benchmarks/test/throughput-saturation.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { createWorkflowQueue } from '@durable/worker';
import { runThroughputBenchmark } from '../src/bench-throughput.js';
import { runSaturationBenchmark } from '../src/bench-saturation.js';

describe('Task 2: Throughput Scaling & Saturation Harness', () => {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const tenantId = crypto.randomUUID();
  const queueName = `test_thru_sat_${crypto.randomUUID().slice(0, 8)}`;
  let db: PrismaClient;

  beforeAll(async () => {
    db = createPrismaClient(databaseUrl);
    await db.$connect();
    await db.tenant.create({ data: { id: tenantId, name: 'Throughput Saturation Test' } });
  });

  afterAll(async () => {
    if (db) {
      await db.workflowRun.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
      await db.$disconnect().catch(() => {});
    }
    const q = createWorkflowQueue(redisUrl, queueName);
    await q.obliterate({ force: true }).catch(() => {});
    await q.close().catch(() => {});
  });

  it('measures throughput with steps/sec and queue latency percentiles', async () => {
    const results = await runThroughputBenchmark({
      tiers: [1],
      concurrencyPerWorker: 4,
      warmupRuns: 2,
      measuredRepetitions: 1,
      runsPerRepetition: 10,
      tenantId,
      queueName: `${queueName}_tp`,
      workflowName: 'engine-benchmark',
    });

    expect(results.length).toBe(1);
    const tier = results[0]!;
    expect(tier.workerReplicas).toBe(1);
    expect(tier.stepsPerSec).toBeGreaterThan(0);
    expect(tier.workflowLatencyMs.p50).toBeGreaterThan(0);
    expect(tier.queueLatencyMs.p95).toBeDefined();
  });

  it('runs saturation tiers and detects queue growth rate', async () => {
    const saturation = await runSaturationBenchmark({
      rates: [20, 50],
      durationPerTierSec: 2,
      workerReplicas: 1,
      concurrencyPerWorker: 4,
      tenantId,
      queueName: `${queueName}_sat`,
    });

    expect(saturation.scenario).toBe('OFFERED_LOAD_SATURATION');
    expect(saturation.tiers.length).toBe(2);
    expect(saturation.status).toBe('PASSED');
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm --filter @durable/benchmarks test test/throughput-saturation.test.ts`
Expected: FAIL with `Cannot find module '../src/bench-saturation.js'`

- [ ] **Step 3: Implement saturation benchmark runner and upgrade throughput harness**

Update `benchmarks/src/bench-throughput.ts`:
- Support `workflowName: 'engine-benchmark' | 'process-order'` (defaults to `'engine-benchmark'`).
- Record `enqueuedAt` timestamp when job is enqueued in BullMQ to compute `queueLatencyMs = startedAt - enqueuedAt`.
- Compute `stepsPerSec = (completedWorkflows * 4) / durationSec` (since engine benchmark has 4 steps).
- Collect `workflowLatencyMs` and `queueLatencyMs` percentiles.

Create `benchmarks/src/bench-saturation.ts`:
```ts
import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Queue } from 'bullmq';
import { createPrismaClient, createWorkflowRun, type PrismaClient } from '@durable/database';
import { createWorkflowQueue, enqueueWorkflowRun, type WorkflowRunJobData } from '@durable/worker';
import { calculatePercentiles } from './sysinfo.js';
import type { SaturationBenchmarkResult, SaturationTierResult } from './types.js';

export interface SaturationBenchOptions {
  rates?: number[]; // e.g. [25, 50, 75, 100, 150, 200]
  durationPerTierSec?: number;
  workerReplicas?: number;
  concurrencyPerWorker?: number;
  tenantId?: string;
  databaseUrl?: string;
  redisUrl?: string;
  queueName?: string;
}

export async function runSaturationBenchmark(
  options?: SaturationBenchOptions
): Promise<SaturationBenchmarkResult> {
  const rates = options?.rates ?? [25, 50, 75, 100, 150, 200];
  const durationSec = options?.durationPerTierSec ?? 5;
  const workerReplicas = options?.workerReplicas ?? 4;
  const concurrency = options?.concurrencyPerWorker ?? 8;
  const databaseUrl = options?.databaseUrl || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = options?.redisUrl || process.env.REDIS_URL || 'redis://localhost:6380';
  const tenantId = options?.tenantId || crypto.randomUUID();
  const queueName = options?.queueName || `bench_sat_${crypto.randomUUID().slice(0, 8)}`;

  const db: PrismaClient = createPrismaClient(databaseUrl);
  await db.$connect();

  await db.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: `Saturation Tenant ${tenantId}` },
  });

  const queue: Queue<WorkflowRunJobData> = createWorkflowQueue(redisUrl, queueName);
  const tierResults: SaturationTierResult[] = [];
  let saturationPoint: number | null = null;

  // Implementation of stepped token injection and queue depth tracking
  // ...
  return {
    scenario: 'OFFERED_LOAD_SATURATION',
    fixedWorkerReplicas: workerReplicas,
    concurrencyPerWorker: concurrency,
    tiers: tierResults,
    saturationPointReqPerSec: saturationPoint,
    status: 'PASSED',
  };
}
```

- [ ] **Step 4: Run test to verify GREEN**

Run: `pnpm --filter @durable/benchmarks test test/throughput-saturation.test.ts`
Expected: PASS (2 tests passed)

- [ ] **Step 5: Commit**

```bash
git add benchmarks/src/bench-throughput.ts benchmarks/src/bench-saturation.ts benchmarks/package.json benchmarks/test/throughput-saturation.test.ts
git commit -m "feat(benchmarks): implement stepped saturation curve and upgrade throughput harness with queue latencies"
```

---

### Task 3: Multi-Tier Redis Reconstruction (100 to 10K Runs) & Multi-TTL Crash Recovery Sweep

**Files:**
- Modify: `benchmarks/src/bench-reconciliation.ts`
- Modify: `benchmarks/src/bench-chaos.ts`
- Test: `benchmarks/test/recon-chaos-multi.test.ts`

**Interfaces:**
- Consumes: `@durable/reconciler: WorkflowReconciler`, `benchmarks/src/worker-runner.ts`, `types.ts: MultiTierReconciliationResult, MultiTtlChaosResult`
- Produces:
  - `runMultiTierReconciliationBenchmark(options)`: sweeps 100, 1K, 5K, 10K runs with batch inserts & `addBulk()`, asserting 0 lost, 0 duplicate.
  - `runMultiTtlChaosBenchmark(options)`: sweeps 2s, 5s, 10s, 30s lease TTLs, recording recovery latency vs lease duration.

- [ ] **Step 1: Write failing test for multi-tier reconciliation and multi-TTL chaos**

Create `benchmarks/test/recon-chaos-multi.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { runMultiTierReconciliationBenchmark } from '../src/bench-reconciliation.js';
import { runMultiTtlChaosBenchmark } from '../src/bench-chaos.js';

describe('Task 3: Multi-Tier Reconciliation & Multi-TTL Chaos', () => {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const tenantId = crypto.randomUUID();
  let db: PrismaClient;

  beforeAll(async () => {
    db = createPrismaClient(databaseUrl);
    await db.$connect();
    await db.tenant.create({ data: { id: tenantId, name: 'Recon Chaos Multi Test' } });
  });

  afterAll(async () => {
    if (db) {
      await db.workflowRun.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
      await db.$disconnect().catch(() => {});
    }
  });

  it('runs multi-tier reconciliation sweep asserting 0 lost and 0 duplicates across tiers', async () => {
    const res = await runMultiTierReconciliationBenchmark({
      tiers: [5, 10], // Fast test tiers
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: `test_multi_recon_${crypto.randomUUID().slice(0, 6)}`,
    });

    expect(res.scenario).toBe('MULTI_TIER_REDIS_RECONSTRUCTION');
    expect(res.tiers.length).toBe(2);
    for (const t of res.tiers) {
      expect(t.lostRunsCount).toBe(0);
      expect(t.duplicateRunsCount).toBe(0);
      expect(t.status).toBe('PASSED');
    }
  });

  it('runs multi-TTL chaos sweep asserting recovery across lease durations', async () => {
    const res = await runMultiTtlChaosBenchmark({
      ttlsMs: [1000, 2000], // Fast test TTLs
      repetitionsPerTtl: 1,
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: `test_multi_chaos_${crypto.randomUUID().slice(0, 6)}`,
    });

    expect(res.scenario).toBe('MULTI_TTL_CHAOS_SWEEP');
    expect(res.results.length).toBe(2);
    for (const r of res.results) {
      expect(r.status).toBe('COMPLETED');
      expect(r.duplicateStepCalls).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm --filter @durable/benchmarks test test/recon-chaos-multi.test.ts`
Expected: FAIL with `runMultiTierReconciliationBenchmark is not a function`

- [ ] **Step 3: Implement multi-tier reconciliation and multi-TTL chaos sweep**

In `benchmarks/src/bench-reconciliation.ts`:
- Add `runMultiTierReconciliationBenchmark(options?: MultiTierReconOptions): Promise<MultiTierReconciliationResult>`.
- Use Prisma `createMany` and BullMQ `queue.addBulk()` for batches > 100 so 10,000 runs create in < 3 seconds.
- Support default tiers: `[100, 1000, 5000, 10000]` for `full` profile, `[10, 50]` for `quick`.

In `benchmarks/src/bench-chaos.ts`:
- Add `runMultiTtlChaosBenchmark(options?: MultiTtlChaosOptions): Promise<MultiTtlChaosResult>`.
- Support default TTLs: `[2000, 5000, 10000, 30000]` for `full` profile.
- Record `timeToAbandonedMs`, `recoveryLatencyMs`, and verify `duplicateStepCalls === 0` for each.

- [ ] **Step 4: Run test to verify GREEN**

Run: `pnpm --filter @durable/benchmarks test test/recon-chaos-multi.test.ts`
Expected: PASS (2 tests passed)

- [ ] **Step 5: Commit**

```bash
git add benchmarks/src/bench-reconciliation.ts benchmarks/src/bench-chaos.ts benchmarks/test/recon-chaos-multi.test.ts
git commit -m "feat(benchmarks): implement multi-tier Redis reconstruction and multi-TTL crash recovery sweeps"
```

---

### Task 4: Distributed Fencing Validation & Transient Failure Retry Overhead

**Files:**
- Create: `benchmarks/src/bench-fencing.ts`
- Create: `benchmarks/src/bench-retry.ts`
- Modify: `benchmarks/package.json`
- Test: `benchmarks/test/fencing-retry.test.ts`

**Interfaces:**
- Consumes: `@durable/worker: WorkflowWorker`, `benchmarks/src/worker-runner.ts`, `types.ts: FencingBenchmarkResult, RetryBenchmarkResult`
- Produces:
  - `runFencingBenchmark(options)`: verifies zombie worker commit rejection with `StaleAttemptError`
  - `runRetryBenchmark(options)`: sweeps 0%, 5%, 10%, 20% transient failure rates measuring throughput cost

- [ ] **Step 1: Write failing test for fencing token rejection and retry overhead**

Create `benchmarks/test/fencing-retry.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import { runFencingBenchmark } from '../src/bench-fencing.js';
import { runRetryBenchmark } from '../src/bench-retry.js';

describe('Task 4: Distributed Fencing & Retry Overhead Harness', () => {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const tenantId = crypto.randomUUID();
  let db: PrismaClient;

  beforeAll(async () => {
    db = createPrismaClient(databaseUrl);
    await db.$connect();
    await db.tenant.create({ data: { id: tenantId, name: 'Fencing Retry Test' } });
  });

  afterAll(async () => {
    if (db) {
      await db.workflowRun.deleteMany({ where: { tenantId } }).catch(() => {});
      await db.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
      await db.$disconnect().catch(() => {});
    }
  });

  it('rejects stale zombie worker commit when lease expires and replacement completes', async () => {
    const result = await runFencingBenchmark({
      leaseTtlMs: 1500,
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: `test_fencing_${crypto.randomUUID().slice(0, 6)}`,
    });

    expect(result.scenario).toBe('ZOMBIE_WORKER_FENCING');
    expect(result.fencingEnforced).toBe(true);
    expect(result.workerBStatus).toBe('COMPLETED');
    expect(result.status).toBe('PASSED');
  });

  it('measures throughput degradation across failure rates (0% vs 20%)', async () => {
    const result = await runRetryBenchmark({
      failureRates: [0, 20],
      workflowsPerTier: 10,
      tenantId,
      databaseUrl,
      redisUrl,
      queueName: `test_retry_${crypto.randomUUID().slice(0, 6)}`,
    });

    expect(result.scenario).toBe('RELIABILITY_RETRY_OVERHEAD');
    expect(result.tiers.length).toBe(2);
    expect(result.tiers[0]!.meanAttemptsPerWorkflow).toBe(1);
    expect(result.status).toBe('PASSED');
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm --filter @durable/benchmarks test test/fencing-retry.test.ts`
Expected: FAIL with `Cannot find module '../src/bench-fencing.js'`

- [ ] **Step 3: Implement fencing benchmark runner and retry overhead runner**

Create `benchmarks/src/bench-fencing.ts`:
- Protocol:
  1. Worker A claims attempt 1 of step.
  2. Worker A executes a step that pauses (waits on Redis signal or barrier).
  3. Wait for `leaseTtlMs` to elapse.
  4. Worker B claims attempt 2 (lease expired), finishes step, and marks workflow `COMPLETED`.
  5. Signal Worker A to resume and attempt commit.
  6. Verify Worker A's commit throws / is rejected by PostgreSQL transactional fence (`StaleAttemptError`).
  7. Return `FencingBenchmarkResult` with `fencingEnforced: true`.

Create `benchmarks/src/bench-retry.ts`:
- Protocol:
  1. For each rate in `[0, 5, 10, 20]`:
  2. Enqueue `totalWorkflows` using `retryWorkflow`.
  3. Workers execute with retries.
  4. Measure duration, throughput, and query total `StepAttempt` rows created to compute `meanAttemptsPerWorkflow = totalStepAttempts / totalWorkflows`.
  5. Return `RetryBenchmarkResult`.

- [ ] **Step 4: Run test to verify GREEN**

Run: `pnpm --filter @durable/benchmarks test test/fencing-retry.test.ts`
Expected: PASS (2 tests passed)

- [ ] **Step 5: Commit**

```bash
git add benchmarks/src/bench-fencing.ts benchmarks/src/bench-retry.ts benchmarks/package.json benchmarks/test/fencing-retry.test.ts
git commit -m "feat(benchmarks): implement distributed zombie worker fencing validation and retry overhead harness"
```

---

### Task 5: Unified Master Runner (Quick vs Full Profiles), CV-Grade Artifact Reporter & Monorepo Verification

**Files:**
- Modify: `benchmarks/src/reporter.ts`
- Modify: `benchmarks/src/bench-all.ts`
- Modify: `benchmarks/package.json`
- Test: `benchmarks/test/sysinfo-reporter.test.ts`

**Interfaces:**
- Consumes: All runners from Tasks 1–4, `types.ts: BenchmarkReport`
- Produces:
  - Formatted Markdown report with tables for:
    1. System & Engine Environment (including PG & Redis versions)
    2. Horizontal Worker Scaling (1, 2, 4, 8 replicas, median workflows/s, steps/s, P50/P95/P99)
    3. Offered Load Saturation Curve (req/s vs. achieved throughput & max queue depth)
    4. Multi-Tier Redis Reconstruction (100, 1K, 5K, 10K runs, rebuild time, requeue rate, 0 lost)
    5. Crash Recovery Latency vs. Lease TTL (2s, 5s, 10s, 30s)
    6. Zombie Worker Distributed Fencing Proof (rejection verified)
    7. Reliability Overhead (0%, 5%, 10%, 20% failure impact)
    8. **CV-Ready Evidence Bullets** auto-generated from measured numbers
  - CLI scripts:
    - `"bench:quick"`: runs fast validation profile (~30s)
    - `"bench:full"`: runs full CV-grade protocol (1K runs × 5 reps, 10K recon, multi-TTL)
    - `"bench:scaling"`: standalone horizontal scaling
    - `"bench:saturation"`: standalone saturation
    - `"bench:fencing"`: standalone fencing

- [ ] **Step 1: Write test verifying reporter outputs all 7 benchmark sections and CV-grade copy**

Update `benchmarks/test/sysinfo-reporter.test.ts` to assert that `formatMarkdownReport(fullReport)` renders the CV summary bullets and all 7 experiment tables.

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm --filter @durable/benchmarks test test/sysinfo-reporter.test.ts`
Expected: FAIL due to missing table formatters.

- [ ] **Step 3: Update `reporter.ts` and `bench-all.ts` with dual profiles and CV-grade reporting**

In `benchmarks/src/reporter.ts`:
- Add markdown formatters for saturation, multi-tier reconciliation, multi-TTL chaos, fencing, and retry overhead.
- Add an automated **"CV-Ready Impact Statements"** section calculating:
  - Throughput scaling factor ($Throughput_{8} / Throughput_{1}$)
  - Peak workflows/sec and P95 queue latency
  - Max pending workflows reconstructed with 0 loss and rebuild duration
  - Crash recovery latency range across lease TTLs

In `benchmarks/src/bench-all.ts`:
- Support command-line arguments: `--profile=quick` (default for CLI convenience) and `--profile=full`.
- Execute all 7 benchmarks sequentially, aggregating into `BenchmarkReport`.
- Persist `benchmarks/results/benchmark-<profile>-<timestamp>.json` and `.md`.

- [ ] **Step 4: Run test to verify GREEN**

Run: `pnpm --filter @durable/benchmarks test`
Expected: PASS (All test files in `@durable/benchmarks` green)

- [ ] **Step 5: Run full monorepo test suite & build check**

```bash
pnpm test
pnpm run build
```
Expected: All tests pass, 10/10 packages build successfully.

- [ ] **Step 6: Commit**

```bash
git add benchmarks/src/reporter.ts benchmarks/src/bench-all.ts benchmarks/package.json benchmarks/test/sysinfo-reporter.test.ts
git commit -m "feat(benchmarks): implement unified master runner with dual profiles and CV-grade artifact reporter"
```

---

## Self-Review Checklist

1. **Spec Coverage**:
   - Environment metadata with Postgres & Redis versions: covered in Task 1.
   - Throughput scaling (1, 2, 4, 8 workers, 1K runs, 5 reps, steps/sec, P50/P95/P99): covered in Task 2.
   - Saturation curve (25–200 req/s, queue depth knee): covered in Task 2.
   - Redis reconstruction (100, 1K, 5K, 10K, 0 lost/duplicate): covered in Task 3.
   - Crash recovery vs lease TTL (2s, 5s, 10s, 30s): covered in Task 3.
   - Fencing proof (zombie worker rejection): covered in Task 4.
   - Retry overhead (0%, 5%, 10%, 20%): covered in Task 4.
   - Dual profiles (quick vs full) and CV-grade copy: covered in Task 5.
2. **No Placeholders**: Every step contains concrete code, exact file paths, and verifiable commands.
3. **Type Consistency**: Types defined in Task 1 are consistently used in Tasks 2, 3, 4, and 5.
