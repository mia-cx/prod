# #2 Bootstrap the runnable Prod monorepo

## Summary

Create the Node 24 pnpm/Turborepo foundation for Prod, including the application shell and reusable package boundaries. The runnable app must validate its environment, redact secrets from structured logs, compose package and app migrations in a fixed order, connect to Discord without registering actions, report readiness, and shut down cleanly.

## Acceptance criteria

- [x] The workspace contains the planned app and package boundaries with one-way dependencies.
- [x] Turbo orders deterministic build, lint, typecheck, test, and pack tasks and does not cache side-effectful tasks.
- [x] The Prod process validates configuration, applies empty migrations, connects to Discord, logs readiness, and shuts down cleanly.
- [x] Every reusable package builds and packs independently without importing application code.
- [x] CI exercises the root checks and package-boundary smoke tests.

## TODOs

- [x] Scaffold the pnpm/Turborepo workspace and explicit compiled package boundaries.
- [x] Implement Effect-based environment validation, redacted structured logging, and fixed-order migration composition.
- [x] Implement the injectable Discord application lifecycle with readiness and graceful-shutdown tests.
- [x] Add independent package packing, boundary enforcement, and baseline CI.
- [x] Run all automated checks and document the remaining real-Discord HITL gate.

## Human validation

- [x] Automated checks pass before requesting credentials or human action.
- [ ] Provide a development Discord bot token, client ID, and guild ID through local environment secrets. Start Prod against the development guild and confirm that it connects, reports readiness, and shuts down without leaking credentials.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- The existing `t3code/first-plan-slice` checkout is a clean, T3-managed isolated worktree based on local `main`; no nested worktree is needed.
- Issue #2 is open, marked `Execution: AFK`, has no blockers, and requires real-environment human validation before closure.
- Node 24 is the planned runtime. Dependency versions will be locked by `pnpm-lock.yaml`.
- Workspace validation after scaffolding: `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass across eight projects; test coverage outputs are cacheable by Turbo.
- Configuration/persistence validation: app lint and typecheck pass; 7 app tests cover defaults, invalid-key reporting without secret echo, structured redaction, and fixed `authorization` → `model-config` → `prod` migration order. The compiled migration CLI also succeeds against in-memory SQLite.
- Discord lifecycle validation: 10 app tests pass, including migration-before-connect ordering, a readiness log with zero actions, startup-failure cleanup, adapter readiness, and idempotent graceful shutdown. A real Discord connection remains part of the issue's HITL gate.
- Boundary/pack validation: the repository boundary checker accepts exactly seven planned reusable packages and enforces the allowed internal dependency graph; `pnpm pack:check` succeeds for all seven with compiled `dist` files only. CI uses Node 24, pnpm 11, frozen installs, the root check, and package packing.
- Final validation: `pnpm install --frozen-lockfile`, `pnpm check` (32 successful Turbo tasks), and `pnpm pack:check` (15 successful/cached tasks) pass. The implementation is ready for the mandatory real-Discord HITL validation; issue #2 must remain open until that outcome is recorded.
- Follow-up validation: root `dev`, `start`, migration, command-registration, and deployment scripts load the optional repository `.env` before Turbo starts. Runtime tasks stay in strict mode and pass through the 14 planned configuration keys; a Turbo dry run confirms the root values reach `@prod/app#start` without printing their contents.
