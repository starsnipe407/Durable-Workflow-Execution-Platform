import type { PrismaClient, Prisma, WorkflowRun } from "@prisma/client";
import { recordExecutionEvent } from "./execution-events.js";
import type { CreateWorkflowRunParams } from "../types.js";

export async function createWorkflowRun(
  db: PrismaClient,
  params: CreateWorkflowRunParams
): Promise<WorkflowRun> {
  return await db.$transaction(async (tx) => {
    const run = await tx.workflowRun.create({
      data: {
        tenantId: params.tenantId,
        workflowName: params.workflowName,
        workflowVersion: params.workflowVersion,
        input: params.input as Prisma.InputJsonValue,
        requestIdempotencyKey: params.requestIdempotencyKey ?? null,
        status: "PENDING"
      }
    });

    await recordExecutionEvent(tx, {
      tenantId: params.tenantId,
      workflowRunId: run.id,
      eventType: "WORKFLOW_CREATED",
      payload: { workflowName: params.workflowName, workflowVersion: params.workflowVersion }
    });

    return run;
  });
}
