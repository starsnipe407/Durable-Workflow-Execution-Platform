# Ticket 02: Database Schema and Fenced Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Establish the PostgreSQL persistence layer (packages/database) using Prisma for schema definitions and migrations, coupled with encapsulated raw SQL transactional operations that enforce atomic attempt claiming, lease renewal, fenced commit completion (ctive_attempt_id check), and durable execution event appending.

**Architecture:** A standalone @durable/database package. Prisma Client handles standard models and migrations. Invariant-critical state mutations are implemented in a repository module (step-repository.ts and workflow-repository.ts) using audited PostgreSQL transactions ($executeRaw / $queryRaw) with row-level locks and conditional update fencing to guarantee zero race conditions.

**Tech Stack:** TypeScript 5.8+, Prisma 6+, PostgreSQL 16, Vitest 3+, Node.js 22+.

## Global Constraints

- Monorepo package: packages/database (@durable/database).
- Module format: ESM-first ("type": "module").
- Persistence engine: PostgreSQL 16 (test instance at postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public).
- Short-lived DB transactions: Database transactions MUST NOT be held open during step execution. Fencing must use conditional WHERE id =  AND active_attempt_id = . If zero rows updated, throw StaleAttemptError.
- Atomic event recording: State transitions and their execution events (STEP_STARTED, STEP_COMPLETED, etc.) must commit in the same transaction.

---

## Producer-to-Consumer Interface Check (Downstream: Ticket 03)

**Downstream consumer:** Ticket 03 (packages/workflow-sdk) consumes:
1. createWorkflowRun(db, params) -> returns created run with initial PENDING status.
2. claimStepAttempt(db, params) -> checks lease & memoization; if runnable, creates attempt, sets ctive_attempt_id, commits immediately, returns { status: "RUNNING", attemptId, ... } or { status: "COMPLETED", output } or { status: "LOCKED" }.
3. completeStepAttempt(db, params) -> executes conditional update WHERE active_attempt_id = attemptId, appends STEP_COMPLETED event; if 0 rows updated, throws StaleAttemptError.
4. enewAttemptLease(db, params) -> updates lease_expires_at and heartbeat_at.
5. ecordExecutionEvent(db, params) -> appends row to execution_events.
6. Error classes: StaleAttemptError.

This interface satisfies all requirements of Ticket 03 without leaking implementation details or requiring long-running locks.

---

## File Structure

- packages/database/package.json: Manifest for @durable/database with Prisma dependencies and scripts (uild, 	est, db:migrate).
- packages/database/tsconfig.json: TypeScript configuration extending root.
- packages/database/prisma/schema.prisma: Authoritative PostgreSQL schema definition.
- packages/database/src/client.ts: PrismaClient instantiation and connection factory.
- packages/database/src/errors.ts: StaleAttemptError and database domain error classes.
- packages/database/src/types.ts: TypeScript interfaces for database parameters and returned records.
- packages/database/src/repositories/execution-events.ts: ecordExecutionEvent() helper.
- packages/database/src/repositories/step-repository.ts: claimStepAttempt(), completeStepAttempt(), and enewAttemptLease().
- packages/database/src/repositories/workflow-repository.ts: createWorkflowRun(), getWorkflowRun(), completeWorkflowRun().
- packages/database/src/index.ts: Public package entrypoint.
- packages/database/test/fenced-persistence.test.ts: Integration test verifying claim, lease fencing, and event persistence against PostgreSQL.

---

### Task 1: Package Scaffolding and Prisma Schema Migration

**Files:**
- Create: packages/database/package.json
- Create: packages/database/tsconfig.json
- Create: packages/database/prisma/schema.prisma
- Create: packages/database/src/client.ts

**Interfaces:**
- Consumes: None
- Produces: PrismaClient connected to test PostgreSQL database with migrated schema.

- [ ] **Step 1: Create packages/database/package.json**

