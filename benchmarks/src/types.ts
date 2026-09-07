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
  stepsPerSec?: number;
  workflowLatencyMs?: PercentileMetrics;
  queueLatencyMs?: PercentileMetrics;
  latencyMs: PercentileMetrics;
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
  timeToAbandonedMs?: number;
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
  profile?: 'quick' | 'full';
  system: SystemMetadata;
  throughput?: ThroughputScalingTier[];
  chaos?: ChaosBenchmarkResult;
  reconciliation?: ReconciliationBenchmarkResult;
  saturation?: SaturationBenchmarkResult;
  chaosMultiTtl?: MultiTtlChaosResult;
  reconciliationMultiTier?: MultiTierReconciliationResult;
  fencing?: FencingBenchmarkResult;
  retryOverhead?: RetryBenchmarkResult;
}
