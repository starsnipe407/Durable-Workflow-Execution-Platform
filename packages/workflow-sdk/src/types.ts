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

export interface StepHandlerContext {
  signal?: AbortSignal;
}

export type StepHandler<T> = (ctx: StepHandlerContext) => Promise<T>;

export interface StepContext {
  run<T>(key: string, handler: StepHandler<T>): Promise<T>;
  run<T>(key: string, options: StepOptions, handler: StepHandler<T>): Promise<T>;
}

export interface WorkflowContext<TInput = unknown> {
  input: TInput;
  step: StepContext;
}

export type WorkflowHandler<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowContext<TInput>
) => Promise<TOutput>;

export interface WorkflowConcurrencyConfig<TInput = unknown> {
  limit?: number; // max concurrent executions globally for this workflow
  key?: (ctx: { input: TInput }) => string | undefined; // partition key function
  keyLimit?: number; // max concurrent executions per partition key (default 1 if key provided)
  ttlSeconds?: number; // lease TTL in seconds (default 30)
}

export interface WorkflowConfig<TInput = unknown> {
  name: string;
  version: string;
  trigger?: { event: string };
  concurrency?: WorkflowConcurrencyConfig<TInput>;
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  config: WorkflowConfig<TInput>;
  handler: WorkflowHandler<TInput, TOutput>;
}
