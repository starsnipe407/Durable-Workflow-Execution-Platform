import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@durable/database';
import { Redis } from 'ioredis';
import { authenticateApiKey } from '../plugins/auth';

export interface MetricsRoutesOptions {
  prisma: PrismaClient;
  redis?: Redis;
}

export function metricsRoutes(app: FastifyInstance, options: MetricsRoutesOptions) {
  app.get('/metrics', { preHandler: authenticateApiKey(options.prisma) }, async (request, reply) => {
    let systemStatus: 'healthy' | 'degraded' = 'healthy';

    try {
      await options.prisma.$queryRaw`SELECT 1`;
    } catch {
      systemStatus = 'degraded';
    }

    if (options.redis) {
      try {
        await options.redis.ping();
      } catch {
        systemStatus = 'degraded';
      }
    }

    let activeRuns = 0;
    let completedRuns = 0;
    let failedRuns = 0;
    let cancelledRuns = 0;
    let totalRuns = 0;

    try {
      const statusCounts = await options.prisma.workflowRun.groupBy({
        by: ['status'],
        where: { tenantId: request.tenantId },
        _count: { _all: true },
      });

      for (const sc of statusCounts) {
        const count = sc._count._all;
        totalRuns += count;
        if (sc.status === 'PENDING' || sc.status === 'RUNNING' || sc.status === 'CANCEL_REQUESTED') {
          activeRuns += count;
        } else if (sc.status === 'COMPLETED') {
          completedRuns += count;
        } else if (sc.status === 'FAILED') {
          failedRuns += count;
        } else if (sc.status === 'CANCELLED') {
          cancelledRuns += count;
        }
      }
    } catch {
      systemStatus = 'degraded';
    }

    return reply.status(200).send({
      activeRuns,
      completedRuns,
      failedRuns,
      cancelledRuns,
      totalRuns,
      systemStatus,
    });
  });
}
