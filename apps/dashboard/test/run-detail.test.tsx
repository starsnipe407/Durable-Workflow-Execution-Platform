import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JsonViewer } from '../src/components/run-detail/JsonViewer';
import { AttemptInspector } from '../src/components/run-detail/AttemptInspector';
import { StepTimeline } from '../src/components/run-detail/StepTimeline';
import { RunActions } from '../src/components/run-detail/RunActions';
import RunDetailPage from '../src/app/runs/[id]/page';
import type { WorkflowRun, StepExecution, StepAttempt } from '../src/lib/types';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'run-order-001' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/runs/run-order-001',
}));

const mockAttempts: StepAttempt[] = [
  {
    id: 'att-1',
    stepExecutionId: 'step-exec-1',
    attemptNumber: 1,
    status: 'FAILED',
    workerId: 'worker-primary-01',
    startedAt: '2026-09-06T12:00:00.000Z',
    finishedAt: '2026-09-06T12:00:00.350Z',
    errorType: 'TransientNetworkError',
    errorMessage: 'Connection reset by peer',
    errorMetadata: { host: 'api.payment.internal', port: 443 },
    retryDelayMs: 2000,
  },
  {
    id: 'att-2',
    stepExecutionId: 'step-exec-1',
    attemptNumber: 2,
    status: 'COMPLETED',
    workerId: 'worker-primary-02',
    startedAt: '2026-09-06T12:00:02.350Z',
    finishedAt: '2026-09-06T12:00:02.500Z',
  },
];

const mockStepExecutions: StepExecution[] = [
  {
    id: 'step-exec-1',
    stepKey: 'validateOrder',
    status: 'COMPLETED',
    retryLimit: 3,
    attemptCount: 2,
    startedAt: '2026-09-06T12:00:00.000Z',
    completedAt: '2026-09-06T12:00:02.500Z',
    stepAttempts: mockAttempts,
    input: { orderId: 'ord-123' },
    output: { isValid: true },
  },
  {
    id: 'step-exec-2',
    stepKey: 'chargePayment',
    status: 'COMPLETED',
    retryLimit: 3,
    attemptCount: 1,
    startedAt: '2026-09-06T12:00:01.500Z', // Overlaps with validateOrder (12:00:00 - 12:00:02.5)
    completedAt: '2026-09-06T12:00:03.000Z',
    stepAttempts: [
      {
        id: 'att-3',
        stepExecutionId: 'step-exec-2',
        attemptNumber: 1,
        status: 'COMPLETED',
        workerId: 'worker-primary-01',
        startedAt: '2026-09-06T12:00:01.500Z',
        finishedAt: '2026-09-06T12:00:03.000Z',
      },
    ],
  },
  {
    id: 'step-exec-3',
    stepKey: 'sendEmailReceipt',
    status: 'RETRY_WAIT',
    retryLimit: 3,
    attemptCount: 1,
    startedAt: '2026-09-06T12:00:04.000Z', // Does NOT overlap with 1 or 2
    nextRetryAt: '2026-09-06T12:00:10.000Z',
    error: 'SMTP service unreachable',
  },
];

const mockRun: WorkflowRun = {
  id: 'run-order-001',
  tenantId: 'tenant-default',
  workflowName: 'order-workflow',
  workflowVersion: '1.4.0',
  status: 'FAILED',
  input: { orderId: 'ord-123', customer: 'Alice' },
  output: null,
  error: { message: 'Workflow failed at sendEmailReceipt' },
  workflowAttempt: 1,
  triggerType: 'EVENT',
  triggerEventId: 'evt-checkout-99',
  concurrencyKey: 'usr-alice-77',
  startedAt: '2026-09-06T12:00:00.000Z',
  failedAt: '2026-09-06T12:00:05.000Z',
  createdAt: '2026-09-06T12:00:00.000Z',
  updatedAt: '2026-09-06T12:00:05.000Z',
  stepExecutions: mockStepExecutions,
};