`json
{
  "name": "@durable/database",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "prisma generate && tsc --build",
    "test": "vitest run",
    "db:migrate": "dotenv -e ../../.env.test -- prisma migrate dev"
  },
  "dependencies": {
    "@prisma/client": "^6.4.1"
  },
  "devDependencies": {
    "dotenv-cli": "^8.0.0",
    "prisma": "^6.4.1",
    "typescript": "^5.8.2",
    "vitest": "^3.0.7"
  }
}
`

- [ ] **Step 2: Create packages/database/tsconfig.json**

`json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
`

- [ ] **Step 3: Create packages/database/prisma/schema.prisma**

`prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum WorkflowRunStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  CANCEL_REQUESTED
  CANCELLED
}

enum StepExecutionStatus {
  PENDING
  RUNNING
  COMPLETED
  RETRY_WAIT
  FAILED
}

enum StepAttemptStatus {
  RUNNING
  COMPLETED
  FAILED
  ABANDONED
  TIMED_OUT
}

enum TriggerType {
  DIRECT
  EVENT
}

enum IdempotencyStatus {
  IN_PROGRESS
  COMPLETED
}

model Tenant {
  id         String   @id @default(uuid()) @db.Uuid
  name       String
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  apiKeys             ApiKey[]
  workflowDefinitions WorkflowDefinition[]
  workflowRuns        WorkflowRun[]
  stepExecutions      StepExecution[]
  stepAttempts        StepAttempt[]
  ingestedEvents      IngestedEvent[]
  eventBindings       WorkflowEventBinding[]
  executionEvents     ExecutionEvent[]
  idempotencyKeys     IdempotencyKey[]

  @@map("tenants")
}

model ApiKey {
  id         String    @id @default(uuid()) @db.Uuid
  tenantId   String    @map("tenant_id") @db.Uuid
  keyHash    String    @unique @map("key_hash")
  label      String
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz
  revokedAt  DateTime? @map("revoked_at") @db.Timestamptz
  lastUsedAt DateTime? @map("last_used_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("api_keys")
}

model WorkflowDefinition {
  id           String    @id @default(uuid()) @db.Uuid
  tenantId     String    @map("tenant_id") @db.Uuid
  name         String
  version      String
  isActive     Boolean   @default(true) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz
  registeredAt DateTime? @map("registered_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, name, version])
  @@map("workflow_definitions")
}

model WorkflowRun {
  id                    String            @id @default(uuid()) @db.Uuid
  tenantId              String            @map("tenant_id") @db.Uuid
  workflowName          String            @map("workflow_name")
  workflowVersion       String            @map("workflow_version")
  status                WorkflowRunStatus @default(PENDING)
  input                 Json
  output                Json?
  error                 Json?
  workflowAttempt       Int               @default(1) @map("workflow_attempt")
  triggerType           TriggerType       @default(DIRECT) @map("trigger_type")
  triggerEventId        String?           @map("trigger_event_id") @db.Uuid
  concurrencyKey        String?           @map("concurrency_key")
  blockedReason         String?           @map("blocked_reason")
  requestIdempotencyKey String?           @map("request_idempotency_key")
  startedAt             DateTime?         @map("started_at") @db.Timestamptz
  completedAt           DateTime?         @map("completed_at") @db.Timestamptz
  failedAt              DateTime?         @map("failed_at") @db.Timestamptz
  cancelRequestedAt     DateTime?         @map("cancel_requested_at") @db.Timestamptz
  cancelledAt           DateTime?         @map("cancelled_at") @db.Timestamptz
  createdAt             DateTime          @default(now()) @map("created_at") @db.Timestamptz
  updatedAt             DateTime          @updatedAt @map("updated_at") @db.Timestamptz

  tenant          Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  stepExecutions  StepExecution[]
  executionEvents ExecutionEvent[]

  @@unique([tenantId, requestIdempotencyKey])
  @@index([tenantId, createdAt(sort: Desc)])
  @@index([tenantId, status])
  @@index([workflowName, workflowVersion, status])
  @@map("workflow_runs")
}

model StepExecution {
  id              String              @id @default(uuid()) @db.Uuid
  tenantId        String              @map("tenant_id") @db.Uuid
  workflowRunId   String              @map("workflow_run_id") @db.Uuid
  stepKey         String              @map("step_key")
  status          StepExecutionStatus @default(PENDING)
  input           Json?
  output          Json?
  error           Json?
  retryLimit      Int                 @default(3) @map("retry_limit")
  timeoutMs       Int?                @map("timeout_ms")
  idempotencyKey  String?             @map("idempotency_key")
  attemptCount    Int                 @default(0) @map("attempt_count")
  activeAttemptId String?             @map("active_attempt_id") @db.Uuid
  nextRetryAt     DateTime?           @map("next_retry_at") @db.Timestamptz
  createdAt       DateTime            @default(now()) @map("created_at") @db.Timestamptz
  startedAt       DateTime?           @map("started_at") @db.Timestamptz
  completedAt     DateTime?           @map("completed_at") @db.Timestamptz
  failedAt        DateTime?           @map("failed_at") @db.Timestamptz
  updatedAt       DateTime            @updatedAt @map("updated_at") @db.Timestamptz

  tenant          Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  workflowRun     WorkflowRun      @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  stepAttempts    StepAttempt[]
  executionEvents ExecutionEvent[]
  idempotencyKeys IdempotencyKey[]

  @@unique([workflowRunId, stepKey])
  @@map("step_executions")
}

model StepAttempt {
  id              String            @id @default(uuid()) @db.Uuid
  tenantId        String            @map("tenant_id") @db.Uuid
  stepExecutionId String            @map("step_execution_id") @db.Uuid
  attemptNumber   Int               @map("attempt_number")
  status          StepAttemptStatus @default(RUNNING)
  workerId        String?           @map("worker_id")
  startedAt       DateTime          @default(now()) @map("started_at") @db.Timestamptz
  finishedAt      DateTime?         @map("finished_at") @db.Timestamptz
  heartbeatAt     DateTime?         @map("heartbeat_at") @db.Timestamptz
  leaseExpiresAt  DateTime?         @map("lease_expires_at") @db.Timestamptz
  errorType       String?           @map("error_type")
  errorMessage    String?           @map("error_message")
  errorMetadata   Json?             @map("error_metadata")
  retryDelayMs    Int?              @map("retry_delay_ms")
  timedOut        Boolean           @default(false) @map("timed_out")
  createdAt       DateTime          @default(now()) @map("created_at") @db.Timestamptz

  tenant          Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  stepExecution   StepExecution    @relation(fields: [stepExecutionId], references: [id], onDelete: Cascade)
  executionEvents ExecutionEvent[]

  @@unique([stepExecutionId, attemptNumber])
  @@index([status, leaseExpiresAt])
  @@map("step_attempts")
}

model IdempotencyKey {
  id              String            @id @default(uuid()) @db.Uuid
  tenantId        String            @map("tenant_id") @db.Uuid
  key             String
  stepExecutionId String            @map("step_execution_id") @db.Uuid
  status          IdempotencyStatus @default(IN_PROGRESS)
  result          Json?
  createdAt       DateTime          @default(now()) @map("created_at") @db.Timestamptz
  completedAt     DateTime?         @map("completed_at") @db.Timestamptz

  tenant        Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  stepExecution StepExecution @relation(fields: [stepExecutionId], references: [id], onDelete: Cascade)

  @@unique([tenantId, key])
  @@map("idempotency_keys")
}

model IngestedEvent {
  id          String    @id @default(uuid()) @db.Uuid
  tenantId    String    @map("tenant_id") @db.Uuid
  eventId     String    @map("event_id")
  eventName   String    @map("event_name")
  payload     Json
  receivedAt  DateTime  @default(now()) @map("received_at") @db.Timestamptz
  processedAt DateTime? @map("processed_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, eventId])
  @@map("ingested_events")
}

model WorkflowEventBinding {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId        String   @map("tenant_id") @db.Uuid
  eventName       String   @map("event_name")
  workflowName    String   @map("workflow_name")
  workflowVersion String   @map("workflow_version")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("workflow_event_bindings")
}

model ExecutionEvent {
  id              BigInt   @id @default(autoincrement())
  tenantId        String   @map("tenant_id") @db.Uuid
  workflowRunId   String   @map("workflow_run_id") @db.Uuid
  stepExecutionId String?  @map("step_execution_id") @db.Uuid
  stepAttemptId   String?  @map("step_attempt_id") @db.Uuid
  eventType       String   @map("event_type")
  payload         Json     @default("{}")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant        Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  workflowRun   WorkflowRun    @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  stepExecution StepExecution? @relation(fields: [stepExecutionId], references: [id], onDelete: Cascade)
  stepAttempt   StepAttempt?   @relation(fields: [stepAttemptId], references: [id], onDelete: Cascade)

  @@index([workflowRunId, id])
  @@index([tenantId, createdAt(sort: Desc)])
  @@map("execution_events")
}
`

