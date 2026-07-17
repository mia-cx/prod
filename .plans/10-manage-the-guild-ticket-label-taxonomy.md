# #10 Manage the guild ticket-label taxonomy

## Summary

Add the app-owned guild label taxonomy with idempotent generic defaults,
normalized per-guild uniqueness, AI-facing descriptions, soft deactivation,
and settings flows that create, edit, deactivate, persist, and rerender labels.
Ticket-label selection must be atomic with the active-label check so a
concurrent deactivation either preserves an already-created association or
causes the selection to fail without writing one.

## Acceptance criteria

- [ ] New guilds seed bug, account, gameplay, feedback, and other exactly once.
- [ ] Names are normalized and unique per guild.
- [ ] Descriptions are available for later AI use.
- [ ] Deactivation removes labels from future choices without deleting history.
- [ ] Settings interactions authorize, validate, persist, and rerender.
- [ ] Concurrent deactivation and selection fail safely.

## TODOs

- [x] Add the app-owned label and ticket-label schema, generated migration, and migration/schema coverage.
- [x] Implement the SQLite taxonomy store with idempotent defaults, normalization, CRUD, soft deactivation, atomic active-label selection, and focused tests.
- [x] Compose authorized create, edit, and deactivate label settings that persist and rerender, with integration coverage.
- [ ] Run focused and repository-wide validation and document the remaining real-Discord HITL gate.

## Human validation

- [ ] Automated checks pass before requesting credentials or human action.
- [ ] Provide development Discord credentials. Create, edit, and deactivate labels in the real settings UI, restart Prod to verify persistence, attempt normalized duplicates, and confirm deactivated labels disappear from new selections without deleting stored history.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- 2026-07-17: `/home/mia/mia-cx/prod` is on `main` and `git pull --ff-only origin main` reports it is already up to date.
- 2026-07-17: This T3-managed implementation worktree is clean on `t3code/fast-forward-main-1` and exactly aligned with `origin/main` at `73f94d2`.
- 2026-07-17: Issue #10 is open and AFK-ready; blockers #5 and #6 are closed.
- 2026-07-17: The mandatory real-Discord checklist remains HITL. The implementation PR must reference rather than close #10 until a human records a redacted passing result.
- 2026-07-17: Added generated migration `0003` for the app-owned `labels` and `ticket_labels` tables, including per-guild normalized-name uniqueness and history-preserving restricted label deletion. All 81 app tests pass after schema and migration coverage updates.
- 2026-07-17: The SQLite taxonomy store normalizes names with NFKC, collapsed whitespace, and case folding; seeds five described defaults idempotently; preserves stable IDs through edits; and soft-deactivates labels. Active-label validation and ticket association insertion share one transaction, so concurrent deactivation either follows a committed association or makes selection fail without history. App typecheck, lint, and all 86 tests pass.
- 2026-07-17: Added the authorized Labels settings category with escaped persisted taxonomy rendering and create, edit, and deactivate modals. Domain failures return actionable validation notices; successful mutations rerender fresh state. Integration tests cover authorized seeding, normalized duplicates, all three flows, restart persistence, inactive filtering, and authorization rechecks. App typecheck, lint, and all 89 tests pass.
