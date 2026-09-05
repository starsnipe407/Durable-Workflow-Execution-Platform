export * from './app.js';
export * from './plugins/auth.js';
export * from './routes/runs.js';
export * from './types.js';

export async function startServer(port = Number(process.env.PORT) || 3000, host = '0.0.0.0') {
  const { PrismaClient } = await import('@durable/database');
  const prisma = new PrismaClient();
  const { createApp } = await import('./app.js');
  const app = createApp({ prisma });
  const address = await app.listen({ port, host });
  console.log(`Server listening at ${address}`);
  return app;
}
