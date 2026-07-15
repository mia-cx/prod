# #4 Evaluate and persist authorization rules

## Summary

Build `@protocord/permissions` as a reusable context-subject-object-verb-permit
engine with SQLite persistence, audit events, Discord adapters, and an app-owned
Prod policy boundary that only permits guild-level rule administration.

## Acceptance criteria

- [ ] Authorization contexts require a guild and optionally refine it by category and channel.
- [ ] Runtime subjects and rule objects contain no guild or context identifiers.
- [ ] Evaluation follows context, object, and subject specificity with deny winning within one layer.
- [ ] User, role, service, and everyone selectors round-trip through SQLite storage.
- [ ] Invalid and cross-guild resource/context combinations are rejected.
- [ ] Synthetic consumers can use category and channel overrides while Prod remains guild-only.
- [ ] Guild owner and administrator break-glass precedes stored rules; otherwise unmatched checks deny.

## TODOs

- [x] Define the public authorization contracts, validation, evaluator, and precedence tests.
- [x] Add package-owned Drizzle schemas, an audited SQLite rule store, and persistence tests.
- [~] Add Discord subject/context adapters and synthetic guild hierarchy tests.
- [ ] Add Prod's guild-only policy boundary, compose a migration, and test rejection of refined contexts.
- [ ] Run focused and repository-wide validation and prepare the pull request.

## Notes

- 2026-07-16: Slice 3 maps to GitHub issue #4, the third implementation sub-issue of PRD #1.
- 2026-07-16: The T3 workspace is already an isolated clean worktree on `t3code/slice-three` at current `origin/main`, so it is used instead of nesting another `.worktrees/` checkout.
- 2026-07-16: Issue #4 requires automated checks before a mandatory live Discord validation gate. The PR must not close the issue until that human checklist is complete.
- 2026-07-16: Core contracts/evaluator validated with package typecheck, lint, and 9 passing tests.
- 2026-07-16: SQLite schemas/store validated with package typecheck, lint, and 16 passing tests; nullable context identity is covered by a COALESCE-backed unique index.
