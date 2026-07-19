# #9 Administer permission presets

## Summary

Deliver one direct Permissions settings page with three stateful Discord
mentionable selects: Support staff, Assignment managers, and Configurators.
Users and roles can be selected together; native select state handles additions,
removals, and clearing without separate current-state or removal controls.

On a guild's first setup, when it has no permission-rule records, every
user-managed role with Manage Server is selected in all three presets.
`@everyone`, bot/integration-managed roles, and roles without Manage Server are
excluded. Once any permission record exists, automatic initialization never
overwrites the guild's selections, including after every selection is cleared.

Custom-rule and provenance concepts remain internal persistence details. They
are not exposed as arbitrary rule configuration, inspection, or pagination UI.

## Acceptance criteria

- [x] The Permissions category is one page containing exactly three combined
  user/role mentionable selects.
- [x] Each select loads its persisted membership as Discord-native defaults and
  applies selection deltas without separate add, remove, clear, or current-state
  controls.
- [x] Each preset expands into its specified individual allow rules, and removing
  membership preserves independently owned rule contributions.
- [x] Mutations are authorized, audited, and rechecked immediately before write.
- [x] A guild with no permission records initializes every non-managed,
  non-`@everyone` Manage Server role into all three presets.
- [x] Existing or previously cleared guild configuration is never overwritten by
  initialization.
- [x] Custom rules and category/channel authorization contexts are not exposed in
  the settings UI.
- [x] The database uses a freshly generated Drizzle baseline after the requested
  development database reset.

## TODOs

- [x] Add app-owned permission-rule provenance persistence and migration coverage
  so preset removal preserves independently owned contributions.
- [x] Implement audited permission administration with atomic preset expansion and
  delta mutations.
- [x] Compose the direct three-select Permissions page and remove separate
  current/removal/clear/rule-management surfaces.
- [x] Bootstrap eligible Manage Server roles once for guilds without permission
  records, excluding Discord-managed roles.
- [x] Reset the development database, generate the fresh Drizzle baseline, apply
  it, and run repository-wide validation.

## Human validation

- [x] Automated checks pass before requesting credentials or human action.
- [ ] In a development Discord server, create representative user-managed Manage
  Server, ordinary, and bot-managed roles. Start Prod with a fresh database and
  confirm only the user-managed Manage Server role appears in all three selects.
- [ ] Add and remove users/roles with the native selectors, clear all selections,
  restart Prod, and confirm the persisted state is not automatically repopulated.
- [ ] Validate effective permissions from separate accounts after live membership
  changes and confirm no custom-rule or category/channel controls are present.
- [ ] Record the result without secrets, raw tokens, private ticket content, or
  unredacted diagnostics.

## Notes

- 2026-07-17: Fast-forwarded `main` in `/home/mia/mia-cx/prod` with
  `git pull --ff-only origin main`; it was already aligned with `origin/main` at
  `73f94d2`.
- 2026-07-17: The supplied worktree is on `t3code/fast-forward-main`; blockers #4,
  #5, and #6 are closed.
- 2026-07-19: Product direction simplified the settings surface to three native
  selectors. Custom-rule terminology and provenance remain internal only.
- 2026-07-19: The development database and prior migration history were explicitly
  reset. Drizzle generated and successfully applied one fresh baseline migration.
- 2026-07-19: First-run initialization seeds user-managed Manage Server roles into
  all three presets. Persistent active or inactive permission rows prevent later
  reinitialization.
- 2026-07-19: Issue #9 retains a real-Discord HITL gate. The PR references rather
  than closes it until a human records a redacted passing result.
