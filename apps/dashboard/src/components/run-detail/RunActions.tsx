'use client';

import React, { useState } from 'react';
import { RotateCw, Ban, Loader2, AlertCircle } from 'lucide-react';
import type { WorkflowRun } from '@/lib/types';

export interface RunActionsProps {
  run: WorkflowRun;
  onActionSuccess?: () => void;
}

export function RunActions({ run, onActionSuccess }: RunActionsProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canRetry = run.status === 'FAILED';
  const canCancel = run.status === 'RUNNING' || run.status === 'PENDING';

  const handleRetry = async () => {
    if (!canRetry || isRetrying) return;
    setIsRetrying(true);
    setActionError(null);

    try {
      const res = await fetch(`/api/runs/${run.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Retry failed with status ${res.status}`);
      }

      onActionSuccess?.();
    } catch (err: any) {
      setActionError(err.message || 'Failed to retry run');
    } finally {
      setIsRetrying(false);
    }
  };

  const handleCancel = async () => {
    if (!canCancel || isCancelling) return;
    setIsCancelling(true);
    setActionError(null);

    try {
      const res = await fetch(`/api/runs/${run.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Cancel failed with status ${res.status}`);
      }

      setShowCancelConfirm(false);
      onActionSuccess?.();
    } catch (err: any) {
      setActionError(err.message || 'Failed to cancel run');
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
      {actionError && (
        <span className="text-xs text-rose-600 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {actionError}
        </span>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Retry Run"
          disabled={!canRetry || isRetrying}
          onClick={handleRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-white border-neutral-300 text-neutral-700 hover:bg-neutral-50 focus:outline-none"
        >
          {isRetrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" />
          ) : (
            <RotateCw className="h-3.5 w-3.5 text-neutral-500" />
          )}
          <span>Retry Run</span>
        </button>

        {showCancelConfirm ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Confirm Cancel"
              disabled={isCancelling}
              onClick={handleCancel}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 focus:outline-none transition-colors"
            >
              {isCancelling && <Loader2 className="h-3 w-3 animate-spin" />}
              <span>Confirm Cancel</span>
            </button>
            <button
              type="button"
              onClick={() => setShowCancelConfirm(false)}
              className="px-2 py-1.5 text-xs font-medium rounded-md text-neutral-600 hover:bg-neutral-100 focus:outline-none"
            >
              Abort
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Cancel Run"
            disabled={!canCancel || isCancelling}
            onClick={() => setShowCancelConfirm(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed border-rose-200 text-rose-700 bg-rose-50 hover:bg-rose-100 focus:outline-none"
          >
            {isCancelling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-600" />
            ) : (
              <Ban className="h-3.5 w-3.5 text-rose-600" />
            )}
            <span>Cancel Run</span>
          </button>
        )}
      </div>
    </div>
  );
}