- [ ] **Step 4: Create packages/database/src/client.ts**

`	ypescript
import { PrismaClient } from "@prisma/client";

export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: url ?? process.env.DATABASE_URL
      }
    }
  });
}

export { PrismaClient };
`

- [ ] **Step 5: Run pnpm install and apply initial migration**

Run: pnpm install
Run: pnpm --filter @durable/database exec prisma migrate dev --name init
Expected: Migration created and applied to durable_workflow_test.

- [ ] **Step 6: Commit**

`ash
git add packages/database pnpm-lock.yaml
git commit -m "feat(database): scaffold package, schema, and initial migration"
`

---

### Task 2: Domain Errors, Types, and Execution Event Repository

**Files:**
- Create: packages/database/src/errors.ts
- Create: packages/database/src/types.ts
- Create: packages/database/src/repositories/execution-events.ts
- Create: packages/database/src/repositories/workflow-repository.ts

**Interfaces:**
- Consumes: PrismaClient
- Produces: ecordExecutionEvent(), createWorkflowRun(), getWorkflowRun(), and StaleAttemptError.

- [ ] **Step 1: Create packages/database/src/errors.ts**

`	ypescript
export class StaleAttemptError extends Error {
  constructor(message = "Step attempt commit failed because attempt is no longer active (fenced out).") {
    super(message);
    this.name = "StaleAttemptError";
  }
}
`

