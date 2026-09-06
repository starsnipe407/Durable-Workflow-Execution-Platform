import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectSystemMetadata, calculatePercentiles } from '../src/sysinfo.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from '../src/reporter.js';
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
});
