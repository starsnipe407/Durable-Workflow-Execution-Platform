import fs from 'node:fs';
import path from 'node:path';
import type { BenchmarkReport } from './types.js';

export function formatMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push('');
  lines.push(`- **Benchmark ID**: \`${report.id}\``);
  lines.push(`- **Timestamp**: ${report.timestamp}`);
  lines.push('');

  lines.push('## System Information');
  lines.push('');
  lines.push('| Parameter | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Node.js | ${report.system.nodeVersion} |`);
  lines.push(`| Platform | ${report.system.platform} (${report.system.osRelease}) |`);
  lines.push(`| Architecture | ${report.system.cpuArch} |`);
  lines.push(`| CPU Model | ${report.system.cpuModel} |`);
  lines.push(`| CPU Cores | ${report.system.cpuCores} |`);
  lines.push(`| Total Memory | ${report.system.totalMemoryGb} GB (${report.system.totalMemoryBytes} bytes) |`);
  lines.push(`| Git Commit SHA | \`${report.system.gitCommitSha}\` |`);
  lines.push(`| System Timestamp | ${report.system.timestamp} |`);
  lines.push('');

  if (report.throughput && report.throughput.length > 0) {
    lines.push('## Throughput Scaling');
    lines.push('');
    lines.push('| Replicas | Concurrency | Total Completed | Median Workflows/Sec | P50 (ms) | P95 (ms) | P99 (ms) |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const tier of report.throughput) {
      lines.push(
        `| ${tier.workerReplicas} | ${tier.concurrencyPerWorker} | ${tier.totalWorkflows} | ${tier.medianThroughputPerSec} | ${tier.latencyMs.p50} | ${tier.latencyMs.p95} | ${tier.latencyMs.p99} |`
      );
    }
    lines.push('');
  }

  if (report.chaos) {
    lines.push('## Chaos: Worker Crash & Recovery');
    lines.push('');
    lines.push('| Scenario | Worker PID | Kill Signal | Lease TTL (ms) | Recovery Latency (ms) | Workflow Run ID | Duplicate Step Calls | Status |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    lines.push(
      `| ${report.chaos.scenario} | ${report.chaos.workerPid} | ${report.chaos.killSignal} | ${report.chaos.leaseTtlMs} | ${report.chaos.recoveryLatencyMs} | ${report.chaos.workflowRunId} | ${report.chaos.duplicateStepCalls} | ${report.chaos.status} |`
    );
    lines.push('');
  }

  if (report.reconciliation) {
    lines.push('## Redis Destruction & Reconciliation');
    lines.push('');
    lines.push('| Scenario | Runs Submitted | Redis Command | Reconstruction Duration (ms) | Lost Runs | Duplicate Runs | Completed Runs | Status |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    lines.push(
      `| ${report.reconciliation.scenario} | ${report.reconciliation.totalRunsSubmitted} | ${report.reconciliation.redisFlushCommand} | ${report.reconciliation.reconstructionDurationMs} | ${report.reconciliation.lostRunsCount} | ${report.reconciliation.duplicateRunsCount} | ${report.reconciliation.completedRunsCount} | ${report.reconciliation.status} |`
    );
    lines.push('');
  }

  if (report.fencing) {
    lines.push('## Zombie Worker Fencing');
    lines.push('');
    lines.push('| Scenario | Run ID | Worker A PID | Worker B PID | Lease TTL (ms) | Fencing Enforced | Worker B Status | Status |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    lines.push(
      `| ${report.fencing.scenario} | ${report.fencing.workflowRunId} | ${report.fencing.workerAPid} | ${report.fencing.workerBPid} | ${report.fencing.leaseTtlMs} | ${report.fencing.fencingEnforced} | ${report.fencing.workerBStatus} | ${report.fencing.status} |`
    );
    lines.push('');
  }

  if (report.retryOverhead && report.retryOverhead.tiers.length > 0) {
    lines.push('## Transient Failure Retry Overhead');
    lines.push('');
    lines.push('| Failure Rate | Workflows | Duration (ms) | Workflows/Sec | P50 (ms) | P95 (ms) | Mean Attempts/Workflow |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const tier of report.retryOverhead.tiers) {
      lines.push(
        `| ${tier.failureRatePercent}% | ${tier.totalWorkflows} | ${tier.durationMs} | ${tier.throughputPerSec} | ${tier.latencyMs.p50} | ${tier.latencyMs.p95} | ${tier.meanAttemptsPerWorkflow} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function saveBenchmarkArtifact(
  report: BenchmarkReport,
  outputDir?: string
): Promise<{ jsonPath: string; markdownPath: string }> {
  let dir: string;
  if (outputDir) {
    dir = path.resolve(outputDir);
  } else {
    const cwd = process.cwd();
    if (path.basename(cwd) === 'benchmarks') {
      dir = path.resolve(cwd, 'results');
    } else {
      dir = path.resolve(cwd, 'benchmarks', 'results');
    }
  }

  await fs.promises.mkdir(dir, { recursive: true });

  const jsonPath = path.join(dir, `benchmark-${report.id}.json`);
  const markdownPath = path.join(dir, `benchmark-${report.id}.md`);

  const jsonContent = JSON.stringify(report, null, 2);
  const markdownContent = formatMarkdownReport(report);

  await fs.promises.writeFile(jsonPath, jsonContent, 'utf8');
  await fs.promises.writeFile(markdownPath, markdownContent, 'utf8');

  return { jsonPath, markdownPath };
}
