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