describe('Run Detail Components (TDD)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderWithQuery = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  describe('JsonViewer', () => {
    it('renders title and formatted json string', () => {
      render(<JsonViewer title="Workflow Input" data={{ foo: 'bar', num: 42 }} />);
      expect(screen.getByText('Workflow Input')).toBeInTheDocument();
      expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
    });

    it('handles null or undefined cleanly', () => {
      render(<JsonViewer title="Workflow Output" data={null} />);
      expect(screen.getByText('Workflow Output')).toBeInTheDocument();
      expect(screen.getByText('No data')).toBeInTheDocument();
    });

    it('supports collapsing and expanding', () => {
      render(<JsonViewer title="Expandable Data" data={{ key: 'val' }} defaultExpanded={true} />);
      expect(screen.getByText(/"key": "val"/)).toBeInTheDocument();

      const toggleButton = screen.getByRole('button', { name: /toggle-collapse/i });
      fireEvent.click(toggleButton);
      expect(screen.queryByText(/"key": "val"/)).not.toBeInTheDocument();

      fireEvent.click(toggleButton);
      expect(screen.getByText(/"key": "val"/)).toBeInTheDocument();
    });

    it('copies content to clipboard and shows feedback', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      render(<JsonViewer title="Copyable JSON" data={{ hello: 'world' }} />);
      const copyBtn = screen.getByRole('button', { name: /copy-json/i });
      fireEvent.click(copyBtn);

      expect(writeTextMock).toHaveBeenCalledWith(JSON.stringify({ hello: 'world' }, null, 2));
      await waitFor(() => {
        expect(screen.getByText(/copied/i)).toBeInTheDocument();
      });
    });
  });

  describe('AttemptInspector', () => {
    it('renders historical attempts ordered by attemptNumber with worker and timestamps', () => {
      render(<AttemptInspector stepAttempts={mockAttempts} />);

      expect(screen.getByText('Attempt #1')).toBeInTheDocument();
      expect(screen.getByText('Attempt #2')).toBeInTheDocument();
      expect(screen.getByText(/worker-primary-01/)).toBeInTheDocument();
      expect(screen.getByText(/worker-primary-02/)).toBeInTheDocument();
      expect(screen.getByText(/TransientNetworkError/)).toBeInTheDocument();
      expect(screen.getByText(/Connection reset by peer/)).toBeInTheDocument();
      expect(screen.getByText(/2000ms/)).toBeInTheDocument(); // Retry delay / backoff
    });

    it('renders error metadata expandable section if present', () => {
      render(<AttemptInspector stepAttempts={mockAttempts} />);
      const metaToggle = screen.getByRole('button', { name: /view-error-metadata/i });
      fireEvent.click(metaToggle);
      expect(screen.getByText(/"api.payment.internal"/)).toBeInTheDocument();
    });
  });

  describe('StepTimeline', () => {
    it('orders steps chronologically and displays badges, duration, and attempts', () => {
      render(<StepTimeline stepExecutions={mockStepExecutions} />);

      const stepKeys = screen.getAllByTestId('step-key');
      expect(stepKeys[0]).toHaveTextContent('validateOrder');
      expect(stepKeys[1]).toHaveTextContent('chargePayment');
      expect(stepKeys[2]).toHaveTextContent('sendEmailReceipt');

      // Attempt count badges
      expect(screen.getByText('2 attempts')).toBeInTheDocument();
      expect(screen.getAllByText('1 attempt')).toHaveLength(2);

      // RETRY_WAIT next retry timestamp or countdown
      expect(screen.getByText(/Next retry/i)).toBeInTheDocument();
    });

    it('renders Concurrent badge for overlapping step execution windows', () => {
      render(<StepTimeline stepExecutions={mockStepExecutions} />);

      // validateOrder (12:00:00 - 12:00:02.5) and chargePayment (12:00:01.5 - 12:00:03.0) overlap
      const concurrentBadges = screen.getAllByText('Concurrent');
      expect(concurrentBadges.length).toBeGreaterThanOrEqual(2);

      // sendEmailReceipt (12:00:04 - 12:00:10) does not overlap
      const sendEmailCard = screen.getByText('sendEmailReceipt').closest('[data-testid="timeline-step-item"]');
      expect(sendEmailCard).not.toHaveTextContent('Concurrent');
    });

    it('toggles AttemptInspector display for a step', () => {
      render(<StepTimeline stepExecutions={mockStepExecutions} />);

      expect(screen.queryByText('Attempt #1')).not.toBeInTheDocument();

      const expandBtn = screen.getAllByRole('button', { name: /toggle-attempts/i })[0];
      fireEvent.click(expandBtn);

      expect(screen.getByText('Attempt #1')).toBeInTheDocument();
      expect(screen.getByText(/worker-primary-01/)).toBeInTheDocument();

      fireEvent.click(expandBtn);
      expect(screen.queryByText('Attempt #1')).not.toBeInTheDocument();
    });

    it('falls back to createdAt for chronological sorting and interval window calculations', () => {
      const pendingSteps: StepExecution[] = [
        {
          id: 'step-pending-2',
          stepKey: 'laterPendingStep',
          status: 'PENDING',
          retryLimit: 3,
          attemptCount: 0,
          startedAt: null,
          createdAt: '2026-09-06T12:00:03.000Z',
        },
        {
          id: 'step-pending-1',
          stepKey: 'earlierPendingStep',
          status: 'PENDING',
          retryLimit: 3,
          attemptCount: 0,
          startedAt: null,
          createdAt: '2026-09-06T12:00:01.000Z',
        },
      ];

      render(<StepTimeline stepExecutions={pendingSteps} />);

      const stepKeys = screen.getAllByTestId('step-key');
      expect(stepKeys[0]).toHaveTextContent('earlierPendingStep');
      expect(stepKeys[1]).toHaveTextContent('laterPendingStep');
    });

    it('uses nullish coalescing for attemptCount and displays 0 attempts when attemptCount is 0', () => {
      const stepWithZeroAttempts: StepExecution[] = [
        {
          id: 'step-pending',
          stepKey: 'notYetStartedStep',
          status: 'PENDING',
          retryLimit: 3,
          attemptCount: 0,
          startedAt: null,
          createdAt: '2026-09-06T12:00:00.000Z',
        },
      ];

      render(<StepTimeline stepExecutions={stepWithZeroAttempts} />);

      expect(screen.getByText('0 attempts')).toBeInTheDocument();
      expect(screen.queryByText('1 attempt')).not.toBeInTheDocument();
    });
  });

  describe('RunActions', () => {
    it('enables Retry on FAILED run and sends POST /api/runs/:id/retry', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, message: 'Run retried' }),
      });
      global.fetch = fetchMock;

      const onSuccess = vi.fn();
      renderWithQuery(<RunActions run={mockRun} onActionSuccess={onSuccess} />);

      const retryBtn = screen.getByRole('button', { name: /retry run/i });
      expect(retryBtn).toBeEnabled();

      fireEvent.click(retryBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-order-001/retry', expect.objectContaining({
          method: 'POST',
        }));
        expect(onSuccess).toHaveBeenCalled();
      });
    });

    it('enables Cancel on RUNNING/PENDING run and sends POST /api/runs/:id/cancel after confirm', async () => {
      const runningRun: WorkflowRun = {
        ...mockRun,
        status: 'RUNNING',
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, message: 'Run cancelled' }),
      });
      global.fetch = fetchMock;

      const onSuccess = vi.fn();
      renderWithQuery(<RunActions run={runningRun} onActionSuccess={onSuccess} />);

      const cancelBtn = screen.getByRole('button', { name: /cancel run/i });
      expect(cancelBtn).toBeEnabled();

      fireEvent.click(cancelBtn);

      // Confirm button should appear or trigger
      const confirmBtn = screen.getByRole('button', { name: /confirm cancel/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-order-001/cancel', expect.objectContaining({
          method: 'POST',
        }));
        expect(onSuccess).toHaveBeenCalled();
      });
    });

    it('disables Retry when run is not FAILED', () => {
      const completedRun: WorkflowRun = { ...mockRun, status: 'COMPLETED' };
      renderWithQuery(<RunActions run={completedRun} />);

      expect(screen.queryByRole('button', { name: /retry run/i })).toBeDisabled();
      expect(screen.queryByRole('button', { name: /cancel run/i })).toBeDisabled();
    });
  });

  describe('RunDetailPage', () => {
    it('renders header details, timeline, json viewers, and handles actions', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/runs/run-order-001')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockRun,
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      renderWithQuery(<RunDetailPage params={Promise.resolve({ id: 'run-order-001' })} />);

      // Should show loading then render run details
      await waitFor(() => {
        expect(screen.getByText('run-order-001')).toBeInTheDocument();
        expect(screen.getByText('order-workflow')).toBeInTheDocument();
        expect(screen.getByText('v1.4.0')).toBeInTheDocument();
      });

      // Status badge in header
      expect(screen.getByTestId('status-badge-failed')).toBeInTheDocument();

      // Badges for trigger and concurrency key
      expect(screen.getByText(/EVENT: evt-checkout-99/)).toBeInTheDocument();
      expect(screen.getByText(/Key: usr-alice-77/)).toBeInTheDocument();

      // Terminal status indicator (since status is FAILED)
      expect(screen.getByText(/Terminal/i)).toBeInTheDocument();

      // Timeline steps
      expect(screen.getByText('validateOrder')).toBeInTheDocument();
      expect(screen.getByText('chargePayment')).toBeInTheDocument();

      // JSON viewers
      expect(screen.getByText('Input Payload')).toBeInTheDocument();
      expect(screen.getByText('Error Details')).toBeInTheDocument();
    });

    it('renders 404 state when run is not found', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      renderWithQuery(<RunDetailPage params={Promise.resolve({ id: 'run-non-existent' })} />);

      await waitFor(() => {
        expect(screen.getByText(/Run not found/i)).toBeInTheDocument();
      });
    });
  });
});
