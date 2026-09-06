'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Clock,
  Radio,
  Tag,
  KeyRound,
  AlertTriangle,
  Workflow,
} from 'lucide-react';
import { StatusBadge } from '@/components/runs/StatusBadge';
import { StepTimeline } from '@/components/run-detail/StepTimeline';
import { JsonViewer } from '@/components/run-detail/JsonViewer';
import { RunActions } from '@/components/run-detail/RunActions';
import { useRunEvents } from '@/hooks/use-run-events';
import type { WorkflowRun } from '@/lib/types';

interface PageProps {
  params?: Promise<{ id: string }> | { id: string };
}

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

function RunDetailSkeleton() {
  return (
    <div className="space-y-6 max-w-7xl mx-auto animate-pulse">
      <div className="h-8 w-48 bg-neutral-200 rounded" />
      <div className="h-32 bg-white rounded-lg border border-neutral-200 p-6 space-y-4">
        <div className="h-6 w-96 bg-neutral-200 rounded" />
        <div className="h-4 w-64 bg-neutral-100 rounded" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 h-96 bg-white rounded-lg border border-neutral-200" />
        <div className="lg:col-span-2 space-y-4">
          <div className="h-44 bg-white rounded-lg border border-neutral-200" />
          <div className="h-44 bg-white rounded-lg border border-neutral-200" />
        </div>
      </div>
    </div>
  );
}

export default function RunDetailPage(props: PageProps) {
  const routerParams = useParams();
  const isPromise = props.params && typeof (props.params as any).then === 'function';

  const [asyncId, setAsyncId] = useState<string | null>(() => {
    if (props.params && !isPromise) {
      return (props.params as { id: string }).id || null;
    }
    return null;
  });

  useEffect(() => {
    let active = true;
    if (isPromise) {
      (props.params as Promise<{ id: string }>).then((resolved) => {
        if (active && resolved?.id) {
          setAsyncId(resolved.id);
        }
      });
    }
    return () => {
      active = false;
    };
  }, [props.params, isPromise]);

  let id = '';
  if (isPromise) {
    id = asyncId || '';
  } else if (props.params && (props.params as { id: string }).id) {
    id = (props.params as { id: string }).id;
  } else if (routerParams?.id) {
    id = Array.isArray(routerParams.id) ? routerParams.id[0] : routerParams.id;
  }

  const {
    data: run,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<WorkflowRun>({
    queryKey: ['run', id],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${id}`);
      if (!res.ok) {
        throw new Error(res.status === 404 ? 'Run not found' : `Failed to fetch run: ${res.status}`);
      }
      return res.json();
    },
    enabled: !!id,
  });

  const { isConnected } = useRunEvents(id, run?.status);

  if (!id || isLoading) {
    return <RunDetailSkeleton />;
  }

  if (isError || !run) {
    return (
      <div className="max-w-xl mx-auto text-center py-16 space-y-4">
        <div className="inline-flex p-3 rounded-full bg-rose-50 border border-rose-200 text-rose-600">
          <AlertTriangle className="h-8 w-8" />
        </div>
        <h1 className="text-xl font-bold text-neutral-900">
          {error instanceof Error ? error.message : 'Run not found'}
        </h1>
        <p className="text-sm text-neutral-500">
          Could not retrieve details for workflow run ID <span className="font-mono">{id}</span>.
        </p>
        <div>
          <Link
            href="/runs"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-md bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Runs
          </Link>
        </div>
      </div>
    );
  }

  const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status);
  const duration = formatDuration(run.startedAt, run.completedAt, run.failedAt, run.cancelledAt);

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Top navigation */}
      <div className="flex items-center justify-between">
        <Link
          href="/runs"
          className="inline-flex items-center gap-1 text-sm font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Runs</span>
        </Link>

        {/* Live SSE or Terminal indicator */}
        <div className="flex items-center gap-2">
          {isTerminal ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full bg-neutral-100 text-neutral-600 border border-neutral-200">
              <span className="w-2 h-2 rounded-full bg-neutral-400" />
              Terminal
            </span>
          ) : isConnected ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <Radio className="h-3 w-3" />
              Live SSE Streaming
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              Connecting...
            </span>
          )}
        </div>
      </div>

      {/* Flagship Header Card */}
      <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-xs space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold font-mono text-neutral-900 tracking-tight">
                {run.id}
              </h1>
              <StatusBadge status={run.status} />
              <span className="px-2 py-0.5 rounded text-xs font-semibold bg-neutral-100 text-neutral-700 border border-neutral-200">
                v{run.workflowVersion}
              </span>
            </div>

            <div className="flex items-center gap-2 text-sm text-neutral-600">
              <Workflow className="h-4 w-4 text-neutral-400 shrink-0" />
              <span className="font-semibold text-neutral-800">{run.workflowName}</span>
              <span className="text-neutral-400">•</span>
              <span>Attempt #{run.workflowAttempt}</span>
            </div>
          </div>

          <RunActions run={run} onActionSuccess={() => refetch()} />
        </div>

        {/* Metadata Badges Bar */}
        <div className="pt-3 border-t border-neutral-100 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-neutral-600">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-neutral-400" />
            <span className="font-medium text-neutral-800">Duration:</span>
            <span>{duration}</span>
          </div>

          {run.startedAt && (
            <div className="flex items-center gap-1">
              <span className="font-medium text-neutral-800">Started:</span>
              <span>{formatDate(run.startedAt)}</span>
            </div>
          )}

          {(run.completedAt || run.failedAt || run.cancelledAt) && (
            <div className="flex items-center gap-1">
              <span className="font-medium text-neutral-800">Finished:</span>
              <span>{formatDate(run.completedAt || run.failedAt || run.cancelledAt)}</span>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <Tag className="h-3.5 w-3.5 text-neutral-400" />
            <span className="font-medium text-neutral-800">Trigger:</span>
            <span className="font-mono bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-700">
              {run.triggerType === 'EVENT' ? `EVENT: ${run.triggerEventId || 'unknown'}` : 'DIRECT'}
            </span>
          </div>

          {run.concurrencyKey && (
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 text-neutral-400" />
              <span className="font-medium text-neutral-800">Concurrency:</span>
              <span className="font-mono bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-700">
                Key: {run.concurrencyKey}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Main Grid: Step Timeline & JSON Viewers */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        {/* Left Column (3 spans): Step Timeline */}
        <div className="lg:col-span-3 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-neutral-900">Execution Timeline</h2>
            <span className="text-xs text-neutral-500">
              {run.stepExecutions?.length || 0} {(run.stepExecutions?.length || 0) === 1 ? 'step' : 'steps'}
            </span>
          </div>

          <StepTimeline stepExecutions={run.stepExecutions || []} />
        </div>

        {/* Right Column (2 spans): JSON Viewers */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-base font-semibold text-neutral-900">Run Payloads</h2>

          <JsonViewer title="Input Payload" data={run.input} defaultExpanded={true} />

          {run.output !== undefined && run.output !== null && (
            <JsonViewer title="Output Payload" data={run.output} defaultExpanded={true} />
          )}

          {run.error !== undefined && run.error !== null && (
            <JsonViewer title="Error Details" data={run.error} defaultExpanded={true} />
          )}
        </div>
      </div>
    </div>
  );
}
