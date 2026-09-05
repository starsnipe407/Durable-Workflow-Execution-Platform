export interface WorkflowRunJobData {
  tenantId: string;
  runId: string;
  workflowName: string;
  workflowVersion: string;
}

export interface EnqueueWorkflowOptions {
  delay?: number;
  jobId?: string;
}
