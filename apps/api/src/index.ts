export * from './app.js';
export * from './plugins/auth.js';
export * from './routes/runs.js';
export * from './routes/events.js';
export * from './types.js';

export async function startServer(port = Number(process.env.PORT) || 3000, host = '0.0.0.0') {
  const { PrismaClient } = await import('@durable/database');
  const { Redis } = await import('ioredis');
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6380');
  const { createApp } = await import('./app.js');
  const app = createApp({ prisma, redis });
  const address = await app.listen({ port, host });
  console.log(`Server listening at ${address}`);
  return app;
}
