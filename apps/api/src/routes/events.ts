import { FastifyInstance } from 'fastify';
import { PrismaClient, Prisma } from '@durable/database';
import { Queue } from 'bullmq';
import { enqueueWorkflowRun } from '@durable/worker';
import { z } from 'zod';
import { authenticateApiKey } from '../plugins/auth';

const ingestEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  data: z.unknown().optional().default({}),
});

export function eventsRoutes(
  app: FastifyInstance,
  options: { prisma: PrismaClient; queue?: Queue }
) {
  app.post(
    '/events',
    { preHandler: authenticateApiKey(options.prisma) },
    async (request, reply) => {
      const parsed = ingestEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid request body',
          details: parsed.error.format(),
        });
      }

      const data = parsed.data;
      const tenantId = request.tenantId!;

      // 1. Check if event exists
      const existing = await options.prisma.ingestedEvent.findUnique({
        where: { tenantId_eventId: { tenantId, eventId: data.id } },
      });
      if (existing) {
        return reply.status(200).send({ status: 'duplicate', eventId: existing.eventId, runs: [] });
      }

      try {
        const createdRuns = await options.prisma.$transaction(async (tx) => {
          // 2. Insert event
          const event = await tx.ingestedEvent.create({
            data: {
              tenantId,
              eventId: data.id,
              eventName: data.name,
              payload: data.data as any,
              receivedAt: new Date(),
              processedAt: new Date(),
            },
          });

          // 3. Find bindings
          const bindings = await tx.workflowEventBinding.findMany({
            where: { tenantId, eventName: data.name },
          });

          const runs = [];
          for (const binding of bindings) {
            const run = await tx.workflowRun.create({
              data: {
                tenantId,
                workflowName: binding.workflowName,
                workflowVersion: binding.workflowVersion,
                input: data.data as any,
                triggerType: 'EVENT',
                triggerEventId: event.id,
                requestIdempotencyKey: `event_${event.eventId}_binding_${binding.id}`,
                status: 'PENDING',
                workflowAttempt: 1,
              },
            });

            await tx.executionEvent.create({
              data: {
                tenantId,
                workflowRunId: run.id,
                eventType: 'WORKFLOW_CREATED',
                payload: {
                  workflowName: run.workflowName,
                  workflowVersion: run.workflowVersion,
                  triggerType: 'EVENT',
                  eventId: event.eventId,
                  eventName: event.eventName,
                  input: run.input,
                },
              },
            });

            runs.push(run);
          }

          return runs;
        });

        // 4. Enqueue runs concurrently
        if (options.queue) {
          await Promise.all(
            createdRuns.map((run) =>
              enqueueWorkflowRun(
                options.queue!,
                {
                  runId: run.id,
                  workflowName: run.workflowName,
                  workflowVersion: run.workflowVersion,
                  tenantId: run.tenantId,
                },
                { jobId: `run_${run.id}` }
              )
            )
          );
        }

        return reply.status(201).send({ status: 'processed', eventId: data.id, runs: createdRuns });
      } catch (err: any) {
        // Handle concurrent insert P2002
        if (err?.code === 'P2002' || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          return reply.status(200).send({ status: 'duplicate', eventId: data.id, runs: [] });
        }
        throw err;
      }
    }
  );
}
