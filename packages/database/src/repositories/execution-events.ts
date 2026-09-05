import type { PrismaClient, Prisma } from "@prisma/client";
import type { RecordExecutionEventParams } from "../types.js";

export async function recordExecutionEvent(
  db: PrismaClient | Prisma.TransactionClient,
  params: RecordExecutionEventParams
): Promise<void> {
  const { tenantId, workflowRunId, stepExecutionId, stepAttemptId, eventType, payload = {} } = params;

  await db.executionEvent.create({
    data: {
      tenantId,
      workflowRunId,
      stepExecutionId: stepExecutionId ?? null,
      stepAttemptId: stepAttemptId ?? null,
      eventType,
      payload: payload as Prisma.InputJsonValue
    }
  });
}
