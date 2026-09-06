import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navbar } from '@/components/layout/Navbar';
import { SystemHealthBadge } from '@/components/dashboard/SystemHealthBadge';
import { DashboardOverview } from '@/components/dashboard/DashboardOverview';
import WorkflowsPage from '@/app/workflows/page';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

describe('Dashboard & Workflows UI Components (TDD)', () => {
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

  it('1. Navbar renders links and system health badge ("Healthy")', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        systemStatus: 'healthy',
        activeRuns: 1,
        completedRuns: 5,
        failedRuns: 0,
        cancelledRuns: 0,
        totalRuns: 6,
      }),
    } as any);

    renderWithQuery(<Navbar />);

    expect(screen.getByText('Durable Engine')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /overview/i })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: /workflows/i })).toHaveAttribute('href', '/workflows');
    expect(screen.getByRole('link', { name: /runs/i })).toHaveAttribute('href', '/runs');

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });
  });

  it('2. SystemHealthBadge renders "Degraded" when /api/metrics reports systemStatus: "degraded"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        systemStatus: 'degraded',
        activeRuns: 2,
        completedRuns: 10,
        failedRuns: 4,
        cancelledRuns: 1,
        totalRuns: 17,
      }),
    } as any);

    renderWithQuery(<SystemHealthBadge />);

    await waitFor(() => {
      expect(screen.getByText('Degraded')).toBeInTheDocument();
    });
  });

  it('3. DashboardOverview renders metric cards with correct values (Active, Completed, Failed, Total) and recent runs table', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/metrics')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            systemStatus: 'healthy',
            activeRuns: 3,
            completedRuns: 42,
            failedRuns: 2,
            cancelledRuns: 1,
            totalRuns: 48,
          }),
        });
      }
      if (url.includes('/api/runs')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            runs: [
              {
                id: 'run-order-processing-001',
                tenantId: 'tenant-default',
                workflowName: 'order-processing',
                workflowVersion: '1.2.0',
                status: 'COMPLETED',
                input: { orderId: 101 },
                startedAt: '2026-09-06T12:00:00.000Z',
                completedAt: '2026-09-06T12:00:02.500Z',
                createdAt: '2026-09-06T12:00:00.000Z',
                updatedAt: '2026-09-06T12:00:02.500Z',
              },
              {
                id: 'run-payment-charge-002',
                tenantId: 'tenant-default',
                workflowName: 'payment-charge',
                workflowVersion: '1.0.0',
                status: 'FAILED',
                input: { amount: 50 },
                startedAt: '2026-09-06T12:05:00.000Z',
                failedAt: '2026-09-06T12:05:01.200Z',
                createdAt: '2026-09-06T12:05:00.000Z',
                updatedAt: '2026-09-06T12:05:01.200Z',
              },
            ],
          }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    renderWithQuery(<DashboardOverview />);

    // Metric cards
    await waitFor(() => {
      expect(screen.getByText('48')).toBeInTheDocument(); // Total Runs
      expect(screen.getByText('3')).toBeInTheDocument(); // Active Runs
      expect(screen.getByText('42')).toBeInTheDocument(); // Completed Runs
      expect(screen.getByText('2')).toBeInTheDocument(); // Failed Runs
    });

    // Recent runs table
    expect(screen.getByText('run-order-processing-001')).toBeInTheDocument();
    expect(screen.getByText('order-processing')).toBeInTheDocument();
    expect(screen.getByText('payment-charge')).toBeInTheDocument();
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();

    // Link to run details
    const runLink = screen.getByRole('link', { name: 'run-order-processing-001' });
    expect(runLink).toHaveAttribute('href', '/runs/run-order-processing-001');

    // Link to view all runs
    const viewAllLink = screen.getByRole('link', { name: /view all runs/i });
    expect(viewAllLink).toHaveAttribute('href', '/runs');
  });

  it('4. WorkflowsPage renders list of workflows with versions, triggers, and execution counts', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            workflows: [
              {
                name: 'order-workflow',
                versions: ['1.0.0', '1.1.0'],
                triggers: [{ eventName: 'order.created', workflowVersion: '1.1.0' }],
                concurrency: { globalLimit: 5, perKey: false },
                totalRuns: 120,
                lastRunAt: '2026-09-06T10:00:00.000Z',
              },
              {
                name: 'notification-workflow',
                versions: ['2.0.0'],
                triggers: [],
                concurrency: { perKey: true },
                totalRuns: 45,
                lastRunAt: null,
              },
            ],
          }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    renderWithQuery(<WorkflowsPage />);

    await waitFor(() => {
      expect(screen.getByText('order-workflow')).toBeInTheDocument();
      expect(screen.getByText('notification-workflow')).toBeInTheDocument();
    });

    // Versions
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
    expect(screen.getByText('1.1.0')).toBeInTheDocument();
    expect(screen.getByText('2.0.0')).toBeInTheDocument();

    // Triggers
    expect(screen.getByText(/order\.created/)).toBeInTheDocument();
    expect(screen.getByText(/direct execution/i)).toBeInTheDocument();

    // Concurrency
    expect(screen.getByText(/limit: 5/i)).toBeInTheDocument();
    expect(screen.getByText(/per-key/i)).toBeInTheDocument();

    // Runs
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('45')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('5. WorkflowsPage filters workflows when typing into the search input', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/workflows')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            workflows: [
              {
                name: 'invoice-billing',
                versions: ['1.0.0'],
                triggers: [],
                totalRuns: 10,
                lastRunAt: null,
              },
              {
                name: 'user-onboarding',
                versions: ['1.0.0'],
                triggers: [],
                totalRuns: 5,
                lastRunAt: null,
              },
            ],
          }),
        });
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    renderWithQuery(<WorkflowsPage />);

    await waitFor(() => {
      expect(screen.getByText('invoice-billing')).toBeInTheDocument();
      expect(screen.getByText('user-onboarding')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search workflows/i);
    fireEvent.change(searchInput, { target: { value: 'billing' } });

    expect(screen.getByText('invoice-billing')).toBeInTheDocument();
    expect(screen.queryByText('user-onboarding')).not.toBeInTheDocument();
  });
});
