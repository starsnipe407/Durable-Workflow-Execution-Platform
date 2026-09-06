import { collectSystemMetadata } from './sysinfo.js';
import { runThroughputBenchmark } from './bench-throughput.js';
import { runChaosBenchmark } from './bench-chaos.js';
import { runReconciliationBenchmark } from './bench-reconciliation.js';
import { formatMarkdownReport, saveBenchmarkArtifact } from './reporter.js';
import type { BenchmarkReport } from './types.js';

export async function runAllBenchmarks(): Promise<BenchmarkReport> {
  const sysinfo = await collectSystemMetadata();
  console.log('=====================================================');
  console.log('  DURABLE WORKFLOW EXEC - COMPREHENSIVE BENCHMARKS   ');
  console.log('=====================================================');
  console.log(`CPU: ${sysinfo.cpuModel} (${sysinfo.cpuCores} cores)`);
  console.log(`OS:  ${sysinfo.platform} ${sysinfo.osRelease} | Node: ${sysinfo.nodeVersion}`);
  console.log(`RAM: ${sysinfo.totalMemoryGb} GB`);
  console.log('-----------------------------------------------------\n');

  console.log('>>> [1/3] Running Horizontal Throughput Benchmark...');
  const throughputResults = await runThroughputBenchmark({
    tiers: [1, 2, 4],
    concurrencyPerWorker: 5,
    warmupRuns: 5,
    measuredRepetitions: 2,
    runsPerRepetition: 25,
  });
  console.log('✓ Throughput Benchmark Complete.\n');

  console.log('>>> [2/3] Running Real SIGKILL Chaos Recovery Benchmark...');
  const chaosResult = await runChaosBenchmark({
    leaseTtlMs: 2000,
  });
  console.log('✓ Chaos Recovery Benchmark Complete.\n');

  console.log('>>> [3/3] Running Real Redis FLUSHALL Reconciliation Benchmark...');
  const reconciliationResult = await runReconciliationBenchmark({
    totalRuns: 25,
    workerCount: 2,
  });
  console.log('✓ Reconciliation Benchmark Complete.\n');

  const report: BenchmarkReport = {
    id: `unified-${Date.now()}`,
    title: 'Durable Workflow Engine Performance & Resilience Benchmark Suite',
    timestamp: new Date().toISOString(),
    system: sysinfo,
    throughput: throughputResults,
    chaos: chaosResult,
    reconciliation: reconciliationResult,
  };

  const { jsonPath, markdownPath } = await saveBenchmarkArtifact(report);
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
