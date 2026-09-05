import type { PrismaClient } from "@durable/database";
import type { ConnectionOptions, Queue } from "bullmq";
import type { WorkflowRunJobData } from "@durable/worker";

export interface ReconcilerOptions {
  db: PrismaClient;
  queue?: Queue<WorkflowRunJobData>;
  connectionOrUrl?: string | ConnectionOptions;
  queueName?: string;
  pollIntervalMs?: number;
  batchSize?: number;
}

export interface ReconcilerStats {
  pendingRunsReconciled: number;
  dueRetriesReconciled: number;
  expiredLeasesReconciled: number;
  blockedVersionsReconciled: number;
}
