# Domain Documentation & Architecture Decision Records (ADRs)

## Layout

This repository uses a **single-context** domain documentation layout.

- **Domain Context**: [`CONTEXT.md`](../../CONTEXT.md) at the repository root outlines the overall architecture, mental models, ubiquitous language, and system components.
- **Specification**: Implementation specification and architectural rules live in [`docs/spec/`](../spec/).

## Rules for Agents

1. Always consult [`CONTEXT.md`](../../CONTEXT.md) and [`docs/spec/`](../spec/) before designing or implementing structural changes.
2. When proposing or recording fundamental architectural decisions, document them under [docs/adr/](../adr/) following standard ADR formatting (NNNN-title.md).
