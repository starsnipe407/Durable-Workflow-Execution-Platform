'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Workflow, Zap, RefreshCw } from 'lucide-react';
import type { WorkflowsResponse, WorkflowDefinitionItem } from '@/lib/types';

function formatConcurrency(concurrency?: { globalLimit?: number; perKey: boolean }): string {
  if (!concurrency) return 'None';
  const parts: string[] = [];
  if (concurrency.globalLimit !== undefined && concurrency.globalLimit !== null) {
    parts.push(`Limit: ${concurrency.globalLimit}`);
  }
  if (concurrency.perKey) {
    parts.push('Per-Key');
  }
  return parts.length > 0 ? parts.join(', ') : 'None';
}

function formatLastRun(lastRunAt?: string | null): string {
  if (!lastRunAt) return 'Never';
  return new Date(lastRunAt).toLocaleString();
}

export default function WorkflowsPage() {
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery<WorkflowsResponse>({
    queryKey: ['workflows'],
    queryFn: async () => {
      const res = await fetch('/api/workflows');
      if (!res.ok) throw new Error(`Failed to fetch workflows: ${res.status}`);
      return res.json();
    },
  });

  const workflows: WorkflowDefinitionItem[] = data?.workflows || [];
  const filtered = workflows.filter((wf) =>
    wf.name.toLowerCase().includes(search.toLowerCase().trim())
  );

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
            Workflows Catalog
          </h1>
          <p className="text-sm text-neutral-500">
            Registered workflows, versions, event triggers, and concurrency rules
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 self-start sm:self-auto rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900 transition-colors shadow-2xs cursor-pointer"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search workflows..."
          className="w-full rounded-lg border border-neutral-300 bg-white py-2 pl-9 pr-4 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {/* Workflows Table */}
      <div className="rounded-xl border border-neutral-200 bg-white shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-100 bg-neutral-50 text-xs font-semibold uppercase text-neutral-500">
              <tr>
                <th scope="col" className="px-6 py-3">
                  Workflow Name
                </th>
                <th scope="col" className="px-6 py-3">
                  Versions
                </th>
                <th scope="col" className="px-6 py-3">
                  Triggers
                </th>
                <th scope="col" className="px-6 py-3">
                  Concurrency Policy
                </th>
                <th scope="col" className="px-6 py-3">
                  Total Runs
                </th>
                <th scope="col" className="px-6 py-3">
                  Last Run
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-neutral-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="h-4 w-4 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
                      <span>Loading workflows...</span>
                    </div>
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-rose-600">
                    Failed to load workflows: {(error as Error)?.message || 'Unknown error'}
                  </td>
                </tr>
              ) : workflows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-neutral-500">
                    No workflows registered yet.
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-neutral-500">
                    No workflows matching &quot;{search}&quot;.
                  </td>
                </tr>
              ) : (
                filtered.map((wf) => (
                  <tr key={wf.name} className="hover:bg-neutral-50/70 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Workflow className="h-4 w-4 text-indigo-500 shrink-0" />
                        <span className="font-semibold text-neutral-900">{wf.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {wf.versions && wf.versions.length > 0 ? (
                          wf.versions.map((ver) => (
                            <span
                              key={ver}
                              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-neutral-100 text-neutral-700 border border-neutral-200"
                            >
                              {ver}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-neutral-400 italic">None</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {wf.triggers && wf.triggers.length > 0 ? (
                          wf.triggers.map((trig, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-indigo-50 text-indigo-700 border border-indigo-200"
                            >
                              <Zap className="h-3 w-3" />
                              <span>
                                {trig.eventName} &rarr; {trig.workflowVersion}
                              </span>
                            </span>
                          ))
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs text-neutral-500 bg-neutral-100 border border-neutral-200">
                            Direct execution
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-xs font-medium text-neutral-700">
                      {formatConcurrency(wf.concurrency)}
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold text-neutral-900">
                      {wf.totalRuns}
                    </td>
                    <td className="px-6 py-4 text-xs text-neutral-500">
                      {formatLastRun(wf.lastRunAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
