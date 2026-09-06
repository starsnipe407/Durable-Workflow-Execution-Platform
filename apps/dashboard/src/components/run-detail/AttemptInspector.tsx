'use client';

import React, { useState } from 'react';
import { AlertCircle, Clock, Server, ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react';
import { StatusBadge } from '@/components/runs/StatusBadge';
import type { StepAttempt } from '@/lib/types';

export interface AttemptInspectorProps {
  stepAttempts?: StepAttempt[];
  error?: unknown;
}

function formatDuration(startedAt: string, finishedAt?: string | null): string {
  if (!finishedAt) return 'running';
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleTimeString();
}

export function AttemptInspector({ stepAttempts, error }: AttemptInspectorProps) {
  const [expandedMeta, setExpandedMeta] = useState<Record<string, boolean>>({});

  const toggleMeta = (id: string) => {
    setExpandedMeta((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const sortedAttempts = [...(stepAttempts || [])].sort((a, b) => a.attemptNumber - b.attemptNumber);

  if (sortedAttempts.length === 0) {
    return (
      <div className="p-3 text-xs text-neutral-500 bg-neutral-50 rounded border border-neutral-200">
        No attempt history recorded for this step.
        {error ? (
          <div className="mt-2 text-rose-600 font-mono">
            {typeof error === 'string' ? error : JSON.stringify(error)}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
        Attempt History ({sortedAttempts.length})
      </div>

      <div className="space-y-2">
        {sortedAttempts.map((attempt) => {
          const isMetaOpen = !!expandedMeta[attempt.id];
          const hasMeta = !!attempt.errorMetadata;

          return (
            <div
              key={attempt.id}
              className="p-3 rounded-lg border border-neutral-200 bg-neutral-50/50 space-y-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-neutral-800">
                    Attempt #{attempt.attemptNumber}
                  </span>
                  <StatusBadge status={attempt.status} />
                </div>

                <div className="flex items-center gap-3 text-neutral-500">
                  {attempt.workerId && (
                    <span className="inline-flex items-center gap-1 font-mono text-neutral-600">
                      <Server className="h-3 w-3" />
                      {attempt.workerId}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDate(attempt.startedAt)}
                    {attempt.finishedAt ? ` → ${formatDate(attempt.finishedAt)}` : ''}
                    <span className="text-neutral-400">({formatDuration(attempt.startedAt, attempt.finishedAt)})</span>
                  </span>
                </div>
              </div>

              {(attempt.errorType || attempt.errorMessage) && (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 font-mono space-y-1">
                  <div className="flex items-center gap-1 font-semibold">
                    <AlertCircle className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                    <span>{attempt.errorType || 'Error'}</span>
                  </div>
                  {attempt.errorMessage && (
                    <div className="pl-4 text-rose-700 whitespace-pre-wrap">{attempt.errorMessage}</div>
                  )}

                  {hasMeta && (
                    <div className="pt-1 pl-4">
                      <button
                        type="button"
                        aria-label="view-error-metadata"
                        onClick={() => toggleMeta(attempt.id)}
                        className="inline-flex items-center gap-1 text-xs text-rose-700 hover:text-rose-900 underline focus:outline-none"
                      >
                        {isMetaOpen ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        Error Metadata
                      </button>

                      {isMetaOpen && (
                        <pre className="mt-1 p-2 bg-rose-950 text-rose-100 rounded text-[11px] overflow-x-auto">
                          {JSON.stringify(attempt.errorMetadata, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}

              {attempt.retryDelayMs !== undefined && attempt.retryDelayMs !== null && (
                <div className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-medium">
                  <CornerDownRight className="h-3 w-3 text-amber-500" />
                  <span>Backoff: {attempt.retryDelayMs}ms</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
