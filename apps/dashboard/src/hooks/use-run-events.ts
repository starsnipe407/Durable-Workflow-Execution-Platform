'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { reduceRunEvent } from '@/lib/sse-reducer';
import type { WorkflowRun, WorkflowRunStatus, WorkflowExecutionEvent } from '@/lib/types';

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);
const TERMINAL_EVENTS = new Set(['WORKFLOW_COMPLETED', 'WORKFLOW_FAILED', 'WORKFLOW_CANCELLED']);

export function useRunEvents(runId?: string, runStatus?: WorkflowRunStatus): { isConnected: boolean } {
  const [isConnected, setIsConnected] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!runId || (runStatus && TERMINAL_STATUSES.has(runStatus))) {
      setIsConnected(false);
      return;
    }

    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    const eventSource = new EventSource(`/api/runs/${runId}/events`);

    eventSource.onopen = () => {
      setIsConnected(true);
    };

    eventSource.onmessage = (e) => {
      try {
        const event: WorkflowExecutionEvent = JSON.parse(e.data);

        queryClient.setQueryData<WorkflowRun>(['run', runId], (prev) =>
          prev ? reduceRunEvent(prev, event) : prev
        );

        if (TERMINAL_EVENTS.has(event.eventType)) {
          setIsConnected(false);
          eventSource.close();
          queryClient.invalidateQueries({ queryKey: ['run', runId] });
        }
      } catch (err) {
        console.error('Failed to process run SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      eventSource.close();
    };

    return () => {
      setIsConnected(false);
      eventSource.close();
    };
  }, [runId, runStatus, queryClient]);

  return { isConnected };
}
