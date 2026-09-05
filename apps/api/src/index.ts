import { PrismaClient } from '@durable/database';
import { createApp } from './app';

const prisma = new PrismaClient();

const app = createApp({ prisma });

app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});
