# Ticket 01: Monorepo Tooling and Test Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Establish a working Turborepo and pnpm monorepo workspace with containerized PostgreSQL and Redis services, root TypeScript configuration, Vitest test orchestration, and verification scripts (pnpm db:up, pnpm db:reset, pnpm test).

**Architecture:** A lightweight Turborepo workspace managing TypeScript packages and applications. Docker Compose provides isolated test databases (Postgres on port 5433, Redis on port 6380) distinct from dev defaults (5432/6379). A workspace-level Vitest runner coordinates test execution with clean environment isolation.

**Tech Stack:** pnpm 10+, Node.js 22+, Turborepo, TypeScript 5.8+, Docker Compose, Vitest 3+, PostgreSQL 16, Redis 7.

## Global Constraints

- Monorepo package manager: pnpm with workspace protocol (workspace:*).
- Build system: Turborepo (	urbo).
- Module format: ESM-first ("type": "module").
- Separate test infrastructure ports: Test Postgres runs on port 5433 (db: durable_workflow_test), Test Redis runs on port 6380.
- Root scripts must include: pnpm db:up, pnpm db:down, pnpm db:reset, pnpm build, pnpm test, pnpm lint.

---

## File Structure

- package.json: Root package definition with workspace scripts and devDependencies.
- pnpm-workspace.yaml: Declares workspace layout (packages/*, pps/*, examples/*).
- 	urbo.json: Task pipeline configuring uild, 	est, lint, and dependency caching.
- 	sconfig.json: Base TypeScript configuration shared across packages.
- itest.workspace.ts: Workspace configuration discovering Vitest projects across packages and apps.
- docker-compose.yml: Test and development container topology for PostgreSQL and Redis.
- .env.test: Standard environment variables for local testing (DATABASE_URL, REDIS_URL).
- .gitignore: Ignoring node_modules, dist, .turbo, logs, and local env overrides.
- scripts/reset-test-db.mjs: Script to recreate or truncate the test database cleanly.
- packages/shared/package.json: Minimal starter shared package to validate workspace cross-package linking and build pipeline.
- packages/shared/src/index.ts: Basic exports for shared workspace types and utilities.
- packages/shared/test/shared.test.ts: Verification test ensuring Vitest runs workspace tests successfully.

---

### Task 1: Initialize Git and Root Workspace Configuration

**Files:**
- Create: .gitignore
- Create: package.json
- Create: pnpm-workspace.yaml
- Create: 	sconfig.json
- Create: 	urbo.json

**Interfaces:**
- Consumes: None
- Produces: Root pnpm workspace definition, Turbo pipeline configuration, and shared base tsconfig.

- [ ] **Step 1: Create .gitignore**

`	ext
node_modules
dist
.turbo
.next
coverage
*.log
.env
!.env.test
.DS_Store
`

- [ ] **Step 2: Create pnpm-workspace.yaml**

`yaml
packages:
  - 'packages/*'
  - 'apps/*'
  - 'examples/*'
`

- [ ] **Step 3: Create tsconfig.json**

`json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
`

- [ ] **Step 4: Create turbo.json**

`json
{
  "": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**/*.ts", "test/**/*.ts"]
    },
    "lint": {
      "dependsOn": ["^build"]
    }
  }
}
`

- [ ] **Step 5: Create root package.json**

`json
{
  "name": "durable-workflow-platform",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "turbo run build",
    "test": "vitest run",
    "lint": "turbo run lint",
    "db:up": "docker compose up -d postgres-test redis-test",
    "db:down": "docker compose down",
    "db:reset": "node scripts/reset-test-db.mjs"
  },
  "devDependencies": {
    "turbo": "^2.4.4",
    "typescript": "^5.8.2",
    "vitest": "^3.0.7",
    "@types/node": "^22.13.9"
  }
}
`

- [ ] **Step 6: Run pnpm install to bootstrap lockfile**

Run: pnpm install
Expected: Lockfile is up to date or packages installed cleanly without errors.

- [ ] **Step 7: Commit**

`ash
git add .gitignore package.json pnpm-workspace.yaml tsconfig.json turbo.json pnpm-lock.yaml
git commit -m "chore: bootstrap root monorepo workspace configuration"
`

---

### Task 2: Docker Compose Test Infrastructure and DB Scripts

**Files:**
- Create: docker-compose.yml
- Create: .env.test
- Create: scripts/reset-test-db.mjs

**Interfaces:**
- Consumes: Docker daemon
- Produces: Running PostgreSQL instance on localhost:5433 (database: durable_workflow_test, user: postgres, password: postgres) and Redis on localhost:6380.

- [ ] **Step 1: Create docker-compose.yml**

`yaml
services:
  postgres-test:
    image: postgres:16-alpine
    container_name: durable-postgres-test
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: durable_workflow_test
    ports:
      - '5433:5432'
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d durable_workflow_test"]
      interval: 3s
      timeout: 3s
      retries: 5

  redis-test:
    image: redis:7-alpine
    container_name: durable-redis-test
    ports:
      - '6380:6379'
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 5
`

- [ ] **Step 2: Create .env.test**

`env
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public"
REDIS_URL="redis://localhost:6380"
`

- [ ] **Step 3: Create scripts/reset-test-db.mjs**

`javascript
import { execSync } from 'node:child_process';

