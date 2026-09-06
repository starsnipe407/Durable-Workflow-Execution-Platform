import React from 'react';
import { CheckCircle2, Loader2, XCircle, Clock, AlertCircle, Ban } from 'lucide-react';
import type { WorkflowRunStatus, StepExecutionStatus } from '@/lib/types';

export interface StatusBadgeProps {
  status: string | WorkflowRunStatus | StepExecutionStatus;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  let colorStyle = 'bg-neutral-100 text-neutral-600 border-neutral-200';
  let Icon = Ban;

  switch (status) {
    case 'COMPLETED':
      colorStyle = 'bg-emerald-50 text-emerald-700 border-emerald-200';
      Icon = CheckCircle2;
      break;
    case 'RUNNING':
      colorStyle = 'bg-blue-50 text-blue-700 border-blue-200';
      Icon = Loader2;
      break;
    case 'FAILED':
      colorStyle = 'bg-rose-50 text-rose-700 border-rose-200';
      Icon = XCircle;
      break;
    case 'CANCEL_REQUESTED':
      colorStyle = 'bg-orange-50 text-orange-700 border-orange-200';
      Icon = AlertCircle;
      break;
    case 'CANCELLED':
      colorStyle = 'bg-neutral-100 text-neutral-600 border-neutral-200';
      Icon = Ban;
      break;
    case 'PENDING':
    case 'RETRY_WAIT':
      colorStyle = 'bg-amber-50 text-amber-700 border-amber-200';
      Icon = Clock;
      break;
    default:
      colorStyle = 'bg-neutral-100 text-neutral-600 border-neutral-200';
      Icon = AlertCircle;
      break;
  }

  const isRunning = status === 'RUNNING';

  return (
    <span
      data-testid={`status-badge-${status.toLowerCase()}`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border ${colorStyle} ${className}`.trim()}
    >
      <Icon className={`h-3 w-3 shrink-0 ${isRunning ? 'animate-spin' : ''}`} />
      {status}
    </span>
  );
}
