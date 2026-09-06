export interface WorkflowClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export interface CreateRunOptions {
  workflowName: string;
  workflowVersion?: string;
  input?: unknown;
  concurrencyKey?: string;
  idempotencyKey?: string;
}

export interface ListRunsOptions {
  status?: string;
  workflowName?: string;
  limit?: number;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersion?: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SendEventOptions {
  id: string;
  name: string;
  data?: unknown;
}

export interface SendEventResponse {
  status: 'processed' | 'duplicate';
  eventId: string;
  runs: WorkflowRun[];
}

export class WorkflowClientError extends Error {
  statusCode: number;
  errorBody: unknown;

  constructor(statusCode: number, errorBody: unknown) {
    super(`WorkflowClientError: ${statusCode}`);
    this.name = 'WorkflowClientError';
    this.statusCode = statusCode;
    this.errorBody = errorBody;
  }
}

export interface WorkflowExecutionEvent {
  id: string;
  tenantId: string;
  workflowRunId: string;
  stepExecutionId?: string | null;
  stepAttemptId?: string | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface StreamEventsOptions {
  lastEventId?: string;
  signal?: AbortSignal;
}

