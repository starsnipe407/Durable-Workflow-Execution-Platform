import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient, WorkflowRunStatus } from '@durable/database';
import { Queue } from 'bullmq';
import { enqueueWorkflowRun } from '@durable/worker';
import { authenticateApiKey } from '../plugins/auth';

const createRunSchema = z.object({
  workflowName: z.string().min(1),
  workflowVersion: z.string().optional().default("1.0.0"),
  input: z.unknown().optional().default({}),
  concurrencyKey: z.string().optional(),
  requestIdempotencyKey: z.string().optional(),
});

export function runsRoutes(
  app: FastifyInstance,
  options: { prisma: PrismaClient; queue?: Queue }
) {
  app.post('/runs', { preHandler: authenticateApiKey(options.prisma) }, async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid request body',
        details: parsed.error.format(),
      });
    }

    const data = parsed.data;
    const rawHeaderKey = request.headers['idempotency-key'];
    const headerIdempotencyKey = Array.isArray(rawHeaderKey) ? rawHeaderKey[0] : (rawHeaderKey as string | undefined);
    const idempotencyKey = data.requestIdempotencyKey || headerIdempotencyKey;

    if (idempotencyKey) {
      const existing = await options.prisma.workflowRun.findUnique({
        where: {
          tenantId_requestIdempotencyKey: {
            tenantId: request.tenantId,
            requestIdempotencyKey: idempotencyKey,
          },
        },
      });

      if (existing) {
        return reply.status(200).send(existing);
      }
    }

    try {
      const run = await options.prisma.$transaction(async (tx) => {
        const newRun = await tx.workflowRun.create({
          data: {
            tenantId: request.tenantId,
            workflowName: data.workflowName,
            workflowVersion: data.workflowVersion,
            input: data.input as any,
            concurrencyKey: data.concurrencyKey,
            requestIdempotencyKey: idempotencyKey,
            status: 'PENDING',
            workflowAttempt: 1,
            triggerType: 'DIRECT',
          },
        });

        await tx.executionEvent.create({
          data: {
            tenantId: request.tenantId,
            workflowRunId: newRun.id,
            eventType: 'WORKFLOW_CREATED',
            payload: {
              workflowName: newRun.workflowName,
              workflowVersion: newRun.workflowVersion,
              input: newRun.input,
            },
          },
        });

        return newRun;
      });

      if (options.queue) {
        await enqueueWorkflowRun(
          options.queue,
          {
            runId: run.id,
            workflowName: run.workflowName,
            workflowVersion: run.workflowVersion,
            tenantId: run.tenantId,
          },
          { jobId: 'run_' + run.id }
        );
      }

      return reply.status(201).send(run);
    } catch (error: any) {
      // Handle concurrent race for idempotency key
      if (
        error.code === 'P2002'
      ) {
        const concurrentlyCreated = await options.prisma.workflowRun.findUnique({
          where: {
            tenantId_requestIdempotencyKey: {
              tenantId: request.tenantId,
              requestIdempotencyKey: idempotencyKey as string,
            },
          },
        });
        
        if (concurrentlyCreated) {
          return reply.status(200).send(concurrentlyCreated);
        }
      }
      
      throw error;
    }
  });

  app.get('/runs/:id', { preHandler: authenticateApiKey(options.prisma) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await options.prisma.workflowRun.findUnique({
      where: {
        id,
        tenantId: request.tenantId,
      },
      include: {
        stepExecutions: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Not Found', message: 'Workflow run not found' });
    }

    return reply.status(200).send(run);
  });

  app.get('/runs', { preHandler: authenticateApiKey(options.prisma) }, async (request, reply) => {
    const query = request.query as { status?: string; workflowName?: string; limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 20;
    
    const runs = await options.prisma.workflowRun.findMany({
      where: {
        tenantId: request.tenantId,
        ...(query.status ? { status: query.status as WorkflowRunStatus } : {}),
        ...(query.workflowName ? { workflowName: query.workflowName } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });

    return reply.status(200).send({ runs });
  });

  app.post('/runs/:id/retry', { preHandler: authenticateApiKey(options.prisma) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const run = await options.prisma.workflowRun.findUnique({
      where: {
        id,
        tenantId: request.tenantId,
      },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Not Found', message: 'Workflow run not found' });
    }

    if (run.status !== 'FAILED') {
      return reply.status(400).send({ error: 'Bad Request', message: `Cannot retry run in status ${run.status}` });
    }

    const updatedRun = await options.prisma.$transaction(async (tx) => {
      const nextAttempt = run.workflowAttempt + 1;
      
      const updated = await tx.workflowRun.update({
        where: { id },
        data: {
          status: 'PENDING',
          failedAt: null,
          error: null as any,
          workflowAttempt: { increment: 1 },
        },
      });

      await tx.executionEvent.create({
        data: {
          tenantId: request.tenantId,
          workflowRunId: run.id,
          eventType: 'WORKFLOW_RETRY_REQUESTED',
          payload: {
            previousAttempt: run.workflowAttempt,
            newAttempt: nextAttempt,
          },
        },
      });

      return updated;
    });

    if (options.queue) {
      await enqueueWorkflowRun(
        options.queue,
        {
          runId: updatedRun.id,
          workflowName: updatedRun.workflowName,
          workflowVersion: updatedRun.workflowVersion,
          tenantId: updatedRun.tenantId,
        },
        { jobId: 'replay_' + updatedRun.id + '_attempt_' + updatedRun.workflowAttempt }
      );
    }

    return reply.status(200).send(updatedRun);
  });

  app.post('/runs/:id/cancel', { preHandler: authenticateApiKey(options.prisma) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const run = await options.prisma.workflowRun.findUnique({
      where: {
        id,
        tenantId: request.tenantId,
      },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Not Found', message: 'Workflow run not found' });
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      return reply.status(400).send({ error: 'Bad Request', message: `Cannot cancel run in status ${run.status}` });
    }

    const updatedRun = await options.prisma.$transaction(async (tx) => {
      const targetStatus: WorkflowRunStatus = run.status === 'PENDING' ? 'CANCELLED' : 'CANCEL_REQUESTED';
      
      const dataToUpdate: Record<string, unknown> = { status: targetStatus };
      if (targetStatus === 'CANCELLED') {
        dataToUpdate.cancelledAt = new Date();
      } else {
        dataToUpdate.cancelRequestedAt = new Date();
      }

      const updated = await tx.workflowRun.update({
        where: { id },
        data: dataToUpdate,
      });

      await tx.executionEvent.create({
        data: {
          tenantId: request.tenantId,
          workflowRunId: run.id,
          eventType: targetStatus === 'CANCELLED' ? 'WORKFLOW_CANCELLED' : 'WORKFLOW_CANCEL_REQUESTED',
          payload: { originalStatus: run.status },
        },
      });

      return updated;
    });

    return reply.status(200).send(updatedRun);
  });
}
