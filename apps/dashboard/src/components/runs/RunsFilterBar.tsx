'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, RefreshCw } from 'lucide-react';
import type { WorkflowsResponse } from '@/lib/types';

export interface RunsFilterBarProps {
  status: string;
  onStatusChange: (status: string) => void;
  workflowName: string;
  onWorkflowChange: (workflow: string) => void;
  searchQuery: string;
  onSearchChange: (search: string) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
  onRefresh: () => void;
  isFetching?: boolean;
}

const STATUS_OPTIONS = ['ALL', 'RUNNING', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'];
const LIMIT_OPTIONS = [10, 20, 50];

export function RunsFilterBar({
  status,
  onStatusChange,
  workflowName,
  onWorkflowChange,
  searchQuery,
  onSearchChange,
  limit,
  onLimitChange,
  onRefresh,
  isFetching = false,
}: RunsFilterBarProps) {
  const { data: workflowsData } = useQuery<WorkflowsResponse>({
    queryKey: ['workflows'],
    queryFn: async () => {
      const res = await fetch('/api/workflows');
      if (!res.ok) throw new Error(`Failed to fetch workflows: ${res.status}`);
      return res.json();
    },
  });

  const workflows = workflowsData?.workflows || [];

  return (
    <div className="space-y-4">
      {/* Top Filter Controls: Workflow Dropdown, Search Input, Limit Selector, Refresh Button */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="relative min-w-[220px] max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              aria-label="Search runs"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search by run ID or workflow..."
              className="w-full rounded-lg border border-neutral-300 bg-white py-1.5 pl-9 pr-3 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Workflow Filter Dropdown */}
          <div className="w-48">
            <select
              aria-label="Workflow"
              value={workflowName}
              onChange={(e) => onWorkflowChange(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 bg-white py-1.5 px-2.5 text-xs text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">All Workflows</option>
              {workflows.map((wf) => (
                <option key={wf.name} value={wf.name}>
                  {wf.name}
                </option>
              ))}
            </select>
          </div>

          {/* Page Limit Selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-neutral-500 font-medium">Show:</span>
            <select
              aria-label="Page Size"
              value={limit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
              className="rounded-lg border border-neutral-300 bg-white py-1.5 px-2 text-xs text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {LIMIT_OPTIONS.map((lim) => (
                <option key={lim} value={lim}>
                  {lim}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Refresh Button */}
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh"
          className="inline-flex items-center gap-1.5 self-start sm:self-auto rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900 transition-colors shadow-2xs cursor-pointer"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Status Pills */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-neutral-500 mr-1">Status:</span>
        {STATUS_OPTIONS.map((opt) => {
          const isActive = status === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onStatusChange(opt)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
                isActive
                  ? 'bg-indigo-600 text-white shadow-2xs'
                  : 'bg-white text-neutral-600 border border-neutral-200 hover:bg-neutral-50 hover:text-neutral-900'
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
