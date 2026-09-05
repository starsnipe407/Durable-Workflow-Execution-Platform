-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StepExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'RETRY_WAIT', 'FAILED');

-- CreateEnum
CREATE TYPE "StepAttemptStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'ABANDONED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('DIRECT', 'EVENT');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registered_at" TIMESTAMPTZ,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_name" TEXT NOT NULL,
    "workflow_version" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "workflow_attempt" INTEGER NOT NULL DEFAULT 1,
    "trigger_type" "TriggerType" NOT NULL DEFAULT 'DIRECT',
    "trigger_event_id" UUID,
    "concurrency_key" TEXT,
    "blocked_reason" TEXT,
    "request_idempotency_key" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "cancel_requested_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_executions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "step_key" TEXT NOT NULL,
    "status" "StepExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "error" JSONB,
    "retry_limit" INTEGER NOT NULL DEFAULT 3,
    "timeout_ms" INTEGER,
    "idempotency_key" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "active_attempt_id" UUID,
    "next_retry_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "step_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "step_execution_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "StepAttemptStatus" NOT NULL DEFAULT 'RUNNING',
    "worker_id" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "heartbeat_at" TIMESTAMPTZ,
    "lease_expires_at" TIMESTAMPTZ,
    "error_type" TEXT,
    "error_message" TEXT,
    "error_metadata" JSONB,
    "retry_delay_ms" INTEGER,
    "timed_out" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "step_execution_id" UUID NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "result" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingested_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "ingested_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_event_bindings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "workflow_name" TEXT NOT NULL,
    "workflow_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_event_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "step_execution_id" UUID,
    "step_attempt_id" UUID,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_tenant_id_name_version_key" ON "workflow_definitions"("tenant_id", "name", "version");

-- CreateIndex
CREATE INDEX "workflow_runs_tenant_id_created_at_idx" ON "workflow_runs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "workflow_runs_tenant_id_status_idx" ON "workflow_runs"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "workflow_runs_workflow_name_workflow_version_status_idx" ON "workflow_runs"("workflow_name", "workflow_version", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_tenant_id_request_idempotency_key_key" ON "workflow_runs"("tenant_id", "request_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "step_executions_workflow_run_id_step_key_key" ON "step_executions"("workflow_run_id", "step_key");

-- CreateIndex
CREATE INDEX "step_attempts_status_lease_expires_at_idx" ON "step_attempts"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "step_attempts_step_execution_id_attempt_number_key" ON "step_attempts"("step_execution_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_key_key" ON "idempotency_keys"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ingested_events_tenant_id_event_id_key" ON "ingested_events"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "execution_events_workflow_run_id_id_idx" ON "execution_events"("workflow_run_id", "id");

-- CreateIndex
CREATE INDEX "execution_events_tenant_id_created_at_idx" ON "execution_events"("tenant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_attempts" ADD CONSTRAINT "step_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_attempts" ADD CONSTRAINT "step_attempts_step_execution_id_fkey" FOREIGN KEY ("step_execution_id") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_step_execution_id_fkey" FOREIGN KEY ("step_execution_id") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingested_events" ADD CONSTRAINT "ingested_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_event_bindings" ADD CONSTRAINT "workflow_event_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_step_execution_id_fkey" FOREIGN KEY ("step_execution_id") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_step_attempt_id_fkey" FOREIGN KEY ("step_attempt_id") REFERENCES "step_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