- [ ] **Step 2: Create packages/database/src/types.ts**

`	ypescript
import type { Prisma } from "@prisma/client";

export interface RecordExecutionEventParams {
  tenantId: string;
  workflowRunId: string;
  stepExecutionId?: string | null;
  stepAttemptId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface ClaimStepAttemptParams {
  tenantId: string;
  workflowRunId: string;
  stepKey: string;
  workerId: string;
  leaseDurationMs: number;
}

export type ClaimStepAttemptResult =
  | { status: "COMPLETED"; output: unknown }
  | { status: "RUNNING"; attemptId: string; attemptNumber: number; stepExecutionId: string }
  | { status: "LOCKED"; activeAttemptId: string; leaseExpiresAt: Date };

export interface CompleteStepAttemptParams {
  tenantId: string;
  workflowRunId: string;
  stepExecutionId: string;
  attemptId: string;
  output: unknown;
}
`

- [ ] **Step 3: Create packages/database/src/repositories/execution-events.ts**

`	ypescript
import type { PrismaClient, Prisma } from "@prisma/client";
import type { RecordExecutionEventParams } from "../types.js";

export async function recordExecutionEvent(
  db: PrismaClient | Prisma.TransactionClient,
  params: RecordExecutionEventParams
): Promise<void> {
  const { tenantId, workflowRunId, stepExecutionId, stepAttemptId, eventType, payload = {} } = params;

  await db.executionEvent.create({
    data: {
      tenantId,
      workflowRunId,
      stepExecutionId: stepExecutionId ?? null,
      stepAttemptId: stepAttemptId ?? null,
      eventType,
      payload: payload as Prisma.InputJsonValue
    }
  });
}
`

