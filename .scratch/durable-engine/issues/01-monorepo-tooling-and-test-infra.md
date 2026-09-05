# 01: Monorepo Tooling and Test Infrastructure

**What to build:**
A minimal, working Turborepo and pnpm workspace environment with containerized PostgreSQL and Redis services and a unified Vitest test runner. Developers can spin up dedicated test databases (pnpm db:up), run migrations, and execute isolated integration tests (pnpm test) across the workspace.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Initialize root package.json, pnpm-workspace.yaml, 	urbo.json, and base 	sconfig.json.
- [ ] Create docker-compose.yml with isolated PostgreSQL and Redis services (separate ports/DBs for test vs dev).
- [ ] Add root scripts: db:up, db:down, db:reset, and 	est.
- [ ] Configure root Vitest runner to discover and run package integration suites against the test PostgreSQL instance.
