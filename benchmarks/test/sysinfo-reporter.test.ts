import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectSystemMetadata, calculatePercentiles } from '../src/sysinfo.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from '../src/reporter.js';
import { parseProfileArg } from '../src/bench-all.js';
import type { BenchmarkReport } from '../src/types.js';

describe('Hardware Introspection & Percentiles (sysinfo.ts)', () => {
  it('collects valid system hardware metadata and git commit sha', async () => {
    const meta = await collectSystemMetadata();

    expect(meta).toBeDefined();
    expect(meta.nodeVersion).toBe(process.version);
    expect(meta.platform).toBe(os.platform());
    expect(meta.osRelease).toBe(os.release());
    expect(meta.cpuArch).toBe(os.arch());
    expect(typeof meta.cpuModel).toBe('string');
    expect(meta.cpuModel.length).toBeGreaterThan(0);
    expect(meta.cpuCores).toBeGreaterThan(0);
    expect(meta.totalMemoryBytes).toBeGreaterThan(0);
    expect(meta.totalMemoryGb).toBeGreaterThan(0);
    expect(typeof meta.gitCommitSha).toBe('string');
    expect(meta.gitCommitSha.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(meta.timestamp))).toBe(false);
  });

  describe('calculatePercentiles', () => {
    it('handles empty sample array gracefully', () => {
      const stats = calculatePercentiles([]);
      expect(stats).toEqual({
        min: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        max: 0,
        avg: 0,
      });
    });

    it('calculates percentiles for a single-element sample', () => {
      const stats = calculatePercentiles([42]);
      expect(stats).toEqual({
        min: 42,
        p50: 42,
        p95: 42,
        p99: 42,
        max: 42,
        avg: 42,
      });
    });

    it('calculates accurate percentiles on a known uniform dataset (1 to 100)', () => {
      const samples = Array.from({ length: 100 }, (_, i) => i + 1);
      const stats = calculatePercentiles(samples);

      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.avg).toBe(50.5);
      expect(stats.p50).toBe(50);
      expect(stats.p95).toBe(95);
      expect(stats.p99).toBe(99);
    });

    it('sorts unsorted input arrays before calculating percentiles', () => {
      const unsorted = [50, 10, 40, 20, 30];
      const stats = calculatePercentiles(unsorted);

      expect(stats.min).toBe(10);
      expect(stats.max).toBe(50);
      expect(stats.avg).toBe(30);
      expect(stats.p50).toBe(30);
      expect(stats.p95).toBe(50);
      expect(stats.p99).toBe(50);
    });
  });
});

