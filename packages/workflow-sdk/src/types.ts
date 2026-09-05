export interface BackoffOptions {
  type?: "exponential";
  initialMs?: number;
  maxMs?: number;
  jitter?: boolean;
}

export interface StepOptions {
  retries?: number;
  backoff?: BackoffOptions;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface StepContext {
  run<T>(key: string, handler: () => Promise<T>): Promise<T>;
  run<T>(key: string, options: StepOptions, handler: () => Promise<T>): Promise<T>;
}

export interface WorkflowContext<TInput = unknown> {
  input: TInput;
  step: StepContext;
}

export type WorkflowHandler<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowContext<TInput>
) => Promise<TOutput>;

export interface WorkflowConfig<TInput = unknown> {
  name: string;
  version: string;
  trigger?: { event: string };
  concurrency?: {
    limit?: number;
    key?: (ctx: { input: TInput }) => string | undefined;
  };
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  config: WorkflowConfig<TInput>;
  handler: WorkflowHandler<TInput, TOutput>;
}
