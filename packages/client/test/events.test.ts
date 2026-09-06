import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';
import { createApp } from '@durable/api';
import { createWorkflowClient, WorkflowClientError, SendEventOptions, SendEventResponse } from '../src/index';

describe('WorkflowClient Events E2E', () => {
  let app: ReturnType<typeof createApp>;
  let prisma: PrismaClient;
  let baseUrl: string;
  let tenantId: string;
  const validApiKey = `test_events_key_${crypto.randomUUID()}`;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    const tenant = await prisma.tenant.create({
      data: {
        name: `Client Events Test Tenant ${crypto.randomUUID()}`,
        apiKeys: {
          create: {
            keyHash: crypto.createHash('sha256').update(validApiKey).digest('hex'),
            label: 'test-events',
          },
        },
      },
    });
    tenantId = tenant.id;

    // Create a workflow event binding for testing
    await prisma.workflowEventBinding.create({
      data: {
        tenantId,
        eventName: 'user.signup',
        workflowName: 'OnboardingWorkflow',
        workflowVersion: '1.0.0',
      },
    });

    app = createApp({ prisma });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (tenantId) {
      await prisma.executionEvent.deleteMany({ where: { tenantId } });
      await prisma.workflowRun.deleteMany({ where: { tenantId } });
      await prisma.workflowEventBinding.deleteMany({ where: { tenantId } });
      await prisma.ingestedEvent.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  });

  it('client.sendEvent({ id, name, data }) successfully sends event, creates workflow runs, and returns status: "processed"', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const eventPayload: SendEventOptions = {
      id: `evt-${crypto.randomUUID()}`,
      name: 'user.signup',
      data: { userId: 'user-123', email: 'test@example.com' },
    };

    const response: SendEventResponse = await client.sendEvent(eventPayload);

    expect(response).toBeDefined();
    expect(response.status).toBe('processed');
    expect(response.eventId).toBe(eventPayload.id);
    expect(response.runs).toHaveLength(1);
    expect(response.runs[0].workflowName).toBe('OnboardingWorkflow');
    expect(response.runs[0].workflowVersion).toBe('1.0.0');
    expect(response.runs[0].status).toBe('PENDING');
    expect(response.runs[0].input).toEqual(eventPayload.data);
  });

  it('sending a duplicate event returns status: "duplicate" and empty runs array without error', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });
    const duplicateEventId = `evt-dup-${crypto.randomUUID()}`;

    const firstResponse = await client.sendEvent({
      id: duplicateEventId,
      name: 'user.signup',
      data: { test: true },
    });
    expect(firstResponse.status).toBe('processed');

    const secondResponse = await client.sendEvent({
      id: duplicateEventId,
      name: 'user.signup',
      data: { test: true },
    });
    expect(secondResponse.status).toBe('duplicate');
    expect(secondResponse.eventId).toBe(duplicateEventId);
    expect(secondResponse.runs).toEqual([]);
  });

  it('sending an invalid event payload throws WorkflowClientError with statusCode: 400', async () => {
    const client = createWorkflowClient({ baseUrl, apiKey: validApiKey });

    // Missing name
    await expect(
      client.sendEvent({ id: 'evt-no-name' } as any)
    ).rejects.toThrow(WorkflowClientError);

    // Missing id
    await expect(
      client.sendEvent({ name: 'user.signup' } as any)
    ).rejects.toThrow(WorkflowClientError);

    try {
      await client.sendEvent({ id: '', name: '' });
      expect.unreachable('Should have thrown WorkflowClientError');
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowClientError);
      expect(e.statusCode).toBe(400);
    }
  });
});
