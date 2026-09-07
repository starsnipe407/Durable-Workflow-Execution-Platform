import { PrismaClient } from "@prisma/client";

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public";

export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
      }
    }
  });
}

export { PrismaClient, Prisma, WorkflowRunStatus } from "@prisma/client";