describe('Artifact Reporter (reporter.ts)', () => {
  const tempTestDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempTestDirs) {
      if (fs.existsSync(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }
    tempTestDirs.length = 0;
  });

  const sampleReport: BenchmarkReport = {
    id: 'test-run-12345',
    title: 'Order Processing Scaling & Chaos Benchmark',
    timestamp: '2026-09-07T02:00:00.000Z',
    system: {
      nodeVersion: 'v22.13.0',
      platform: 'win32',
      osRelease: '10.0.22631',
      cpuArch: 'x64',
      cpuModel: 'Intel Core i9-14900K',
      cpuCores: 24,
      totalMemoryBytes: 34359738368,
      totalMemoryGb: 32,
      gitCommitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      timestamp: '2026-09-07T02:00:00.000Z',
    },
    throughput: [
      {
        workerReplicas: 1,
        concurrencyPerWorker: 5,
        totalWorkers: 1,
        warmupRuns: 5,
        measuredRepetitions: 3,
        runsPerRepetition: 20,
        totalWorkflows: 60,
        durationsMs: [4500, 4400, 4600],
        medianDurationMs: 4500,
        throughputsPerSec: [13.33, 13.64, 13.04],
        medianThroughputPerSec: 13.33,
        latencyMs: {
          min: 40,
          p50: 75,
          p95: 120,
          p99: 150,
          max: 180,
          avg: 80.5,
        },
        rawLatenciesMs: [40, 75, 120, 150, 180],
      },
    ],
    chaos: {
      scenario: 'WORKER_SIGKILL_RECOVERY',
      workerPid: 1234,
      killSignal: 'SIGKILL',
      leaseTtlMs: 5000,
      recoveryLatencyMs: 1420,
      workflowRunId: 'run-chaos-999',
      duplicateStepCalls: 0,
      status: 'COMPLETED',
    },
    reconciliation: {
      scenario: 'REDIS_DESTRUCTION_RECONCILER',
      totalRunsSubmitted: 50,
      redisFlushCommand: 'FLUSHALL',
      reconstructionDurationMs: 380,
      lostRunsCount: 0,
      duplicateRunsCount: 0,
      completedRunsCount: 50,
      status: 'PASSED',
    },
  };

  it('formats human-readable GitHub-flavored markdown report with all benchmark sections', () => {
    const md = formatMarkdownReport(sampleReport);

    expect(md).toContain('# Order Processing Scaling & Chaos Benchmark');
    expect(md).toContain('test-run-12345');
    expect(md).toContain('## System Information');
    expect(md).toContain('Intel Core i9-14900K');
    expect(md).toContain('abcdef1234567890abcdef1234567890abcdef12');

    // Throughput table
    expect(md).toContain('## Throughput Scaling');
    expect(md).toContain('| Replicas | Concurrency | Total Completed | Median Workflows/Sec | P50 (ms) | P95 (ms) | P99 (ms) |');
    expect(md).toContain('| 1 | 5 | 60 | 13.33 | 75 | 120 | 150 |');

    // Chaos table
    expect(md).toContain('## Chaos: Worker Crash & Recovery');
    expect(md).toContain('SIGKILL');
    expect(md).toContain('5000');
    expect(md).toContain('1420');
    expect(md).toContain('0'); // duplicate step calls assertion

    // Reconciliation table
    expect(md).toContain('## Redis Destruction & Reconciliation');
    expect(md).toContain('FLUSHALL');
    expect(md).toContain('380');
    expect(md).toContain('PASSED');
  });

  it('formats comprehensive 7-dimension benchmark report with CV-ready impact statements', () => {
    const fullBenchmarkReport: BenchmarkReport = {
      id: 'full-test-report-2026',
      title: 'Durable Workflow Engine Performance & Resilience Benchmark Suite',
      timestamp: '2026-09-07T08:00:00.000Z',
      profile: 'full',
      system: {
        nodeVersion: 'v22.13.0',
        platform: 'win32',
        osRelease: '10.0.22631',
        cpuArch: 'x64',
        cpuModel: 'Intel Core i9-14900K',
        cpuCores: 24,
        totalMemoryBytes: 34359738368,
        totalMemoryGb: 32,
        gitCommitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        timestamp: '2026-09-07T08:00:00.000Z',
        postgresVersion: 'PostgreSQL 16.2',
        redisVersion: '7.2.4',
      },
      throughput: [
        {
          workerReplicas: 1,
          concurrencyPerWorker: 8,
          totalWorkers: 1,
          warmupRuns: 5,
          measuredRepetitions: 3,
          runsPerRepetition: 100,
          totalWorkflows: 300,
          durationsMs: [5000, 4900, 5100],
          medianDurationMs: 5000,
          throughputsPerSec: [60.0, 61.2, 58.8],
          medianThroughputPerSec: 60.0,
          stepsPerSec: 240.0,
          latencyMs: { min: 10, p50: 16, p95: 35, p99: 50, max: 75, avg: 18 },
          queueLatencyMs: { min: 1, p50: 3, p95: 8, p99: 15, max: 22, avg: 4 },
          rawLatenciesMs: [10, 16, 35, 50, 75],
        },
        {
          workerReplicas: 4,
          concurrencyPerWorker: 8,
          totalWorkers: 4,
          warmupRuns: 5,
          measuredRepetitions: 3,
          runsPerRepetition: 100,
          totalWorkflows: 300,
          durationsMs: [1300, 1250, 1350],
          medianDurationMs: 1300,
          throughputsPerSec: [230.7, 240.0, 222.2],
          medianThroughputPerSec: 230.7,
          stepsPerSec: 922.8,
          latencyMs: { min: 8, p50: 13, p95: 28, p99: 42, max: 60, avg: 15 },
          queueLatencyMs: { min: 1, p50: 2, p95: 5, p99: 10, max: 18, avg: 3 },
          rawLatenciesMs: [8, 13, 28, 42, 60],
        },
      ],
      saturation: {
        scenario: 'OFFERED_LOAD_SATURATION',
        fixedWorkerReplicas: 4,
        concurrencyPerWorker: 8,
        saturationPointReqPerSec: 150,
        status: 'PASSED',
        tiers: [
          {
            offeredRateReqPerSec: 50,
            acceptedRuns: 250,
            completedRuns: 250,
            durationMs: 5000,
            achievedThroughputPerSec: 50.0,
            maxQueueDepth: 12,
            queueLatencyMs: { min: 2, p50: 5, p95: 12, p99: 18, max: 25, avg: 6 },
            isSaturated: false,
          },
          {
            offeredRateReqPerSec: 150,
            acceptedRuns: 750,
            completedRuns: 720,
            durationMs: 5200,
            achievedThroughputPerSec: 138.5,
            maxQueueDepth: 85,
            queueLatencyMs: { min: 10, p50: 45, p95: 160, p99: 220, max: 310, avg: 55 },
            isSaturated: true,
          },
        ],
      },
      reconciliationMultiTier: {
        scenario: 'MULTI_TIER_REDIS_RECONSTRUCTION',
        redisFlushCommand: 'FLUSHALL',
        status: 'PASSED',
        tiers: [
          {
            totalRunsSubmitted: 100,
            reconstructionDurationMs: 120,
            requeueRatePerSec: 833.33,
            lostRunsCount: 0,
            duplicateRunsCount: 0,
            completedRunsCount: 100,
            status: 'PASSED',
          },
          {
            totalRunsSubmitted: 10000,
            reconstructionDurationMs: 420,
            requeueRatePerSec: 23809.52,
            lostRunsCount: 0,
            duplicateRunsCount: 0,
            completedRunsCount: 10000,
            status: 'PASSED',
          },
        ],
      },
      chaosMultiTtl: {
        scenario: 'MULTI_TTL_CHAOS_SWEEP',
        status: 'PASSED',
        results: [
          {
            scenario: 'WORKER_SIGKILL_RECOVERY',
            workerPid: 1001,
            killSignal: 'SIGKILL',
            leaseTtlMs: 2000,
            recoveryLatencyMs: 1100,
            timeToAbandonedMs: 2050,
            workflowRunId: 'chaos-run-2s',
            duplicateStepCalls: 0,
            status: 'COMPLETED',
          },
          {
            scenario: 'WORKER_SIGKILL_RECOVERY',
            workerPid: 1002,
            killSignal: 'SIGKILL',
            leaseTtlMs: 30000,
            recoveryLatencyMs: 1450,
            timeToAbandonedMs: 30100,
            workflowRunId: 'chaos-run-30s',
            duplicateStepCalls: 0,
            status: 'COMPLETED',
          },
        ],
      },
      fencing: {
        scenario: 'ZOMBIE_WORKER_FENCING',
        workflowRunId: 'fencing-run-99',
        stepKey: 'step-0',
        workerAPid: 8801,
        workerBPid: 8802,
        leaseTtlMs: 2000,
        workerAAttemptNumber: 1,
        workerBAttemptNumber: 2,
        workerAError: 'StaleAttemptError: lease expired',
        workerBStatus: 'COMPLETED',
        finalStepAttemptCount: 2,
        fencingEnforced: true,
        status: 'PASSED',
      },
      retryOverhead: {
        scenario: 'RELIABILITY_RETRY_OVERHEAD',
        status: 'PASSED',
        tiers: [
          {
            failureRatePercent: 0,
            totalWorkflows: 50,
            durationMs: 1000,
            throughputPerSec: 50.0,
            latencyMs: { min: 12, p50: 18, p95: 28, p99: 35, max: 40, avg: 20 },
            totalStepAttempts: 50,
            meanAttemptsPerWorkflow: 1.0,
          },
          {
            failureRatePercent: 20,
            totalWorkflows: 50,
            durationMs: 1250,
            throughputPerSec: 40.0,
            latencyMs: { min: 14, p50: 24, p95: 45, p99: 60, max: 70, avg: 25 },
            totalStepAttempts: 62,
            meanAttemptsPerWorkflow: 1.24,
          },
        ],
      },
    };

    const md = formatMarkdownReport(fullBenchmarkReport);

    // CV-Ready Impact Statements
    expect(md).toContain('## CV-Ready Impact Statements');
    expect(md).toMatch(/Scaled throughput by (3\.8|3\.9)x across worker replicas/);
    expect(md).toContain('230.7 workflows/s');
    expect(md).toContain('922.8 steps/s');
    expect(md).toContain('sub-second queue latency');
    expect(md).toMatch(/Reconstructed 10,?000 pending workflow states/);
    expect(md).toContain('420');
    expect(md).toContain('zero lost runs');
    expect(md).toContain('0 duplicate memoized step calls');
    expect(md).toContain('100% rejection rate');

    // Dimension 1: Environment & Engine Metadata
    expect(md).toContain('PostgreSQL 16.2');
    expect(md).toContain('7.2.4');

    // Dimension 2: Horizontal Worker Scaling
    expect(md).toContain('## Horizontal Worker Scaling');
    expect(md).toContain('| 4 | 8 | 300 | 230.7 | 922.8 | 13 | 28 | 42 | 5 |');

    // Dimension 3: Offered Load Saturation Curve
    expect(md).toContain('## Offered Load Saturation Curve');
    expect(md).toContain('150'); // saturation knee
    expect(md).toContain('| 50 | 250 | 250 |');
    expect(md).toContain('| 150 | 750 | 720 |');

    // Dimension 4: Multi-Tier Redis Reconstruction
    expect(md).toContain('## Multi-Tier Redis Reconstruction');
    expect(md).toContain('| 100 | FLUSHALL | 120 | 833.33 | 0 | 0 | 100 | PASSED |');
    expect(md).toContain('| 10000 | FLUSHALL | 420 | 23809.52 | 0 | 0 | 10000 | PASSED |');

    // Dimension 5: Crash Recovery Latency vs Lease TTL
    expect(md).toContain('## Crash Recovery Latency vs Lease TTL');
    expect(md).toContain('| 2000 | 1100 | 2050 | 0 | COMPLETED |');
    expect(md).toContain('| 30000 | 1450 | 30100 | 0 | COMPLETED |');

    // Dimension 6: Zombie Worker Distributed Fencing Proof
    expect(md).toContain('## Zombie Worker Fencing');
    expect(md).toContain('fencing-run-99');
    expect(md).toContain('StaleAttemptError');

    // Dimension 7: Reliability Retry Overhead
    expect(md).toContain('## Transient Failure Retry Overhead');
    expect(md).toContain('| 0% | 50 | 1000 | 50 | 18 | 28 | 1 |');
    expect(md).toContain('| 20% | 50 | 1250 | 40 | 24 | 45 | 1.24 |');
  });

  it('saves persistent JSON and Markdown artifacts to specified output directory', async () => {
    const testDir = path.join(os.tmpdir(), `benchmarks-test-${Date.now()}`);
    tempTestDirs.push(testDir);

    const { jsonPath, markdownPath } = await saveBenchmarkArtifact(sampleReport, testDir);

    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(markdownPath)).toBe(true);

    const parsedJson = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    expect(parsedJson.id).toBe(sampleReport.id);
    expect(parsedJson.system.cpuModel).toBe(sampleReport.system.cpuModel);
    expect(parsedJson.throughput?.[0]?.medianThroughputPerSec).toBe(13.33);

    const mdContent = await fs.promises.readFile(markdownPath, 'utf8');
    expect(mdContent).toContain('# Order Processing Scaling & Chaos Benchmark');
    expect(mdContent).toContain('Intel Core i9-14900K');
  });

  describe('parseProfileArg (bench-all.ts)', () => {
    it('defaults to quick profile when no arguments are provided', () => {
      expect(parseProfileArg([])).toBe('quick');
    });

    it('correctly parses --profile=full flag', () => {
      expect(parseProfileArg(['--profile=full'])).toBe('full');
      expect(parseProfileArg(['--full'])).toBe('full');
    });

    it('correctly parses --profile=quick flag', () => {
      expect(parseProfileArg(['--profile=quick'])).toBe('quick');
      expect(parseProfileArg(['--quick'])).toBe('quick');
    });
  });
});
