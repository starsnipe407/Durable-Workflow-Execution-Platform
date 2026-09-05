import type { PrismaClient } from "@durable/database";
import { claimStepAttempt, completeStepAttempt } from "@durable/database";
import { DuplicateStepKeyError, WorkflowSuspendedError } from "./errors.js";
import type { StepContext, StepOptions } from "./types.js";

export interface StepContextOptions {
  db: PrismaClient;
  tenantId: string;
  workflowRunId: string;
  workerId: string;
  leaseDurationMs: number;
  seenKeys: Set<string>;
}

export class StepContextImpl implements StepContext {
  private readonly db: PrismaClient;
  private readonly tenantId: string;
  private readonly workflowRunId: string;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly seenKeys: Set<string>;

  constructor(options: StepContextOptions) {
    this.db = options.db;
    this.tenantId = options.tenantId;
    this.workflowRunId = options.workflowRunId;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs;
    this.seenKeys = options.seenKeys;
  }

  run<T>(key: string, handler: () => Promise<T>): Promise<T>;
  run<T>(key: string, options: StepOptions, handler: () => Promise<T>): Promise<T>;
  async run<T>(
    key: string,
    optionsOrHandler: StepOptions | (() => Promise<T>),
    maybeHandler?: () => Promise<T>
  ): Promise<T> {
    if (this.seenKeys.has(key)) {
      throw new DuplicateStepKeyError(key);
    }
    this.seenKeys.add(key);

    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler!;
    const options = typeof optionsOrHandler === "object" ? optionsOrHandler : {};

    return await this.executeStep<T>(key, options, handler);
  }

  protected async executeStep<T>(key: string, _options: StepOptions, handler: () => Promise<T>): Promise<T> {
    const claim = await claimStepAttempt(this.db, {
      tenantId: this.tenantId,
      workflowRunId: this.workflowRunId,
      stepKey: key,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs
    });

    if (claim.status === "COMPLETED") {
      return claim.output as T;
    }

    if (claim.status === "LOCKED") {
      throw new WorkflowSuspendedError(`Step "${key}" is currently locked by attempt ${claim.activeAttemptId}.`);
    }

    if (claim.status === "RETRY_WAIT") {
      throw new WorkflowSuspendedError(`Step "${key}" is in RETRY_WAIT until ${claim.nextRetryAt.toISOString()}.`);
    }

    // Execute user handler OUTSIDE database transaction
    const output = await handler();

    // Commit with fencing
    await completeStepAttempt(this.db, {
      tenantId: this.tenantId,
      workflowRunId: this.workflowRunId,
      stepExecutionId: claim.stepExecutionId,
      attemptId: claim.attemptId,
      output
    });

    return output;
  }
}