- [ ] **Step 4: Create packages/database/src/repositories/workflow-repository.ts**

`	ypescript
import type { PrismaClient, Prisma, WorkflowRun } from "@prisma/client";
import { recordExecutionEvent } from "./execution-events.js";

export async function createWorkflowRun(
  db: PrismaClient,
  params: {
    tenantId: string;
    workflowName: string;
    workflowVersion: string;
    input: unknown;
    requestIdempotencyKey?: string;
  }
): Promise<WorkflowRun> {
  return await db.(async (tx) => {
    const run = await tx.workflowRun.create({
      data: {
        tenantId: params.tenantId,
        workflowName: params.workflowName,
        workflowVersion: params.workflowVersion,
        input: params.input as Prisma.InputJsonValue,
        requestIdempotencyKey: params.requestIdempotencyKey ?? null,
        status: "PENDING"
      }
    });

    await recordExecutionEvent(tx, {
      tenantId: params.tenantId,
      workflowRunId: run.id,
      eventType: "WORKFLOW_CREATED",
      payload: { workflowName: params.workflowName, workflowVersion: params.workflowVersion }
    });

    return run;
  });
}
`

- [ ] **Step 5: Commit**

`ash
git add packages/database/src
git commit -m "feat(database): implement execution events and workflow run repository"
`

---

### Task 3: Fenced Step Repository (claim, complete, heartbeat) & Integration Tests

**Files:**
- Create: packages/database/src/repositories/step-repository.ts
- Create: packages/database/src/index.ts
- Create: packages/database/test/fenced-persistence.test.ts

**Interfaces:**
- Consumes: PrismaClient, ecordExecutionEvent, StaleAttemptError
- Produces: claimStepAttempt(), completeStepAttempt(), enewAttemptLease(), and green integration test.

- [ ] **Step 1: Write failing test in packages/database/test/fenced-persistence.test.ts**

`	ypescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createPrismaClient } from "../src/client.js";
import { createWorkflowRun } from "../src/repositories/workflow-repository.js";
import { claimStepAttempt, completeStepAttempt, renewAttemptLease } from "../src/repositories/step-repository.js";
import { StaleAttemptError } from "../src/errors.js";

describe("Fenced Step Persistence", () => {
  const db = createPrismaClient(process.env.DATABASE_URL);
  let tenantId: string;

  beforeAll(async () => {
    await db.();
  });

  beforeEach(async () => {
    const tenant = await db.tenant.create({ data: { name: "test-tenant" } });
    tenantId = tenant.id;
  });

  it("claims an attempt, renews lease, and commits completion", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "test-wf",
      workflowVersion: "v1",
      input: { test: true }
    });

    const claim = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-1",
      workerId: "worker-a",
      leaseDurationMs: 10_000
    });

    expect(claim.status).toBe("RUNNING");
    if (claim.status !== "RUNNING") return;

    await renewAttemptLease(db, {
      attemptId: claim.attemptId,
      additionalMs: 5_000
    });

    await completeStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepExecutionId: claim.stepExecutionId,
      attemptId: claim.attemptId,
      output: { result: 42 }
    });

    // Second claim must return memoized result immediately
    const memoClaim = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-1",
      workerId: "worker-b",
      leaseDurationMs: 10_000
    });

    expect(memoClaim.status).toBe("COMPLETED");
    if (memoClaim.status === "COMPLETED") {
      expect(memoClaim.output).toEqual({ result: 42 });
    }
  });

  it("fences out a stale attempt commit when active_attempt_id has changed", async () => {
    const run = await createWorkflowRun(db, {
      tenantId,
      workflowName: "test-wf",
      workflowVersion: "v1",
      input: {}
    });

    const claim1 = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fenced",
      workerId: "worker-a",
      leaseDurationMs: 10_000
    });
    if (claim1.status !== "RUNNING") throw new Error("claim1 failed");

    // Simulate lease expiry and reassignment to Worker B
    await db.stepAttempt.update({
      where: { id: claim1.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) }
    });

    const claim2 = await claimStepAttempt(db, {
      tenantId,
      workflowRunId: run.id,
      stepKey: "step-fenced",
      workerId: "worker-b",
      leaseDurationMs: 10_000
    });
    if (claim2.status !== "RUNNING") throw new Error("claim2 failed");

    // Worker A wakes up and attempts to complete -> MUST throw StaleAttemptError
    await expect(
      completeStepAttempt(db, {
        tenantId,
        workflowRunId: run.id,
        stepExecutionId: claim1.stepExecutionId,
        attemptId: claim1.attemptId,
        output: { result: "stale-A" }
      })
    ).rejects.toThrow(StaleAttemptError);
  });
});
`

