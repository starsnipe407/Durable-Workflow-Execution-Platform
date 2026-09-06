'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CheckCircle2,
  XCircle,
  BarChart3,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';
import { MetricCard } from './MetricCard';
import type { MetricsResponse, WorkflowRun } from '@/lib/types';

function formatDuration(
  startedAt?: string | null,
  completedAt?: string | null,
  failedAt?: string | null,
  cancelledAt?: string | null
): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const endStr = completedAt || failedAt || cancelledAt;
  const end = endStr ? new Date(endStr).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${sec}s`;
  const mins = Math.floor(ms / 60000);
  const remSec = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${remSec}s`;
}

function getStatusBadge(status: string) {
  let style = 'bg-neutral-100 text-neutral-600 border-neutral-200';
  if (status === 'COMPLETED') {
    style = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  } else if (status === 'RUNNING') {
    style = 'bg-blue-50 text-blue-700 border-blue-200';
  } else if (status === 'FAILED') {
    style = 'bg-rose-50 text-rose-700 border-rose-200';
  } else if (status === 'PENDING') {
    style = 'bg-amber-50 text-amber-700 border-amber-200';
  } else if (status === 'CANCEL_REQUESTED') {
    style = 'bg-orange-50 text-orange-700 border-orange-200';
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${style}`}
    >
      {status}
    </span>
  );
}

export function DashboardOverview() {
  const {
    data: metrics,
    isLoading: isMetricsLoading,
    isError: isMetricsError,
  } = useQuery<MetricsResponse>({
    queryKey: ['metrics'],
    queryFn: async () => {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error(`Failed to fetch metrics: ${res.status}`);
      return res.json();
    },
    refetchInterval: 5000,
  });

  const {
    data: runsData,
    isLoading: isRunsLoading,
    isError: isRunsError,
  } = useQuery<{ runs: WorkflowRun[] }>({
    queryKey: ['runs', { limit: 5 }],
    queryFn: async () => {
      const res = await fetch('/api/runs?limit=5');
      if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
      return res.json();
    },
    refetchInterval: 5000,
  });

  const isDegraded = metrics?.systemStatus === 'degraded';
  const runs = runsData?.runs || [];

  return (
    <div className="space-y-8">
      {/* Metrics Error Banner */}
      {isMetricsError && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-900"
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-rose-600" />
          <div className="flex-1 text-sm font-medium">
            Failed to load platform metrics. Please check connection and refresh.
          </div>
        </div>
      )}

      {/* Degraded Alert Banner */}
      {isDegraded && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900"
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm font-medium">
            System status is currently degraded. Database or Redis connection issues may affect execution latency.
          </div>
        </div>
      )}

      {/* KPI Cards Grid */}
      <section>
        <h2 className="text-xl font-bold tracking-tight text-neutral-900 mb-4">
          Overview
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Total Runs"
            value={isMetricsLoading || isMetricsError ? '—' : (metrics?.totalRuns ?? 0)}
            icon={<BarChart3 className="h-5 w-5" />}
            tone="default"
          />
          <MetricCard
            title="Active Runs"
            value={isMetricsLoading || isMetricsError ? '—' : (metrics?.activeRuns ?? 0)}
            icon={<Activity className="h-5 w-5" />}
            tone="blue"
          />
          <MetricCard
            title="Completed Runs"
            value={isMetricsLoading || isMetricsError ? '—' : (metrics?.completedRuns ?? 0)}
            icon={<CheckCircle2 className="h-5 w-5" />}
            tone="green"
          />
          <MetricCard
            title="Failed Runs"
            value={isMetricsLoading || isMetricsError ? '—' : (metrics?.failedRuns ?? 0)}
            icon={<XCircle className="h-5 w-5" />}
            tone="red"
          />
        </div>
      </section>

      {/* Recent Runs Table */}
      <section className="rounded-xl border border-neutral-200 bg-white shadow-xs overflow-hidden">
        <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-neutral-900">
              Recent Executions
            </h3>
            <p className="text-sm text-neutral-500">
              Latest workflow runs dispatched in the platform
            </p>
          </div>
          <Link
            href="/runs"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
          >
            <span>View all runs</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-100 bg-neutral-50 text-xs font-semibold uppercase text-neutral-500">
              <tr>
                <th scope="col" className="px-6 py-3">
                  Run ID
                </th>
                <th scope="col" className="px-6 py-3">
                  Workflow
                </th>
                <th scope="col" className="px-6 py-3">
                  Version
                </th>
                <th scope="col" className="px-6 py-3">
                  Status
                </th>
                <th scope="col" className="px-6 py-3">
                  Started At
                </th>
                <th scope="col" className="px-6 py-3">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {isRunsLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-neutral-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="h-4 w-4 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
                      <span>Loading recent runs...</span>
                    </div>
                  </td>
                </tr>
              ) : isRunsError ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-8 text-center"
                  >
                    <div className="text-red-600 dark:text-red-400 font-medium">
                      Failed to load recent executions. Please refresh.
                    </div>
                  </td>
                </tr>
              ) : runs.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-8 text-center text-neutral-500"
                  >
                    No runs recorded yet.
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr
                    key={run.id}
                    className="hover:bg-neutral-50/70 transition-colors"
                  >
                    <td className="px-6 py-4 font-mono text-xs font-medium text-neutral-900">
                      <Link
                        href={`/runs/${run.id}`}
                        className="text-indigo-600 hover:text-indigo-800 hover:underline font-semibold"
                      >
                        {run.id}
                      </Link>
                    </td>
                    <td className="px-6 py-4 font-medium text-neutral-900">
                      {run.workflowName}
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-neutral-100 text-neutral-700">
                        {run.workflowVersion}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(run.status)}
                    </td>
                    <td className="px-6 py-4 text-xs text-neutral-500">
                      {run.startedAt
                        ? new Date(run.startedAt).toLocaleString()
                        : new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-neutral-600">
                      {formatDuration(
                        run.startedAt,
                        run.completedAt,
                        run.failedAt,
                        run.cancelledAt
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
