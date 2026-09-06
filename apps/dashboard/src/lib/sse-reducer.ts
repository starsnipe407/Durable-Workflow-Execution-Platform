import type { WorkflowRun, WorkflowExecutionEvent, StepExecution } from './types';

export function reduceRunEvent(run: WorkflowRun, event: WorkflowExecutionEvent): WorkflowRun {
  const { eventType, payload = {}, createdAt, stepExecutionId } = event;

  switch (eventType) {
    case 'STEP_STARTED': {
      const stepKey = payload.stepKey;
      const existingSteps = run.stepExecutions ? [...run.stepExecutions] : [];
      const index = existingSteps.findIndex(
        (s) => (stepExecutionId && s.id === stepExecutionId) || (stepKey && s.stepKey === stepKey)
      );

      if (index >= 0) {
        const step = existingSteps[index];
        existingSteps[index] = {
          ...step,
          status: 'RUNNING',
          startedAt: payload.startedAt || createdAt || step.startedAt,
          attemptCount: payload.attemptCount !== undefined ? payload.attemptCount : step.attemptCount,
        };
      } else {
        const newStep: StepExecution = {
          id: stepExecutionId || payload.stepExecutionId || `step-${Date.now()}`,
          stepKey: stepKey || 'unknown',
          status: 'RUNNING',
          retryLimit: payload.retryLimit ?? 3,
          attemptCount: payload.attemptCount !== undefined ? payload.attemptCount : 1,
          startedAt: payload.startedAt || createdAt,
          completedAt: null,
          stepAttempts: [],
        };
        existingSteps.push(newStep);
      }

      return {
        ...run,
        stepExecutions: existingSteps,
      };
    }

    case 'STEP_ATTEMPT_FAILED': {
      if (!run.stepExecutions) return run;
      const stepKey = payload.stepKey;
      const existingSteps = run.stepExecutions.map((step) => {
        if ((stepExecutionId && step.id === stepExecutionId) || (stepKey && step.stepKey === stepKey)) {
          const willRetry = !!payload.willRetry;
          return {
            ...step,
            status: willRetry ? ('RETRY_WAIT' as const) : ('FAILED' as const),
            error: payload.error !== undefined ? payload.error : payload.errorMessage,
            failedAt: payload.failedAt || createdAt || step.failedAt,
          };
        }
        return step;
      });

      return {
        ...run,
        stepExecutions: existingSteps,
      };
    }

    case 'STEP_RETRY_SCHEDULED': {
      if (!run.stepExecutions) return run;
      const stepKey = payload.stepKey;
      const existingSteps = run.stepExecutions.map((step) => {
        if ((stepExecutionId && step.id === stepExecutionId) || (stepKey && step.stepKey === stepKey)) {
          return {
            ...step,
            status: 'RETRY_WAIT' as const,
            nextRetryAt: payload.nextRetryAt ?? step.nextRetryAt,
          };
        }
        return step;
      });

      return {
        ...run,
        stepExecutions: existingSteps,
      };
    }

    case 'STEP_COMPLETED': {
      if (!run.stepExecutions) return run;
      const stepKey = payload.stepKey;
      const existingSteps = run.stepExecutions.map((step) => {
        if ((stepExecutionId && step.id === stepExecutionId) || (stepKey && step.stepKey === stepKey)) {
          return {
            ...step,
            status: 'COMPLETED' as const,
            completedAt: payload.completedAt || createdAt || step.completedAt,
            output: payload.output !== undefined ? payload.output : step.output,
          };
        }
        return step;
      });

      return {
        ...run,
        stepExecutions: existingSteps,
      };
    }

    case 'WORKFLOW_COMPLETED': {
      return {
        ...run,
        status: 'COMPLETED',
        completedAt: payload.completedAt || createdAt || run.completedAt,
        output: payload.output !== undefined ? payload.output : run.output,
      };
    }

    case 'WORKFLOW_FAILED': {
      return {
        ...run,
        status: 'FAILED',
        failedAt: payload.failedAt || createdAt || run.failedAt,
        error: payload.error !== undefined ? payload.error : run.error,
      };
    }

    case 'WORKFLOW_CANCEL_REQUESTED': {
      return {
        ...run,
        status: 'CANCEL_REQUESTED',
        cancelRequestedAt: createdAt || run.cancelRequestedAt,
      };
    }

    case 'WORKFLOW_CANCELLED': {
      return {
        ...run,
        status: 'CANCELLED',
        cancelledAt: createdAt || run.cancelledAt,
      };
    }

    default:
      return run;
  }
}