- [ ] **Step 2: Run test to verify it fails**

Run: pnpm --filter @durable/database test
Expected: FAIL (step-repository.js not found or functions undefined)

- [ ] **Step 3: Implement packages/database/src/repositories/step-repository.ts**

`	ypescript
import type { PrismaClient } from "@prisma/client";
import { StaleAttemptError } from "../errors.js";
import { recordExecutionEvent } from "./execution-events.js";
import type { ClaimStepAttemptParams, ClaimStepAttemptResult, CompleteStepAttemptParams } from "../types.js";

export async function claimStepAttempt(
  db: PrismaClient,
  params: {
    tenantId: string;
    workflowRunId: string;
    stepKey: string;
    workerId: string;
    leaseDurationMs: number;
  }
): Promise<ClaimStepAttemptResult> {
  const { tenantId, workflowRunId, stepKey, workerId, leaseDurationMs } = params;

  return await db.(async (tx) => {
    // 1. Lock and fetch step_execution if exists
    const rows = await tx.<Array<{
      id: string;
      status: string;
      output: unknown;
      attempt_count: number;
      active_attempt_id: string | null;
      lease_expires_at: Date | null;
    }>>
      SELECT s.id, s.status, s.output, s.attempt_count, s.active_attempt_id, a.lease_expires_at
      FROM step_executions s
      LEFT JOIN step_attempts a ON a.id = s.active_attempt_id
      WHERE s.workflow_run_id = ::uuid AND s.step_key = 
      FOR UPDATE OF s
    ;

    const existing = rows[0];

    // If already COMPLETED, return memoized result immediately
    if (existing && existing.status === "COMPLETED") {
      return { status: "COMPLETED", output: existing.output };
    }

    const now = new Date();
    // Check if active lease is still valid
    if (existing && existing.active_attempt_id && existing.lease_expires_at && existing.lease_expires_at > now) {
      return {
        status: "LOCKED",
        activeAttemptId: existing.active_attempt_id,
        leaseExpiresAt: existing.lease_expires_at
      };
    }

    const newAttemptNumber = (existing?.attempt_count ?? 0) + 1;
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    // Create or update step_execution
    let stepExecutionId: string;
    if (!existing) {
      const created = await tx.stepExecution.create({
        data: {
          tenantId,
          workflowRunId,
          stepKey,
          status: "RUNNING",
          attemptCount: 1,
          startedAt: now
        }
      });
      stepExecutionId = created.id;
    } else {
      stepExecutionId = existing.id;
      await tx.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "RUNNING",
          attemptCount: newAttemptNumber,
          startedAt: existing.attempt_count === 0 ? now : undefined
        }
      });
    }

    // Insert new step_attempt
    const attempt = await tx.stepAttempt.create({
      data: {
        tenantId,
        stepExecutionId,
        attemptNumber: newAttemptNumber,
        status: "RUNNING",
        workerId,
        startedAt: now,
        heartbeatAt: now,
        leaseExpiresAt
      }
    });

    // Update active_attempt_id on step_execution
    await tx.stepExecution.update({
      where: { id: stepExecutionId },
      data: { activeAttemptId: attempt.id }
    });

    // Append STEP_STARTED durable execution event
    await recordExecutionEvent(tx, {
      tenantId,
      workflowRunId,
      stepExecutionId,
      stepAttemptId: attempt.id,
      eventType: "STEP_STARTED",
      payload: { stepKey, attemptNumber: newAttemptNumber, workerId }
    });

    return {
      status: "RUNNING",
      attemptId: attempt.id,
      attemptNumber: newAttemptNumber,
      stepExecutionId
    };
  });
}

export async function completeStepAttempt(
  db: PrismaClient,
  params: CompleteStepAttemptParams
): Promise<void> {
  const { tenantId, workflowRunId, stepExecutionId, attemptId, output } = params;

  await db.(async (tx) => {
    // Fenced conditional update: only succeeds if active_attempt_id matches attemptId
    const updatedCount = await tx.
      UPDATE step_executions
      SET status = 'COMPLETED',
          output = ::jsonb,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ::uuid
        AND active_attempt_id = ::uuid
    ;

    if (updatedCount === 0) {
      throw new StaleAttemptError();
    }

    // Update attempt record
    await tx.stepAttempt.update({
      where: { id: attemptId },
      data: {
        status: "COMPLETED",
        finishedAt: new Date()
      }
    });

    // Append STEP_COMPLETED event
    await recordExecutionEvent(tx, {
      tenantId,
      workflowRunId,
      stepExecutionId,
      stepAttemptId: attemptId,
      eventType: "STEP_COMPLETED",
      payload: { output }
    });
  });
}

export async function renewAttemptLease(
  db: PrismaClient,
  params: { attemptId: string; additionalMs: number }
): Promise<void> {
  const { attemptId, additionalMs } = params;
  const now = new Date();
  const newLease = new Date(now.getTime() + additionalMs);

  await db.stepAttempt.update({
    where: { id: attemptId },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: newLease
    }
  });
}
`

