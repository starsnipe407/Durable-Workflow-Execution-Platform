import fastify, { FastifyInstance } from 'fastify';
import { PrismaClient } from '@durable/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { authenticateApiKey } from './plugins/auth';
import { runsRoutes } from './routes/runs';
import { eventsRoutes } from './routes/events';
import { rateLimitPlugin, RateLimitOptions } from './plugins/rate-limit';
import { RunEventsMultiplexer } from './services/run-events-multiplexer';
import './types'; // ensure fastify request is augmented

export interface CreateAppOptions {
  prisma: PrismaClient;
  queue?: Queue;
  redis?: Redis;
  multiplexer?: RunEventsMultiplexer;
  rateLimitOptions?: Omit<RateLimitOptions, 'redis'>;
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = fastify({ logger: false });

  let multiplexer = options.multiplexer;
  let ownsMultiplexer = false;
  if (!multiplexer && options.redis) {
    multiplexer = new RunEventsMultiplexer(options.redis);
    ownsMultiplexer = true;
  }

  if (ownsMultiplexer && multiplexer) {
    app.addHook('onClose', async () => {
      await multiplexer!.close();
    });
  }

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

  runsRoutes(app, { ...options, multiplexer });
  eventsRoutes(app, options);

  return app;
}

