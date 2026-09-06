export type WorkflowRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED';

export type StepExecutionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'RETRY_WAIT'
  | 'FAILED';

export type StepAttemptStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABANDONED'
  | 'TIMED_OUT';

export interface StepAttempt {
  id: string;
  stepExecutionId: string;
  attemptNumber: number;
  status: StepAttemptStatus;
  workerId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  errorMetadata?: unknown;
  retryDelayMs?: number | null;
}

export interface StepExecution {
  id: string;
  stepKey: string;
  status: StepExecutionStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  retryLimit: number;
  attemptCount: number;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  nextRetryAt?: string | null;
  stepAttempts?: StepAttempt[];
}

export interface WorkflowRun {
  id: string;
  tenantId: string;
  workflowName: string;
  workflowVersion: string;
  status: WorkflowRunStatus;
  input: unknown;
  output?: unknown;
  error?: unknown;
  workflowAttempt: number;
  triggerType: 'DIRECT' | 'EVENT';
  triggerEventId?: string | null;
  concurrencyKey?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  cancelledAt?: string | null;
  createdAt: string;
  updatedAt: string;
  stepExecutions?: StepExecution[];
}

export interface MetricsResponse {
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  totalRuns: number;
  systemStatus: 'healthy' | 'degraded';
}

export interface WorkflowDefinitionItem {
  name: string;
  versions: string[];
  triggers: Array<{ eventName: string; workflowVersion: string }>;
  concurrency?: { globalLimit?: number; perKey: boolean };
  totalRuns: number;
  lastRunAt?: string | null;
}

export type WorkflowDefinition = WorkflowDefinitionItem;

export interface WorkflowsResponse {
  workflows: WorkflowDefinitionItem[];
}

export interface WorkflowExecutionEvent {
  id: string;
  tenantId: string;
  workflowRunId: string;
  stepExecutionId?: string | null;
  stepAttemptId?: string | null;
  eventType: string;
  payload: any;
  createdAt: string;
}
