import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectExtendedSystemMetadata } from './sysinfo.js';
import { runThroughputBenchmark } from './bench-throughput.js';
import { runSaturationBenchmark } from './bench-saturation.js';
import { runMultiTierReconciliationBenchmark } from './bench-reconciliation.js';
import { runMultiTtlChaosBenchmark } from './bench-chaos.js';
import { runFencingBenchmark } from './bench-fencing.js';
import { runRetryBenchmark } from './bench-retry.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from './reporter.js';
import type { BenchmarkReport } from './types.js';

// Auto-load .env.test if environment variables are not already set
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  const envCandidates = [
    path.resolve(process.cwd(), '.env.test'),
    path.resolve(process.cwd(), '../.env.test'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.test'),
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            const v = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[k]) {
              process.env[k] = v;
            }
          }
        }
      } catch {}
      break;
    }
  }
}

export type BenchmarkProfile = 'quick' | 'full';

export interface RunAllBenchmarksOptions {
  profile?: BenchmarkProfile;
  outputDir?: string;
}

export function parseProfileArg(args: string[] = process.argv.slice(2)): BenchmarkProfile {
  for (const arg of args) {
    if (arg === '--profile=full' || arg === '--full' || arg === '-p=full') {
      return 'full';
    }
    if (arg === '--profile=quick' || arg === '--quick' || arg === '-p=quick') {
      return 'quick';
    }
  }
  return 'quick';
}

export async function runAllBenchmarks(
  optionsOrProfile?: RunAllBenchmarksOptions | BenchmarkProfile
): Promise<BenchmarkReport> {
  const profile: BenchmarkProfile =
    typeof optionsOrProfile === 'string'
      ? optionsOrProfile
      : optionsOrProfile?.profile ?? parseProfileArg();
  const outputDir =
    typeof optionsOrProfile === 'object' ? optionsOrProfile?.outputDir : undefined;

  const sysinfo = await collectExtendedSystemMetadata();
  console.log('=====================================================');
  console.log('  DURABLE WORKFLOW EXEC - COMPREHENSIVE BENCHMARKS   ');
  console.log('=====================================================');
  console.log(`Profile:     ${profile.toUpperCase()}`);
  console.log(`CPU:         ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
  console.log(`OS:          ${sysinfo.platform} ${sysinfo.osRelease} | Node: ${sysinfo.nodeVersion}`);
  console.log(`RAM:         ${sysinfo.totalMemoryGb} GB`);
  if (sysinfo.postgresVersion) console.log(`PostgreSQL:  ${sysinfo.postgresVersion}`);
  if (sysinfo.redisVersion) console.log(`Redis:       ${sysinfo.redisVersion}`);
  console.log('-----------------------------------------------------\n');

  // Configure benchmark profile parameters
  const isQuick = profile === 'quick';

  // 1. Horizontal Worker Scaling
  console.log('>>> [1/6] Running Horizontal Worker Scaling Benchmark...');
  const throughputResults = await runThroughputBenchmark(
    isQuick
      ? {
          tiers: [1, 2],
          concurrencyPerWorker: 4,
          warmupRuns: 2,
          measuredRepetitions: 2,
          runsPerRepetition: 10,
        }
      : {
          tiers: [1, 2, 4, 8],
          concurrencyPerWorker: 8,
          warmupRuns: 50,
          measuredRepetitions: 3,
          runsPerRepetition: 1000,
        }
  );
  console.log('✓ Horizontal Scaling Benchmark Complete.\n');

  // 2. Offered Load Saturation Curve
  console.log('>>> [2/6] Running Offered Load Saturation Curve Benchmark...');
  const saturationResult = await runSaturationBenchmark(
    isQuick
      ? {
          rates: [25, 50],
          durationPerTierSec: 2,
          workerReplicas: 2,
          concurrencyPerWorker: 4,
        }
      : {
          rates: [25, 50, 75, 100, 150, 200],
          durationPerTierSec: 5,
          workerReplicas: 4,
          concurrencyPerWorker: 8,
        }
  );
  console.log('✓ Saturation Curve Benchmark Complete.\n');

  // 3. Multi-Tier Redis Reconstruction
  console.log('>>> [3/6] Running Multi-Tier Redis Reconstruction Benchmark...');
  const multiTierReconResult = await runMultiTierReconciliationBenchmark(
    isQuick
      ? {
          tiers: [10, 50],
          workerCount: 2,
          concurrencyPerWorker: 5,
        }
      : {
          tiers: [100, 1000, 5000, 10000],
          workerCount: 4,
          concurrencyPerWorker: 10,
        }
  );
  console.log('✓ Redis Reconstruction Benchmark Complete.\n');

  // 4. Multi-TTL Crash Recovery Latency
  console.log('>>> [4/6] Running Multi-TTL Crash Recovery Latency Benchmark...');
  const multiTtlChaosResult = await runMultiTtlChaosBenchmark(
    isQuick
      ? {
          ttlsMs: [1000, 2000],
          repetitionsPerTtl: 1,
        }
      : {
          ttlsMs: [2000, 5000, 10000, 30000],
          repetitionsPerTtl: 1,
        }
  );
  console.log('✓ Crash Recovery Benchmark Complete.\n');

  // 5. Zombie Worker Distributed Fencing Proof
  console.log('>>> [5/6] Running Zombie Worker Distributed Fencing Benchmark...');
  const fencingResult = await runFencingBenchmark(
    isQuick
      ? {
          leaseTtlMs: 1500,
        }
      : {
          leaseTtlMs: 2000,
        }
  );
  console.log('✓ Distributed Fencing Benchmark Complete.\n');

  // 6. Transient Failure Retry Overhead
  console.log('>>> [6/6] Running Transient Failure Retry Overhead Benchmark...');
  const retryResult = await runRetryBenchmark(
    isQuick
      ? {
          failureRates: [0, 20],
          workflowsPerTier: 10,
          workerReplicas: 2,
          concurrencyPerWorker: 4,
        }
      : {
          failureRates: [0, 5, 10, 20],
          workflowsPerTier: 50,
          workerReplicas: 4,
          concurrencyPerWorker: 8,
        }
  );
  console.log('✓ Retry Overhead Benchmark Complete.\n');

  const report: BenchmarkReport = {
    id: `${profile}-${Date.now()}`,
    title: 'Durable Workflow Engine Performance & Resilience Benchmark Suite',
    timestamp: new Date().toISOString(),
    profile,
    system: sysinfo,
    throughput: throughputResults,
    saturation: saturationResult,
    reconciliationMultiTier: multiTierReconResult,
    chaosMultiTtl: multiTtlChaosResult,
    fencing: fencingResult,
    retryOverhead: retryResult,
  };

  const { jsonPath, markdownPath } = await saveBenchmarkArtifact(report, outputDir);
  console.log('=====================================================');
  console.log('                   SUMMARY REPORT                    ');
  console.log('=====================================================\n');
  console.log(formatMarkdownReport(report));
  console.log('\nArtifacts Persisted:');
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  Markdown: ${markdownPath}\n`);

  return report;
}

const isMain =
  process.argv[1]?.includes('bench-all') && !process.env.VITEST;

if (isMain) {
  runAllBenchmarks().catch((err) => {
    console.error('Unified benchmark execution failed:', err);
    process.exit(1);
  });
}
