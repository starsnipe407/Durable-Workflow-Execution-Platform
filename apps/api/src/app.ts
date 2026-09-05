import fastify, { FastifyInstance } from 'fastify';
import { PrismaClient } from '@durable/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { authenticateApiKey } from './plugins/auth';
import './types'; // ensure fastify request is augmented

export function createApp(options: { prisma: PrismaClient; queue?: Queue; redis?: Redis }): FastifyInstance {
  const app = fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get(
    '/auth/test',
    { preHandler: authenticateApiKey(options.prisma) },
    async (request) => ({ tenantId: request.tenantId })
  );

  return app;
}
