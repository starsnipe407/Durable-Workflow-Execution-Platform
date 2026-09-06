import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBadge } from '@/components/runs/StatusBadge';
import RunsPage from '@/app/runs/page';
import type { WorkflowRun } from '@/lib/types';

vi.mock('next/navigation', () => ({
  usePathname: () => '/runs',
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const mockRuns: WorkflowRun[] = [
  {
    id: 'run-order-001',
    tenantId: 'tenant-default',
    workflowName: 'order-workflow',
    workflowVersion: '1.0.0',
    status: 'COMPLETED',
    input: { orderId: 101 },
    triggerType: 'DIRECT',
    workflowAttempt: 1,
    startedAt: '2026-09-06T12:00:00.000Z',
    completedAt: '2026-09-06T12:00:03.500Z',
    createdAt: '2026-09-06T12:00:00.000Z',
    updatedAt: '2026-09-06T12:00:03.500Z',
  },
  {
    id: 'run-payment-002',
    tenantId: 'tenant-default',
    workflowName: 'payment-workflow',
    workflowVersion: '2.1.0',
    status: 'RUNNING',
    input: { amount: 50 },
    triggerType: 'EVENT',
    triggerEventId: 'evt-charge-123',
    workflowAttempt: 1,
    startedAt: '2026-09-06T12:10:00.000Z',
    createdAt: '2026-09-06T12:09:59.000Z',
    updatedAt: '2026-09-06T12:10:00.000Z',
  },
  {
    id: 'run-notification-003',
    tenantId: 'tenant-default',
    workflowName: 'notification-workflow',
    workflowVersion: '1.0.0',
    status: 'FAILED',
    input: { userId: 'u-1' },
    triggerType: 'DIRECT',
    workflowAttempt: 2,
    startedAt: '2026-09-06T12:15:00.000Z',
    failedAt: '2026-09-06T12:15:05.000Z',
    createdAt: '2026-09-06T12:15:00.000Z',
    updatedAt: '2026-09-06T12:15:05.000Z',
  },
];

const mockWorkflows = {
  workflows: [
    {
      name: 'order-workflow',
      versions: ['1.0.0'],
      triggers: [],
      totalRuns: 10,
      lastRunAt: '2026-09-06T12:00:00.000Z',
    },
    {
      name: 'payment-workflow',
      versions: ['2.1.0'],
      triggers: [{ eventName: 'payment.requested', workflowVersion: '2.1.0' }],
      totalRuns: 5,
      lastRunAt: '2026-09-06T12:10:00.000Z',
    },
    {
      name: 'notification-workflow',
      versions: ['1.0.0'],
      triggers: [],
      totalRuns: 1,
      lastRunAt: '2026-09-06T12:15:00.000Z',
    },
  ],
};

describe('Runs Explorer UI Components (TDD)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderWithQuery = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  it('1. StatusBadge renders appropriate color and label for each status', () => {
    const { rerender } = render(<StatusBadge status="COMPLETED" />);
    let badge = screen.getByText('COMPLETED').closest('span');
    expect(badge).toHaveClass('bg-emerald-50', 'text-emerald-700', 'border-emerald-200');

    rerender(<StatusBadge status="RUNNING" />);
    badge = screen.getByText('RUNNING').closest('span');
    expect(badge).toHaveClass('bg-blue-50', 'text-blue-700', 'border-blue-200');

    rerender(<StatusBadge status="FAILED" />);
    badge = screen.getByText('FAILED').closest('span');
    expect(badge).toHaveClass('bg-rose-50', 'text-rose-700', 'border-rose-200');

    rerender(<StatusBadge status="CANCEL_REQUESTED" />);
    badge = screen.getByText('CANCEL_REQUESTED').closest('span');
    expect(badge).toHaveClass('bg-orange-50', 'text-orange-700', 'border-orange-200');

    rerender(<StatusBadge status="CANCELLED" />);
    badge = screen.getByText('CANCELLED').closest('span');
    expect(badge).toHaveClass('bg-neutral-100', 'text-neutral-600', 'border-neutral-200');

    rerender(<StatusBadge status="PENDING" />);
    badge = screen.getByText('PENDING').closest('span');
    expect(badge).toHaveClass('bg-amber-50', 'text-amber-700', 'border-amber-200');

    rerender(<StatusBadge status="RETRY_WAIT" />);
    badge = screen.getByText('RETRY_WAIT').closest('span');
    expect(badge).toHaveClass('bg-amber-50', 'text-amber-700', 'border-amber-200');
  });

  it('2. RunsPage renders table of runs with columns (Run ID, Workflow, Status, Duration)', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockWorkflows,
        });
      }
      if (url.includes('/api/runs')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ runs: mockRuns }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    renderWithQuery(<RunsPage />);

    // Table headers
    expect(screen.getByRole('columnheader', { name: /run id/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /workflow/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /duration/i })).toBeInTheDocument();

    // Runs data rendered
    await waitFor(() => {
      expect(screen.getByText('run-order-001')).toBeInTheDocument();
      expect(screen.getAllByText('order-workflow').length).toBeGreaterThan(0);
      expect(screen.getByText('run-payment-002')).toBeInTheDocument();
      expect(screen.getAllByText('payment-workflow').length).toBeGreaterThan(0);
      expect(screen.getByText('run-notification-003')).toBeInTheDocument();
      expect(screen.getAllByText('notification-workflow').length).toBeGreaterThan(0);
    });

    // Run ID link
    const runLink = screen.getByRole('link', { name: 'run-order-001' });
    expect(runLink).toHaveAttribute('href', '/runs/run-order-001');

    // Trigger details
    expect(screen.getAllByText('DIRECT').length).toBe(2);
    expect(screen.getByText(/evt-charge-123/)).toBeInTheDocument();

    // Duration formatting
    expect(screen.getByText('3.5s')).toBeInTheDocument();
    expect(screen.getByText('5.0s')).toBeInTheDocument();
  });

  it('3. Clicking status filter button updates query and filters runs', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockWorkflows,
        });
      }
      if (url.includes('/api/runs')) {
        if (url.includes('status=FAILED')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ runs: [mockRuns[2]] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ runs: mockRuns }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });
    globalThis.fetch = fetchMock;

    renderWithQuery(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByText('run-order-001')).toBeInTheDocument();
    });

    // Click FAILED filter button
    const failedFilterBtn = screen.getByRole('button', { name: /^FAILED$/i });
    fireEvent.click(failedFilterBtn);

    await waitFor(() => {
      expect(screen.getByText('run-notification-003')).toBeInTheDocument();
      expect(screen.queryByText('run-order-001')).not.toBeInTheDocument();
    });

    const calledUrls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(calledUrls.some((url) => url.includes('status=FAILED'))).toBe(true);
  });

  it('4. Selecting workflow from dropdown filters runs by workflowName', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockWorkflows,
        });
      }
      if (url.includes('/api/runs')) {
        if (url.includes('workflowName=order-workflow')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ runs: [mockRuns[0]] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ runs: mockRuns }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });
    globalThis.fetch = fetchMock;

    renderWithQuery(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByText('run-order-001')).toBeInTheDocument();
    });

    // Workflow select
    const workflowSelect = screen.getByRole('combobox', { name: /workflow/i });
    fireEvent.change(workflowSelect, { target: { value: 'order-workflow' } });

    await waitFor(() => {
      expect(screen.getByText('run-order-001')).toBeInTheDocument();
      expect(screen.queryByText('run-payment-002')).not.toBeInTheDocument();
    });

    const calledUrls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(calledUrls.some((url) => url.includes('workflowName=order-workflow'))).toBe(true);
  });

  it('5. Pagination: Clicking "Next" advances offset and requests next page', async () => {
    const page1Runs = Array.from({ length: 20 }, (_, i) => ({
      ...mockRuns[0],
      id: `run-page1-${i}`,
    }));
    const page2Runs = [
      {
        ...mockRuns[0],
        id: 'run-page2-0',
      },
    ];

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockWorkflows,
        });
      }
      if (url.includes('/api/runs')) {
        if (url.includes('offset=20')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ runs: page2Runs }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ runs: page1Runs }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });
    globalThis.fetch = fetchMock;

    renderWithQuery(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByText('run-page1-0')).toBeInTheDocument();
    });

    const prevButton = screen.getByRole('button', { name: /previous/i });
    const nextButton = screen.getByRole('button', { name: /next/i });

    expect(prevButton).toBeDisabled();
    expect(nextButton).not.toBeDisabled();

    // Click Next
    fireEvent.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText('run-page2-0')).toBeInTheDocument();
    });

    const calledUrls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(calledUrls.some((url) => url.includes('offset=20'))).toBe(true);
    expect(prevButton).not.toBeDisabled();

    // Click Previous
    fireEvent.click(prevButton);

    await waitFor(() => {
      expect(screen.getByText('run-page1-0')).toBeInTheDocument();
    });
  });

  it('6. Renders error message if /api/runs fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockWorkflows,
        });
      }
      if (url.includes('/api/runs')) {
        return Promise.resolve({
          ok: false,
          status: 500,
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    renderWithQuery(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/failed to load workflow runs/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('7. Renders empty state when no runs match filter', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockWorkflows,
        });
      }
      if (url.includes('/api/runs')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ runs: [] }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    renderWithQuery(<RunsPage />);

    await waitFor(() => {
      expect(screen.getByText(/no runs found matching the selected filters/i)).toBeInTheDocument();
    });
  });
});
