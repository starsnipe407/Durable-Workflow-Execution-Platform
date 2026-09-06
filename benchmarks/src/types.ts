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
  latencyMs: PercentileMetrics;
  rawLatenciesMs: number[];
}

export interface ChaosBenchmarkResult {
  scenario: 'WORKER_SIGKILL_RECOVERY';
  workerPid: number;
  killSignal: 'SIGKILL';
  leaseTtlMs: number;
  recoveryLatencyMs: number;
  workflowRunId: string;
  duplicateStepCalls: number;
  status: 'COMPLETED';
}

export interface ReconciliationBenchmarkResult {
  scenario: 'REDIS_DESTRUCTION_RECONCILER';
  totalRunsSubmitted: number;
  redisFlushCommand: 'FLUSHALL';
  reconstructionDurationMs: number;
  lostRunsCount: number;
  duplicateRunsCount: number;
  completedRunsCount: number;
  status: 'PASSED';
}

export interface BenchmarkReport {
  id: string;
  title: string;
  timestamp: string;
  system: SystemMetadata;
  throughput?: ThroughputScalingTier[];
  chaos?: ChaosBenchmarkResult;
  reconciliation?: ReconciliationBenchmarkResult;
}
