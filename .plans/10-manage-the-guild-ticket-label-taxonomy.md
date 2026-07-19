# #10 Manage the guild ticket-label taxonomy

## Summary

Add the app-owned guild label taxonomy with idempotent generic defaults,
normalized per-guild uniqueness, optional descriptions for anyone assigning
labels, and settings flows that create, select, edit, delete, persist, and
rerender labels. A label exists or it does not; there is no inactive state.
Deleting a label removes only its ticket associations and never deletes a
ticket.

## Acceptance criteria

- [x] New guilds seed bug, account, gameplay, feedback, and other exactly once.
- [x] Names are normalized and unique per guild.
- [x] Descriptions are optional context for anyone interacting with labels.
- [x] Deleting a label cascades its ticket associations without deleting tickets.
- [x] Settings interactions authorize, validate, persist, and rerender.
- [x] Concurrent deletion and selection cannot leave orphaned associations.

## TODOs

- [x] Add the app-owned label and ticket-label schema, generated migration, and migration/schema coverage.
- [x] Implement the SQLite taxonomy store with idempotent defaults, normalization, CRUD, cascade deletion, atomic label selection, and focused tests.
- [x] Compose authorized create, select, edit, and delete label settings that persist and rerender, with integration coverage.
- [x] Run focused and repository-wide validation and document the remaining real-Discord HITL gate.

## Human validation

- [x] Automated checks pass before requesting credentials or human action.
- [ ] Provide development Discord credentials. Create, select, edit, and delete labels in the real settings UI; restart Prod to verify persistence; attempt normalized duplicates; and confirm deleting a label removes it from tickets without deleting those tickets or their other labels.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- 2026-07-17: `/home/mia/mia-cx/prod` is on `main` and `git pull --ff-only origin main` reports it is already up to date.
- 2026-07-17: This T3-managed implementation worktree is clean on `t3code/fast-forward-main-1` and exactly aligned with `origin/main` at `73f94d2`.
- 2026-07-17: Issue #10 is open and AFK-ready; blockers #5 and #6 are closed.
- 2026-07-17: The mandatory real-Discord checklist remains HITL. The implementation PR must reference rather than close #10 until a human records a redacted passing result.
- 2026-07-17: Added generated migration for the app-owned `labels` and `ticket_labels` tables, including per-guild normalized-name uniqueness.
- 2026-07-17: The SQLite taxonomy store normalizes names with NFKC, collapsed whitespace, and case folding; seeds five described defaults idempotently; and preserves stable IDs through edits.
- 2026-07-17: Added the authorized Labels settings category with escaped persisted taxonomy rendering. Domain failures return actionable validation notices; successful mutations rerender fresh state.
- 2026-07-17: Full `pnpm check` and `pnpm pack:check` passed. The real-Discord HITL items remain intentionally pending.
- 2026-07-17: PR review reproduced default labels being recreated after an administrator renamed one. Resolution tracks taxonomy initialization independently of mutable label names and seeds the marker plus defaults atomically.
- 2026-07-17: PR review also found that an unbounded name-and-description display could silently hide manageable labels at Discord's text limit.
- 2026-07-17: A follow-up review found direct first-write store callers could bypass initialization. Resolution shares one transaction-scoped initializer across explicit initialization and creation, including domain-error commits.
- 2026-07-19: Labels now have no inactive state. The settings UI uses one string select (maximum 25 labels) and appends edit/delete controls for the selected label. Deletion cascades only through `ticket_labels`, preserving tickets and their other labels.
- 2026-07-19: Full `pnpm check` passes all 32 tasks with 177 app tests; `pnpm pack:check` passes all 15 tasks.
- 2026-07-19: The Labels page lists every label above its selector, then renders Edit and Delete together in one Action Row for the selected label. Descriptions are optional and no longer framed as AI-specific.
