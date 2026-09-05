export class DuplicateStepKeyError extends Error {
  constructor(stepKey: string) {
    super(`Step key "${stepKey}" was invoked more than once in the same workflow run invocation. Step keys must be unique.`);
    this.name = "DuplicateStepKeyError";
  }
}

export class WorkflowSuspendedError extends Error {
  constructor(reason = "Workflow execution suspended waiting for step completion or retry.") {
    super(reason);
    this.name = "WorkflowSuspendedError";
  }
}
