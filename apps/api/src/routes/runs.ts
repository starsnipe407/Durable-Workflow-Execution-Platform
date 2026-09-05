import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@durable/database';
import { Queue } from 'bullmq';
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
    const headerIdempotencyKey = request.headers['idempotency-key'] as string | undefined;
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
        await options.queue.add(
          'run_' + run.id,
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
}
