import { WorkflowClientOptions, CreateRunOptions, ListRunsOptions, WorkflowRun, WorkflowClientError } from './types.js';

export class WorkflowClient {
  private baseUrl: string;
  private apiKey: string;
  private customFetch: typeof fetch;

  constructor(options: WorkflowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const reqHeaders: Record<string, string> = {
      'x-api-key': this.apiKey,
      ...headers,
    };
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    const res = await this.customFetch(url, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let errorBody: unknown;
      try {
        errorBody = await res.json();
      } catch {
        errorBody = await res.text();
      }
      throw new WorkflowClientError(res.status, errorBody);
    }
    
    return res;
  }

  async run(options: CreateRunOptions): Promise<WorkflowRun> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    const body = {
      workflowName: options.workflowName,
      workflowVersion: options.workflowVersion,
      input: options.input,
      concurrencyKey: options.concurrencyKey,
      requestIdempotencyKey: options.idempotencyKey,
    };
    const res = await this.request('POST', '/runs', body, headers);
    return res.json() as Promise<WorkflowRun>;
  }

  runs = {
    get: async (runId: string): Promise<WorkflowRun> => {
      const res = await this.request('GET', `/runs/${runId}`);
      return res.json() as Promise<WorkflowRun>;
    },
    list: async (options?: ListRunsOptions): Promise<{ runs: WorkflowRun[] }> => {
      const searchParams = new URLSearchParams();
      if (options) {
        if (options.status) searchParams.set('status', options.status);
        if (options.workflowName) searchParams.set('workflowName', options.workflowName);
        if (options.limit !== undefined) searchParams.set('limit', options.limit.toString());
      }
      const qs = searchParams.toString();
      const path = qs ? `/runs?${qs}` : '/runs';
      const res = await this.request('GET', path);
      return res.json() as Promise<{ runs: WorkflowRun[] }>;
    },
    retry: async (runId: string): Promise<WorkflowRun> => {
      const res = await this.request('POST', `/runs/${runId}/retry`);
      return res.json() as Promise<WorkflowRun>;
    },
    cancel: async (runId: string): Promise<WorkflowRun> => {
      const res = await this.request('POST', `/runs/${runId}/cancel`);
      return res.json() as Promise<WorkflowRun>;
    }
  };
}

export function createWorkflowClient(options: WorkflowClientOptions): WorkflowClient {
  return new WorkflowClient(options);
}
