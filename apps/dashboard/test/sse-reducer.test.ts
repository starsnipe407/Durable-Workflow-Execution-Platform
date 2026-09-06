import { describe, it, expect } from 'vitest';
import { reduceRunEvent } from '../src/lib/sse-reducer';
import type { WorkflowRun, WorkflowExecutionEvent } from '../src/lib/types';

const baseRun: WorkflowRun = {
  id: 'run-101',
  tenantId: 'tenant-abc',
  workflowName: 'order-workflow',
  workflowVersion: '1.2.0',
  status: 'RUNNING',
  input: { orderId: 'ord-999' },
  workflowAttempt: 1,
  triggerType: 'DIRECT',
  createdAt: '2026-09-06T10:00:00.000Z',
  updatedAt: '2026-09-06T10:00:00.000Z',
  startedAt: '2026-09-06T10:00:00.000Z',
  stepExecutions: [
    {
      id: 'step-exec-1',
      stepKey: 'validateOrder',
      status: 'PENDING',
      retryLimit: 3,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
    },
  ],
};

describe('SSE Reducer (reduceRunEvent)', () => {
  it('handles STEP_STARTED for existing step and preserves attemptCount if absent', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-1',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      stepExecutionId: 'step-exec-1',
      eventType: 'STEP_STARTED',
      payload: { stepKey: 'validateOrder' },
      createdAt: '2026-09-06T10:00:01.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun.stepExecutions?.[0].status).toBe('RUNNING');
    expect(nextRun.stepExecutions?.[0].startedAt).toBe('2026-09-06T10:00:01.000Z');
    // Must NOT artificially increment attemptCount
    expect(nextRun.stepExecutions?.[0].attemptCount).toBe(0);
  });

  it('handles STEP_STARTED with explicit attemptCount in payload', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-2',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      stepExecutionId: 'step-exec-1',
      eventType: 'STEP_STARTED',
      payload: { stepKey: 'validateOrder', attemptCount: 2 },
      createdAt: '2026-09-06T10:00:02.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun.stepExecutions?.[0].status).toBe('RUNNING');
    expect(nextRun.stepExecutions?.[0].attemptCount).toBe(2);
  });

  it('handles STEP_STARTED for a new step not present in stepExecutions', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-3',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      stepExecutionId: 'step-exec-2',
      eventType: 'STEP_STARTED',
      payload: { stepKey: 'chargeCard', attemptCount: 1 },
      createdAt: '2026-09-06T10:00:03.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun.stepExecutions).toHaveLength(2);
    const newStep = nextRun.stepExecutions?.find((s) => s.stepKey === 'chargeCard');
    expect(newStep).toBeDefined();
    expect(newStep?.id).toBe('step-exec-2');
    expect(newStep?.status).toBe('RUNNING');
    expect(newStep?.startedAt).toBe('2026-09-06T10:00:03.000Z');
    expect(newStep?.attemptCount).toBe(1);
  });

  it('handles STEP_ATTEMPT_FAILED when step will retry (status -> RETRY_WAIT)', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-4',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      stepExecutionId: 'step-exec-1',
      eventType: 'STEP_ATTEMPT_FAILED',
      payload: {
        stepKey: 'validateOrder',
        willRetry: true,
        errorMessage: 'Network timeout',
      },
      createdAt: '2026-09-06T10:00:04.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    const step = nextRun.stepExecutions?.[0];
    expect(step?.status).toBe('RETRY_WAIT');
    expect(step?.error).toBe('Network timeout');
  });

  it('handles STEP_ATTEMPT_FAILED when step will NOT retry (status -> FAILED)', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-5',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      stepExecutionId: 'step-exec-1',
      eventType: 'STEP_ATTEMPT_FAILED',
      payload: {
        stepKey: 'validateOrder',
        willRetry: false,
        error: { message: 'Card declined', code: 'DECLINED' },
      },
      createdAt: '2026-09-06T10:00:05.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    const step = nextRun.stepExecutions?.[0];
    expect(step?.status).toBe('FAILED');
    expect(step?.error).toEqual({ message: 'Card declined', code: 'DECLINED' });
  });

  it('handles STEP_RETRY_SCHEDULED', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-6',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      stepExecutionId: 'step-exec-1',
      eventType: 'STEP_RETRY_SCHEDULED',
      payload: {
        stepKey: 'validateOrder',
        nextRetryAt: '2026-09-06T10:00:15.000Z',
      },
      createdAt: '2026-09-06T10:00:06.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    const step = nextRun.stepExecutions?.[0];
    expect(step?.status).toBe('RETRY_WAIT');
    expect(step?.nextRetryAt).toBe('2026-09-06T10:00:15.000Z');
  });

  it('handles STEP_COMPLETED', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-7',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      stepExecutionId: 'step-exec-1',
      eventType: 'STEP_COMPLETED',
      payload: {
        stepKey: 'validateOrder',
        output: { valid: true, tax: 15 },
      },
      createdAt: '2026-09-06T10:00:07.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    const step = nextRun.stepExecutions?.[0];
    expect(step?.status).toBe('COMPLETED');
    expect(step?.completedAt).toBe('2026-09-06T10:00:07.000Z');
    expect(step?.output).toEqual({ valid: true, tax: 15 });
  });

  it('handles WORKFLOW_COMPLETED', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-8',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      eventType: 'WORKFLOW_COMPLETED',
      payload: { output: { receiptId: 'rcpt-123' } },
      createdAt: '2026-09-06T10:00:10.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun.status).toBe('COMPLETED');
    expect(nextRun.completedAt).toBe('2026-09-06T10:00:10.000Z');
    expect(nextRun.output).toEqual({ receiptId: 'rcpt-123' });
  });

  it('handles WORKFLOW_FAILED', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-9',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      eventType: 'WORKFLOW_FAILED',
      payload: { error: 'Fatal worker error' },
      createdAt: '2026-09-06T10:00:11.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun.status).toBe('FAILED');
    expect(nextRun.failedAt).toBe('2026-09-06T10:00:11.000Z');
    expect(nextRun.error).toBe('Fatal worker error');
  });

  it('handles WORKFLOW_CANCEL_REQUESTED', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-10',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      eventType: 'WORKFLOW_CANCEL_REQUESTED',
      payload: {},
      createdAt: '2026-09-06T10:00:12.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun.status).toBe('CANCEL_REQUESTED');
    expect(nextRun.cancelRequestedAt).toBe('2026-09-06T10:00:12.000Z');
  });

  it('handles WORKFLOW_CANCELLED', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-11',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      eventType: 'WORKFLOW_CANCELLED',
      payload: {},
      createdAt: '2026-09-06T10:00:13.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun.status).toBe('CANCELLED');
    expect(nextRun.cancelledAt).toBe('2026-09-06T10:00:13.000Z');
  });

  it('returns unchanged run on unhandled event', () => {
    const event: WorkflowExecutionEvent = {
      id: 'evt-12',
      tenantId: 'tenant-abc',
      workflowRunId: 'run-101',
      eventType: 'UNKNOWN_EVENT_TYPE',
      payload: {},
      createdAt: '2026-09-06T10:00:14.000Z',
    };

    const nextRun = reduceRunEvent(baseRun, event);
    expect(nextRun).toBe(baseRun);
  });
});
