import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6380');
const queue = new Queue('workflow-runs', { connection: redis });
const apiKey = `test-events-key-${crypto.randomUUID()}`;

describe('POST /events', () => {
  let app: ReturnType<typeof createApp>;
  let tenantId: string;

  beforeAll(async () => {
    app = createApp({ prisma, queue, redis });
    await app.ready();
    
    const tenant = await prisma.tenant.create({
      data: {
        name: `Test Tenant Events ${crypto.randomUUID()}`,
        apiKeys: {
          create: [{ keyHash: hashApiKey(apiKey), label: 'Test Key' }]
        }
      }
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    if (tenantId) {
      const runs = await prisma.workflowRun.findMany({
        where: { tenantId },
        select: { id: true },
      });
      for (const r of runs) {
        const job = await queue.getJob(`run_${r.id}`);
        if (job) await job.remove();
      }
      await prisma.executionEvent.deleteMany({ where: { tenantId } });
      await prisma.workflowRun.deleteMany({ where: { tenantId } });
      await prisma.workflowEventBinding.deleteMany({ where: { tenantId } });
      await prisma.ingestedEvent.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    
    await app.close();
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  it('fails with 400 on missing id or name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { id: 'evt-1' } // missing name
    });
    expect(res.statusCode).toBe(400);

    const res2 = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'order.created' } // missing id
    });
    expect(res2.statusCode).toBe(400);
  });

  it('ingesting event with 0 bindings creates ingested_events record and returns 201 with empty runs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { id: 'evt-1', name: 'user.created', data: { userId: 123 } }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ status: 'processed', eventId: 'evt-1', runs: [] });

    const event = await prisma.ingestedEvent.findUnique({
      where: { tenantId_eventId: { tenantId, eventId: 'evt-1' } }
    });
    expect(event).toBeDefined();
    expect(event?.eventName).toBe('user.created');
  });

  it('ingesting event with 2 matching bindings creates 2 workflow_runs and enqueues 2 jobs', async () => {
    await prisma.workflowEventBinding.createMany({
      data: [
        { tenantId, eventName: 'order.created', workflowName: 'sendEmail', workflowVersion: '1' },
        { tenantId, eventName: 'order.created', workflowName: 'updateCRM', workflowVersion: '1' }
      ]
    });

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { id: 'evt-2', name: 'order.created', data: { orderId: 456 } }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.runs.length).toBe(2);

    const event = await prisma.ingestedEvent.findUnique({
      where: { tenantId_eventId: { tenantId, eventId: 'evt-2' } }
    });

    const runs = await prisma.workflowRun.findMany({
      where: { triggerEventId: event!.id },
      orderBy: { workflowName: 'asc' }
    });
    expect(runs.length).toBe(2);
    expect(runs[0].triggerType).toBe('EVENT');

    const execEvents = await prisma.executionEvent.findMany({
      where: { workflowRunId: { in: runs.map(r => r.id) } }
    });
    expect(execEvents.length).toBe(2);
    expect(execEvents[0].eventType).toBe('WORKFLOW_CREATED');

    for (const run of runs) {
      const job = await queue.getJob(`run_${run.id}`);
      expect(job).toBeDefined();
      expect(job?.data.runId).toBe(run.id);
    }
  });

  it('retrying with identical event id returns HTTP 200 with { status: "duplicate" }', async () => {
    await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { id: 'evt-3', name: 'login' }
    });

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { id: 'evt-3', name: 'login' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate', eventId: 'evt-3', runs: [] });
  });

  it('concurrent requests with identical event id both succeed, resulting in exactly 1 event', async () => {
    const promises = [
      app.inject({
        method: 'POST',
        url: '/events',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { id: 'evt-4', name: 'signup' }
      }),
      app.inject({
        method: 'POST',
        url: '/events',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { id: 'evt-4', name: 'signup' }
      })
    ];
    
    const [res1, res2] = await Promise.all(promises);
    expect([res1.statusCode, res2.statusCode]).toContain(201);
    expect([res1.statusCode, res2.statusCode]).toContain(200);

    const events = await prisma.ingestedEvent.findMany({
      where: { tenantId, eventId: 'evt-4' }
    });
    expect(events.length).toBe(1);
  });
});
