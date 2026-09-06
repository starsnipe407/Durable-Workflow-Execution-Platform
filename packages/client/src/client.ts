import {
  WorkflowClientOptions,
  CreateRunOptions,
  ListRunsOptions,
  WorkflowRun,
  WorkflowClientError,
  SendEventOptions,
  SendEventResponse,
  WorkflowExecutionEvent,
  StreamEventsOptions,
} from './types.js';

export class WorkflowClient {
  private baseUrl: string;
  private apiKey: string;
  private customFetch: typeof fetch;
  public readonly runs: {
    get: (runId: string) => Promise<WorkflowRun>;
    list: (options?: ListRunsOptions) => Promise<{ runs: WorkflowRun[] }>;
    retry: (runId: string) => Promise<WorkflowRun>;
    cancel: (runId: string) => Promise<WorkflowRun>;
    streamEvents: (runId: string, options?: StreamEventsOptions) => AsyncIterable<WorkflowExecutionEvent>;
  };

  constructor(options: WorkflowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

    const self = this;
    this.runs = {
      get: async (runId: string): Promise<WorkflowRun> => {
        const res = await self.request('GET', `/runs/${runId}`);
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
        const res = await self.request('GET', path);
        return res.json() as Promise<{ runs: WorkflowRun[] }>;
      },
      retry: async (runId: string): Promise<WorkflowRun> => {
        const res = await self.request('POST', `/runs/${runId}/retry`);
        return res.json() as Promise<WorkflowRun>;
      },
      cancel: async (runId: string): Promise<WorkflowRun> => {
        const res = await self.request('POST', `/runs/${runId}/cancel`);
        return res.json() as Promise<WorkflowRun>;
      },
      streamEvents: async function* (
        runId: string,
        options?: StreamEventsOptions
      ): AsyncIterable<WorkflowExecutionEvent> {
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
        };
        if (options?.lastEventId) {
          headers['Last-Event-ID'] = options.lastEventId;
        }
        const qs = options?.lastEventId ? `?lastEventId=${encodeURIComponent(options.lastEventId)}` : '';
        const url = `${self.baseUrl}/runs/${runId}/events${qs}`;
        const res = await self.customFetch(url, {
          method: 'GET',
          headers: {
            'x-api-key': self.apiKey,
            ...headers,
          },
          signal: options?.signal,
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

        if (!res.body) {
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent: { id?: string; event?: string; data?: string } = {};

        const processLine = function* (line: string): Generator<WorkflowExecutionEvent> {
          const trimmed = line.trim();
          if (trimmed === '') {
            if (currentEvent.data !== undefined) {
              try {
                const parsed = JSON.parse(currentEvent.data) as WorkflowExecutionEvent;
                if (!parsed.id && currentEvent.id) parsed.id = currentEvent.id;
                if (!parsed.eventType && currentEvent.event) parsed.eventType = currentEvent.event;
                yield parsed;
              } catch {}
            }
            currentEvent = {};
          } else if (line.startsWith('id:')) {
            currentEvent.id = line.slice(3).trim();
          } else if (line.startsWith('event:')) {
            currentEvent.event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const dataVal = line.slice(5).trim();
            currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${dataVal}` : dataVal;
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              for (const ev of processLine(line)) {
                yield ev;
              }
            }
          }

          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              for (const ev of processLine(line)) {
                yield ev;
              }
            }
          }
          if (currentEvent.data !== undefined) {
            try {
              const parsed = JSON.parse(currentEvent.data) as WorkflowExecutionEvent;
              if (!parsed.id && currentEvent.id) parsed.id = currentEvent.id;
              if (!parsed.eventType && currentEvent.event) parsed.eventType = currentEvent.event;
              yield parsed;
            } catch {}
            currentEvent = {};
          }
        } finally {
          try {
            await reader.cancel();
          } catch {}
          reader.releaseLock();
        }
      },
    };
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

  async sendEvent(options: SendEventOptions): Promise<SendEventResponse> {
    const eventId = options.id ?? options.eventId;
    const data = options.data !== undefined ? options.data : (options.payload !== undefined ? options.payload : {});
    const body = {
      id: eventId,
      name: options.name,
      data,
    };
    const res = await this.request('POST', '/events', body);
    return res.json() as Promise<SendEventResponse>;
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

  async startWorkflow(
    workflowName: string,
    input?: unknown,
    options?: Omit<CreateRunOptions, 'workflowName' | 'input'>
  ): Promise<WorkflowRun> {
    return this.run({
      workflowName,
      input,
      ...options,
    });
  }
}

export function createWorkflowClient(options: WorkflowClientOptions): WorkflowClient {
  return new WorkflowClient(options);
}
