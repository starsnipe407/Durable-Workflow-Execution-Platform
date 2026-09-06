import fastify, { FastifyInstance } from 'fastify';
import { PrismaClient } from '@durable/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { authenticateApiKey } from './plugins/auth';
import { runsRoutes } from './routes/runs';
import { eventsRoutes } from './routes/events';
import { rateLimitPlugin, RateLimitOptions } from './plugins/rate-limit';
import './types'; // ensure fastify request is augmented

export interface CreateAppOptions {
  prisma: PrismaClient;
  queue?: Queue;
  redis?: Redis;
  rateLimitOptions?: Omit<RateLimitOptions, 'redis'>;
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = fastify({ logger: false });

  if (options.redis) {
    rateLimitPlugin(app, {
      redis: options.redis,
      ...options.rateLimitOptions,
    });
  }

  app.get('/health', async () => ({ status: 'ok' }));

  app.get(
    '/auth/test',
    { preHandler: authenticateApiKey(options.prisma) },
    async (request) => ({ tenantId: request.tenantId })
  );

  runsRoutes(app, options);
  eventsRoutes(app, options);

  return app;
}

