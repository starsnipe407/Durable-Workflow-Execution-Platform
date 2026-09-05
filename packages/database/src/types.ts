export interface RecordExecutionEventParams {
  tenantId: string;
  workflowRunId: string;
  stepExecutionId?: string | null;
  stepAttemptId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface ClaimStepAttemptParams {
  tenantId: string;
  workflowRunId: string;
  stepKey: string;
  workerId: string;
  leaseDurationMs: number;
}

export type ClaimStepAttemptResult =
  | { status: "COMPLETED"; output: unknown }
  | { status: "RUNNING"; attemptId: string; attemptNumber: number; stepExecutionId: string }
  | { status: "LOCKED"; activeAttemptId: string; leaseExpiresAt: Date };

export interface CompleteStepAttemptParams {
  tenantId: string;
  workflowRunId: string;
  stepExecutionId: string;
  attemptId: string;
  output: unknown;
}

export interface CreateWorkflowRunParams {
  tenantId: string;
  workflowName: string;
  workflowVersion: string;
  input: unknown;
  requestIdempotencyKey?: string;
}

export interface RenewAttemptLeaseParams {
  attemptId: string;
  additionalMs: number;
}
