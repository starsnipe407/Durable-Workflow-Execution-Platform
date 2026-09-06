import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaClient, WorkflowRunStatus } from '@durable/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { enqueueWorkflowRun } from '@durable/worker';
import { publishRunEventWakeup } from '@durable/shared';
import { authenticateApiKey } from '../plugins/auth';
import { RunEventsMultiplexer } from '../services/run-events-multiplexer';

const createRunSchema = z.object({
  workflowName: z.string().min(1),
  workflowVersion: z.string().optional().default("1.0.0"),
  input: z.unknown().optional().default({}),
  concurrencyKey: z.string().optional(),
  requestIdempotencyKey: z.string().optional(),
});

export function runsRoutes(
  app: FastifyInstance,
  options: {
    prisma: PrismaClient;
    queue?: Queue;
    redis?: Redis;
    multiplexer?: RunEventsMultiplexer;
    sseKeepaliveIntervalMs?: number;
  }
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

      if (options.redis) {
        await publishRunEventWakeup(options.redis, run.id);
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

    if (options.redis) {
      await publishRunEventWakeup(options.redis, updatedRun.id);
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

    if (options.redis) {
      await publishRunEventWakeup(options.redis, updatedRun.id);
    }

    return reply.status(200).send(updatedRun);
  });

  const handleEventsStream = async (request: FastifyRequest, reply: FastifyReply) => {
    const runId = (request.params as any).runId || (request.params as any).id;
    const run = await options.prisma.workflowRun.findUnique({
      where: {
        id: runId,
        tenantId: request.tenantId,
      },
      select: { id: true, status: true },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Not Found', message: 'Workflow run not found' });
    }

    // Read Last-Event-ID header or ?lastEventId query param
    const rawLastEventId = request.headers['last-event-id'] || (request.query as any)?.lastEventId;
    let lastSentId: bigint | undefined;
    if (rawLastEventId && typeof rawLastEventId === 'string' && /^\d+$/.test(rawLastEventId.trim())) {
      lastSentId = BigInt(rawLastEventId.trim());
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    const envInterval = process.env.SSE_KEEPALIVE_INTERVAL_MS
      ? parseInt(process.env.SSE_KEEPALIVE_INTERVAL_MS, 10)
      : undefined;
    const keepaliveMs = options.sseKeepaliveIntervalMs ?? envInterval ?? 15_000;
    const keepaliveTimer = setInterval(() => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(': keepalive\n\n');
      }
    }, keepaliveMs);

    let isFetching = false;
    let hasPendingWakeup = false;
    let closed = false;
    let unsubscribe: (() => Promise<void>) | undefined;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      clearInterval(keepaliveTimer);
      if (unsubscribe) {
        await unsubscribe().catch(() => {});
        unsubscribe = undefined;
      }
    };

    request.raw.on('close', () => {
      cleanup().catch(() => {});
    });

    const fetchAndFlush = async () => {
      if (closed || reply.raw.writableEnded) return;
      if (isFetching) {
        hasPendingWakeup = true;
        return;
      }
      isFetching = true;

      try {
        do {
          hasPendingWakeup = false;
          const events = await options.prisma.executionEvent.findMany({
            where: {
              workflowRunId: runId,
              ...(lastSentId !== undefined ? { id: { gt: lastSentId } } : {}),
            },
            orderBy: { id: 'asc' },
          });

          for (const event of events) {
            if (closed || reply.raw.writableEnded) return;
            lastSentId = event.id;
            const payload = JSON.stringify({
              id: event.id.toString(),
              tenantId: event.tenantId,
              workflowRunId: event.workflowRunId,
              stepExecutionId: event.stepExecutionId,
              stepAttemptId: event.stepAttemptId,
              eventType: event.eventType,
              payload: event.payload,
              createdAt: event.createdAt.toISOString(),
            });
            reply.raw.write(`id: ${event.id.toString()}\nevent: ${event.eventType}\ndata: ${payload}\n\n`);

            if (
              event.eventType === 'WORKFLOW_COMPLETED' ||
              event.eventType === 'WORKFLOW_FAILED' ||
              event.eventType === 'WORKFLOW_CANCELLED'
            ) {
              await cleanup();
              if (!reply.raw.writableEnded) {
                reply.raw.end();
              }
              return;
            }
          }

          // Check if workflow run became terminal even if terminal event wasn't in this batch
          const currentRun = await options.prisma.workflowRun.findUnique({
            where: { id: runId },
            select: { status: true },
          });
          if (
            currentRun &&
            ['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentRun.status)
          ) {
            const remaining = await options.prisma.executionEvent.count({
              where: {
                workflowRunId: runId,
                ...(lastSentId !== undefined ? { id: { gt: lastSentId } } : {}),
              },
            });
            if (remaining === 0) {
              await cleanup();
              if (!reply.raw.writableEnded) {
                reply.raw.end();
              }
              return;
            }
          }
        } while (hasPendingWakeup && !closed && !reply.raw.writableEnded);
      } catch (err) {
        await cleanup();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      } finally {
        isFetching = false;
      }
    };

    if (options.multiplexer) {
      try {
        const unsub = await options.multiplexer.subscribe(runId, () => {
          fetchAndFlush().catch(() => {});
        });
        if (closed) {
          await unsub().catch(() => {});
        } else {
          unsubscribe = unsub;
        }
      } catch {
        // subscription error handling
      }
    }

    await fetchAndFlush();

    if (reply.raw.writableEnded || closed) {
      return;
    }

    return new Promise<void>((resolve) => {
      reply.raw.once('finish', resolve);
      request.raw.once('close', resolve);
    });
  };

  app.get('/runs/:runId/events', { preHandler: authenticateApiKey(options.prisma) }, handleEventsStream);
}
