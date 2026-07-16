# #6 Configure a guild support hub through settings

## Summary

Replace Prod's synthetic in-memory settings consumer with persisted, app-owned guild setup settings. Authorized guild administrators can choose a validated text-channel hub, enforce its empty-hub privacy boundary, create or refresh exactly one informational message, and configure the persisted assistant identity and tone.

## Acceptance criteria

- [ ] Only a guild owner or administrator can bootstrap an unconfigured guild.
- [ ] Hub selection validates channel type and effective bot permissions.
- [ ] Initialization and default guild data are idempotent.
- [ ] The hub information message is created or refreshed without duplication.
- [ ] Identity and tone settings persist and rerender correctly.
- [ ] The configured hub follows the empty-hub privacy contract.

## TODOs

- [x] Add the app-owned guild-settings schema, migration, and idempotent SQLite store with persistence tests.
- [x] Implement and test the Discord support-hub boundary for channel validation, empty-hub permissions, and idempotent information messages.
- [x] Compose the persisted Setup settings category, enforce bootstrap authorization, and wire it into application startup.
- [ ] Prove the complete setup workflow with focused integration tests and run repository-wide validation.

## Human validation

- [ ] Automated checks pass before requesting credentials or human action.
- [ ] Provide development Discord credentials and administrator access to a test guild. Configure a real hub through `/settings`, inspect effective bot and reporter permissions, refresh the information message twice, restart Prod, and confirm the setup persists without duplicate messages.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- 2026-07-16: Local `main` is clean and exactly aligned with `origin/main` at `a376aa7`; blockers #3, #4, and #5 are closed.
- 2026-07-16: Work proceeds in `.worktrees/6-configure-guild-support-hub` on `issue/6-configure-guild-support-hub` as required by the address workflow.
- 2026-07-16: The mandatory real-Discord checklist remains HITL. The implementation PR must reference rather than close #6 until a human records a redacted passing result.
- 2026-07-16: Unconfigured guild bootstrap is intentionally stricter than ordinary settings administration: only the Discord guild owner or a member with Administrator may initialize the guild. Once configured, the existing Manage Server and application-operator access paths remain available for settings management.
- 2026-07-16: Empty-hub setup denies ordinary members from sending hub messages, sending in threads, or creating public/private threads. Ticket provisioning will later add the documented per-reporter overwrite that permits private-thread participation.
- 2026-07-16: Added the app-owned `guild_settings` key/value schema and generated migration `0002`. The SQLite store loads defaults without writes, initializes with conflict-safe inserts, retains an information-message ID on same-hub writes, clears it when the hub changes, and persists identity/tone across store instances. All 55 app tests, app typecheck, and app lint pass.
- 2026-07-16: Discord's channel API requires effective `Manage Roles` permission to edit channel overwrites. The support-hub adapter validates that plus every MVP bot permission, accepts only standard text channels, applies the locked reporter overwrite idempotently, edits a stored information message, and creates a replacement only for Discord's confirmed Unknown Message response. All 59 app tests, app typecheck, and app lint pass.
- 2026-07-16: Replaced the synthetic consumer with the product Setup category. Its hub selection validates and configures Discord before persistence, hub changes remove the previous managed message, the post/refresh button revalidates privacy and persists one message ID, and identity/tone modals use the SQLite store. Application startup now supplies the migrated database-backed store. The app typecheck, lint, and all 59 tests pass.
