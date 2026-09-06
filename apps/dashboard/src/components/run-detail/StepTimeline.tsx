'use client';

import React, { useState, useMemo } from 'react';
import { Layers, ChevronDown, ChevronRight, Clock, RefreshCw } from 'lucide-react';
import { StatusBadge } from '@/components/runs/StatusBadge';
import { AttemptInspector } from './AttemptInspector';
import type { StepExecution } from '@/lib/types';

export interface StepTimelineProps {
  stepExecutions: StepExecution[];
}

function formatDuration(startedAt?: string | null, completedAt?: string | null, failedAt?: string | null): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = completedAt || failedAt ? new Date((completedAt || failedAt)!).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  return `${sec}s`;
}

function formatTime(dateStr?: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleTimeString();
}

export function StepTimeline({ stepExecutions }: StepTimelineProps) {
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});

  const toggleStep = (id: string) => {
    setExpandedSteps((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Sort steps chronologically
  const sortedSteps = useMemo(() => {
    return [...(stepExecutions || [])].sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return aTime - bTime;
    });
  }, [stepExecutions]);

  // Concurrency analysis: identify steps that overlap in execution time
  const concurrentStepIds = useMemo(() => {
    const concurrentIds = new Set<string>();
    const windows = sortedSteps.map((step) => {
      const start = step.startedAt ? new Date(step.startedAt).getTime() : 0;
      let end = start;
      if (step.completedAt) {
        end = new Date(step.completedAt).getTime();
      } else if (step.failedAt) {
        end = new Date(step.failedAt).getTime();
      } else if (step.status === 'RUNNING') {
        end = Date.now();
      }
      return { id: step.id, start, end };
    });

    for (let i = 0; i < windows.length; i++) {
      for (let j = 0; j < windows.length; j++) {
        if (i === j) continue;
        const w1 = windows[i];
        const w2 = windows[j];
        if (w1.start < w2.end && w1.end > w2.start) {
          concurrentIds.add(w1.id);
          break;
        }
      }
    }

    return concurrentIds;
  }, [sortedSteps]);

  if (sortedSteps.length === 0) {
    return (
      <div className="p-8 text-center bg-white rounded-lg border border-neutral-200 text-neutral-500 text-sm">
        No steps executed yet for this workflow run.
      </div>
    );
  }

  return (
    <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-3 before:bottom-3 before:w-0.5 before:bg-neutral-200">
      {sortedSteps.map((step, idx) => {
        const isExpanded = !!expandedSteps[step.id];
        const isConcurrent = concurrentStepIds.has(step.id);
        const attemptCount = step.attemptCount || step.stepAttempts?.length || 1;
        const duration = formatDuration(step.startedAt, step.completedAt, step.failedAt);

        return (
          <div
            key={step.id}
            data-testid="timeline-step-item"
            className="relative bg-white rounded-lg border border-neutral-200 shadow-xs overflow-hidden transition-all"
          >
            {/* Timeline node icon on the vertical line */}
            <div className="absolute -left-6.5 top-4 w-3.5 h-3.5 rounded-full border-2 border-white bg-neutral-400 shadow-xs ring-4 ring-neutral-100" />

            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    data-testid="step-key"
                    className="font-mono text-sm font-semibold text-neutral-900"
                  >
                    {step.stepKey}
                  </span>
                  <StatusBadge status={step.status} />
                  {isConcurrent && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200">
                      <Layers className="h-3 w-3" />
                      Concurrent
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-neutral-100 text-neutral-700 border border-neutral-200">
                    {attemptCount} {attemptCount === 1 ? 'attempt' : 'attempts'}
                  </span>

                  <button
                    type="button"
                    aria-label="toggle-attempts"
                    onClick={() => toggleStep(step.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-50 hover:bg-neutral-100 rounded border border-neutral-200 focus:outline-none transition-colors"
                  >
                    {isExpanded ? (
                      <>
                        <ChevronDown className="h-3.5 w-3.5" />
                        <span>Hide Attempts</span>
                      </>
                    ) : (
                      <>
                        <ChevronRight className="h-3.5 w-3.5" />
                        <span>Inspect Attempts</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-500">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3 text-neutral-400" />
                  <span>Duration: {duration}</span>
                </span>

                {step.startedAt && (
                  <span>Started: {formatTime(step.startedAt)}</span>
                )}

                {step.completedAt && (
                  <span>Completed: {formatTime(step.completedAt)}</span>
                )}

                {step.status === 'RETRY_WAIT' && step.nextRetryAt && (
                  <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                    <RefreshCw className="h-3 w-3 animate-spin text-amber-600" />
                    <span>Next retry: {formatTime(step.nextRetryAt)}</span>
                  </span>
                )}
              </div>

              {step.error ? (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs font-mono">
                  {typeof step.error === 'string'
                    ? step.error
                    : (step.error as any).message || JSON.stringify(step.error)}
                </div>
              ) : null}

              {isExpanded && (
                <div className="mt-2 pt-2 border-t border-neutral-100">
                  <AttemptInspector
                    stepAttempts={step.stepAttempts}
                    error={step.error}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
