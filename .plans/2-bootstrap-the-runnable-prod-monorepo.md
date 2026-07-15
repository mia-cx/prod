# #2 Bootstrap the runnable Prod monorepo

## Summary

Create the Node 24 pnpm/Turborepo foundation for Prod, including the application shell and reusable package boundaries. The runnable app must validate its environment, redact secrets from structured logs, compose package and app migrations in a fixed order, connect to Discord without registering actions, report readiness, and shut down cleanly.

## Acceptance criteria

- [ ] The workspace contains the planned app and package boundaries with one-way dependencies.
- [ ] Turbo orders deterministic build, lint, typecheck, test, and pack tasks and does not cache side-effectful tasks.
- [ ] The Prod process validates configuration, applies empty migrations, connects to Discord, logs readiness, and shuts down cleanly.
- [ ] Every reusable package builds and packs independently without importing application code.
- [ ] CI exercises the root checks and package-boundary smoke tests.

## TODOs

- [x] Scaffold the pnpm/Turborepo workspace and explicit compiled package boundaries.
- [x] Implement Effect-based environment validation, redacted structured logging, and fixed-order migration composition.
- [x] Implement the injectable Discord application lifecycle with readiness and graceful-shutdown tests.
- [ ] Add independent package packing, boundary enforcement, and baseline CI.
- [ ] Run all automated checks and document the remaining real-Discord HITL gate.

## Notes

- The existing `t3code/first-plan-slice` checkout is a clean, T3-managed isolated worktree based on local `main`; no nested worktree is needed.
- Issue #2 is open, marked `Execution: AFK`, has no blockers, and requires real-environment human validation before closure.
- Node 24 is the planned runtime. Dependency versions will be locked by `pnpm-lock.yaml`.
- Workspace validation after scaffolding: `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass across eight projects; test coverage outputs are cacheable by Turbo.
- Configuration/persistence validation: app lint and typecheck pass; 7 app tests cover defaults, invalid-key reporting without secret echo, structured redaction, and fixed `authorization` → `model-config` → `prod` migration order. The compiled migration CLI also succeeds against in-memory SQLite.
- Discord lifecycle validation: 10 app tests pass, including migration-before-connect ordering, a readiness log with zero actions, startup-failure cleanup, adapter readiness, and idempotent graceful shutdown. A real Discord connection remains part of the issue's HITL gate.