console.log('Resetting test database...');
try {
  // Execute drop and recreate via docker compose exec
  execSync(
    'docker compose exec -T postgres-test psql -U postgres -c "DROP DATABASE IF EXISTS durable_workflow_test; CREATE DATABASE durable_workflow_test;"',
    { stdio: 'inherit' }
  );
  console.log('Test database reset successfully.');
} catch (err) {
  console.error('Failed to reset test database:', err.message);
  process.exit(1);
}
`

- [ ] **Step 4: Start docker test containers and verify health**

Run: pnpm db:up
Expected: Containers durable-postgres-test and durable-redis-test running and healthy.

Run: docker compose ps
Expected: Both services show Up (healthy).

- [ ] **Step 5: Test db:reset script**

Run: pnpm db:reset
Expected: Test database reset successfully.

- [ ] **Step 6: Commit**

`ash
git add docker-compose.yml .env.test scripts/reset-test-db.mjs
git commit -m "chore: setup docker compose test services and reset script"
`

---

### Task 3: Workspace Vitest Setup & First Shared Package Verification

**Files:**
- Create: itest.workspace.ts
- Create: packages/shared/package.json
- Create: packages/shared/tsconfig.json
- Create: packages/shared/src/index.ts
- Create: packages/shared/test/shared.test.ts

**Interfaces:**
- Consumes: Root TypeScript and Vitest configs
- Produces: packages/shared exporting basic utility functions, discoverable by itest.workspace.ts.

- [ ] **Step 1: Create vitest.workspace.ts**

`	ypescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'packages/*/test/**/*.test.ts',
  'apps/*/test/**/*.test.ts'
]);
`

- [ ] **Step 2: Create packages/shared/package.json**

`json
{
  "name": "@durable/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.8.2",
    "vitest": "^3.0.7"
  }
}
`

- [ ] **Step 3: Create packages/shared/tsconfig.json**

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

- [ ] **Step 4: Write failing test in packages/shared/test/shared.test.ts**

`	ypescript
import { describe, it, expect } from 'vitest';
import { generateId } from '../src/index.js';

describe('shared utilities', () => {
  it('generates a prefixed id', () => {
    const id = generateId('run');
    expect(id).toMatch(/^run_[a-z0-9]+$/);
  });
});
`

- [ ] **Step 5: Run vitest to verify it fails**

Run: pnpm test
Expected: FAIL (generateId is not exported from ../src/index.js)

- [ ] **Step 6: Implement packages/shared/src/index.ts**

`	ypescript
export function generateId(prefix: string): string {
  const randomPart = Math.random().toString(36).substring(2, 10);
  return ${prefix}_;
}
`

- [ ] **Step 7: Run vitest to verify it passes**

Run: pnpm test
Expected: PASS (1 test passed)

- [ ] **Step 8: Run turbo build**

Run: pnpm build
Expected: Build passes or completes with no errors.

- [ ] **Step 9: Commit**

`ash
git add vitest.workspace.ts packages/shared
git commit -m "feat(shared): configure vitest workspace and add initial shared package"
`

---

### Task 4: Integration Verification and Acceptance Gate

**Files:**
- Modify: package.json (add pretest or test hook if needed)
- Verify: Full round-trip pnpm db:up -> pnpm test -> pnpm db:reset

- [ ] **Step 1: Execute full test and build suite**

Run: pnpm test
Expected: 1 passed in @durable/shared.

- [ ] **Step 2: Verify docker compose services liveness**

Run: docker compose exec -T postgres-test psql -U postgres -d durable_workflow_test -c "SELECT 1;"
Expected: Output ?column? \n 1

Run: docker compose exec -T redis-test redis-cli ping
Expected: PONG

- [ ] **Step 3: Update Ticket 01 status**

Modify: .scratch/durable-engine/issues/01-monorepo-tooling-and-test-infra.md
Mark completed acceptance criteria.

- [ ] **Step 4: Commit**

`ash
git add .scratch/durable-engine/issues/01-monorepo-tooling-and-test-infra.md
git commit -m "chore(ticket-01): mark monorepo tooling and test infrastructure complete"
`
