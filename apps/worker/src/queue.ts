import { Queue, type ConnectionOptions, type Job } from "bullmq";
import type { WorkflowRunJobData, EnqueueWorkflowOptions } from "./types.js";

export const WORKFLOW_QUEUE_NAME = "workflow-runs";
export const WORKFLOW_JOB_NAME = "workflow-replay";

export function createWorkflowQueue(
  connectionOrUrl?: string | ConnectionOptions
): Queue<WorkflowRunJobData> {
  const resolved = connectionOrUrl ?? (process.env.REDIS_URL || "redis://localhost:6380");
  const connection: ConnectionOptions =
    typeof resolved === "string" ? { url: resolved } : resolved;

  return new Queue<WorkflowRunJobData>(WORKFLOW_QUEUE_NAME, {
    connection,
  });
}

export async function enqueueWorkflowRun(
  queue: Queue<WorkflowRunJobData>,
  data: WorkflowRunJobData,
  options?: EnqueueWorkflowOptions
): Promise<Job<WorkflowRunJobData>> {
  return await queue.add(WORKFLOW_JOB_NAME, data, {
    delay: options?.delay,
    jobId: options?.jobId,
  });
}
