'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Workflow } from 'lucide-react';
import { StatusBadge } from '@/components/runs/StatusBadge';
import { RunsFilterBar } from '@/components/runs/RunsFilterBar';
import type { WorkflowRun } from '@/lib/types';

function formatDuration(
  startedAt?: string | null,
  completedAt?: string | null,
  failedAt?: string | null,
  cancelledAt?: string | null
): string {
  if (!startedAt) return '—';
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

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString();
}

export default function RunsPage() {
  const [status, setStatus] = useState('ALL');
  const [workflowName, setWorkflowName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery<{ runs: WorkflowRun[] }>({
    queryKey: ['runs', { status, workflowName, limit, offset }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status && status !== 'ALL') {
        params.set('status', status);
      }
      if (workflowName && workflowName !== 'ALL' && workflowName !== '') {
        params.set('workflowName', workflowName);
      }
      params.set('limit', limit.toString());
      params.set('offset', offset.toString());

      const res = await fetch(`/api/runs?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch runs: ${res.status}`);
      }
      return res.json();
    },
  });

  const runs = data?.runs || [];

  const displayedRuns = runs.filter((run) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return run.id.toLowerCase().includes(q) || run.workflowName.toLowerCase().includes(q);
  });

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    setOffset(0);
  };

  const handleWorkflowChange = (newWorkflow: string) => {
    setWorkflowName(newWorkflow);
    setOffset(0);
  };

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setOffset(0);
  };

  const handlePrevious = () => {
    setOffset((prev) => Math.max(0, prev - limit));
  };

  const handleNext = () => {
    setOffset((prev) => prev + limit);
  };

  const canNext = runs.length >= limit;
  const canPrev = offset > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
          Workflow Runs Explorer
        </h1>
        <p className="text-sm text-neutral-500">
          Inspect, filter, and track workflow executions and their statuses
        </p>
      </div>

      {/* Filter Controls */}
      <RunsFilterBar
        status={status}
        onStatusChange={handleStatusChange}
        workflowName={workflowName}
        onWorkflowChange={handleWorkflowChange}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        limit={limit}
        onLimitChange={handleLimitChange}
        onRefresh={() => refetch()}
        isFetching={isFetching}
      />

      {/* Error Alert */}
      {isError && (
        <div
          role="alert"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-900"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-rose-600" />
            <span className="text-sm font-medium">
              Failed to load workflow runs: {(error as Error)?.message || 'Unknown error'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="self-start sm:self-auto rounded-md bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-800 hover:bg-rose-200 transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Runs Table */}
      <div className="rounded-xl border border-neutral-200 bg-white shadow-xs overflow-hidden">
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
                  Trigger
                </th>
                <th scope="col" className="px-6 py-3">
                  Status
                </th>
                <th scope="col" className="px-6 py-3">
                  Started
                </th>
                <th scope="col" className="px-6 py-3">
                  Duration
                </th>
                <th scope="col" className="px-6 py-3">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-neutral-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="h-4 w-4 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
                      <span>Loading runs...</span>
                    </div>
                  </td>
                </tr>
              ) : displayedRuns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-neutral-500">
                    No runs found matching the selected filters.
                  </td>
                </tr>
              ) : (
                displayedRuns.map((run) => (
                  <tr key={run.id} className="hover:bg-neutral-50/70 transition-colors">
                    <td className="px-6 py-4 font-mono text-xs font-medium text-neutral-900">
                      <Link
                        href={`/runs/${run.id}`}
                        className="text-indigo-600 hover:text-indigo-800 hover:underline font-semibold"
                      >
                        {run.id}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Workflow className="h-4 w-4 text-indigo-400 shrink-0" />
                        <span className="font-medium text-neutral-900">{run.workflowName}</span>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono bg-neutral-100 text-neutral-600 border border-neutral-200">
                          v{run.workflowVersion}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center gap-1 text-xs text-neutral-700">
                        <span className="font-medium">{run.triggerType}</span>
                        {run.triggerEventId && (
                          <span className="font-mono text-neutral-500 text-[11px]">
                            ({run.triggerEventId})
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-6 py-4 text-xs text-neutral-500">
                      {formatDate(run.startedAt)}
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-neutral-600">
                      {formatDuration(
                        run.startedAt,
                        run.completedAt,
                        run.failedAt,
                        run.cancelledAt
                      )}
                    </td>
                    <td className="px-6 py-4 text-xs text-neutral-500">
                      {formatDate(run.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="flex items-center justify-between border-t border-neutral-100 bg-neutral-50/50 px-6 py-3 text-xs text-neutral-600">
          <div>
            Showing {runs.length > 0 ? offset + 1 : 0} to {offset + runs.length} executions
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrevious}
              disabled={!canPrev}
              className={`inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium ${
                canPrev
                  ? 'text-neutral-700 hover:bg-neutral-50 cursor-pointer'
                  : 'text-neutral-300 cursor-not-allowed bg-neutral-50'
              }`}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Previous</span>
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={!canNext}
              className={`inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium ${
                canNext
                  ? 'text-neutral-700 hover:bg-neutral-50 cursor-pointer'
                  : 'text-neutral-300 cursor-not-allowed bg-neutral-50'
              }`}
            >
              <span>Next</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
