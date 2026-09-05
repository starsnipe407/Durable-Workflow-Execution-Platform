import { PrismaClient } from "@prisma/client";

export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: url ?? process.env.DATABASE_URL
      }
    }
  });
}

export { PrismaClient, WorkflowRunStatus } from "@prisma/client";
