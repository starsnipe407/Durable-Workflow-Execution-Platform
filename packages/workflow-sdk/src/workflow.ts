import type { WorkflowConfig, WorkflowDefinition, WorkflowHandler } from "./types.js";

export function defineWorkflow<TInput = unknown, TOutput = unknown>(
  config: WorkflowConfig<TInput>,
  handler: WorkflowHandler<TInput, TOutput>
): WorkflowDefinition<TInput, TOutput> {
  return { config, handler };
}
