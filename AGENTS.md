# Agent Guidelines

## Agent skills

### Issue tracker

Local markdown files under .scratch/. See docs/agents/issue-tracker.md.

### Domain docs

Single-context layout (`CONTEXT.md` and `docs/spec/` at the repository root). See `docs/agents/domain.md`.

### Ticket workflow

Before locking a ticket's file structure or public interfaces, inspect every immediate downstream ticket that consumes its outputs. Record a lightweight producer-to-consumer interface check in the ticket plan, then implement and verify only the current ticket. Do not begin downstream tickets until the current ticket's tests and review gate pass; preserve the specification as the authority when resolving interface questions.

