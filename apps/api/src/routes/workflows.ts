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

    const [definitions, eventBindings, runAggregates, runVersions] = await Promise.all([
      options.prisma.workflowDefinition.findMany({
        where: { tenantId },
        orderBy: { version: 'asc' },
      }),
      options.prisma.workflowEventBinding.findMany({
        where: { tenantId },
      }),
      options.prisma.workflowRun.groupBy({
        by: ['workflowName'],
        where: { tenantId },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      options.prisma.workflowRun.findMany({
        where: { tenantId },
        distinct: ['workflowName', 'workflowVersion'],
        select: { workflowName: true, workflowVersion: true },
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

    for (const rv of runVersions) {
      const wf = getOrCreate(rv.workflowName);
      if (rv.workflowVersion) {
        wf.versions.add(rv.workflowVersion);
      }
    }

    for (const agg of runAggregates) {
      const wf = getOrCreate(agg.workflowName);
      wf.totalRuns = agg._count._all;
      wf.lastRunAt = agg._max.createdAt ? agg._max.createdAt.toISOString() : null;
    }

    const workflows = Array.from(workflowMap.values())
      .map((wf) => ({
        name: wf.name,
        versions: Array.from(wf.versions).sort(),
        triggers: wf.triggers,
        totalRuns: wf.totalRuns,
        lastRunAt: wf.lastRunAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return reply.status(200).send({ workflows });
  });
}
