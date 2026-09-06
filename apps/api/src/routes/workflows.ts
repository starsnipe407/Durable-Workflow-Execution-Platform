import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@durable/database';
import { authenticateApiKey } from '../plugins/auth';

export interface WorkflowsRoutesOptions {
  prisma: PrismaClient;
}

interface WorkflowAggregate {
  name: string;
  versions: Set<string>;
  triggers: Array<{ eventName: string; workflowVersion: string }>;
  totalRuns: number;
  lastRunAt: string | null;
}

export function workflowsRoutes(app: FastifyInstance, options: WorkflowsRoutesOptions) {
  app.get('/workflows', { preHandler: authenticateApiKey(options.prisma) }, async (request, reply) => {
    const tenantId = request.tenantId;

    const [definitions, eventBindings, runs] = await Promise.all([
      options.prisma.workflowDefinition.findMany({
        where: { tenantId },
        orderBy: { version: 'asc' },
      }),
      options.prisma.workflowEventBinding.findMany({
        where: { tenantId },
      }),
      options.prisma.workflowRun.findMany({
        where: { tenantId },
        select: { workflowName: true, workflowVersion: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const workflowMap = new Map<string, WorkflowAggregate>();

    const getOrCreate = (name: string): WorkflowAggregate => {
      let wf = workflowMap.get(name);
      if (!wf) {
        wf = {
          name,
          versions: new Set<string>(),
          triggers: [],
          totalRuns: 0,
          lastRunAt: null,
        };
        workflowMap.set(name, wf);
      }
      return wf;
    };

    for (const def of definitions) {
      const wf = getOrCreate(def.name);
      if (def.version) {
        wf.versions.add(def.version);
      }
    }

    for (const binding of eventBindings) {
      const wf = getOrCreate(binding.workflowName);
      if (binding.workflowVersion) {
        wf.versions.add(binding.workflowVersion);
      }
      wf.triggers.push({
        eventName: binding.eventName,
        workflowVersion: binding.workflowVersion,
      });
    }

    for (const run of runs) {
      const wf = getOrCreate(run.workflowName);
      if (run.workflowVersion) {
        wf.versions.add(run.workflowVersion);
      }
      if (wf.lastRunAt === null && run.createdAt) {
        wf.lastRunAt = run.createdAt.toISOString();
      }
      wf.totalRuns += 1;
    }

    const workflows = Array.from(workflowMap.values()).map((wf) => ({
      name: wf.name,
      versions: Array.from(wf.versions).sort(),
      triggers: wf.triggers,
      totalRuns: wf.totalRuns,
      lastRunAt: wf.lastRunAt,
    }));

    return reply.status(200).send({ workflows });
  });
}