- [ ] **Step 4: Create packages/database/src/index.ts**

`	ypescript
export * from "./client.js";
export * from "./errors.js";
export * from "./types.js";
export * from "./repositories/execution-events.js";
export * from "./repositories/workflow-repository.js";
export * from "./repositories/step-repository.js";
`

- [ ] **Step 5: Run tests and verify PASS**

Run: dotenv -e ../../.env.test -- pnpm --filter @durable/database test
Expected: PASS (2 tests passed)

- [ ] **Step 6: Run build across workspace**

Run: pnpm build
Expected: PASS (all packages build cleanly)

- [ ] **Step 7: Commit**

`ash
git add packages/database
git commit -m "feat(database): implement fenced step repository and integration tests"
`

---

### Task 4: Final Verification and Ticket 02 Completion Gate

**Files:**
- Modify: .scratch/durable-engine/issues/02-database-schema-and-fenced-persistence.md

- [ ] **Step 1: Execute test suite across the monorepo**

Run: dotenv -e .env.test -- pnpm test
Expected: All suites pass (@durable/shared + @durable/database).

- [ ] **Step 2: Update Ticket 02 issue file**

Modify: .scratch/durable-engine/issues/02-database-schema-and-fenced-persistence.md
Mark all acceptance criteria checkboxes checked [x] and update status to completed.

- [ ] **Step 3: Commit**

`ash
git add .scratch/durable-engine/issues/02-database-schema-and-fenced-persistence.md
git commit -m "chore(ticket-02): mark database schema and fenced persistence complete"
`
