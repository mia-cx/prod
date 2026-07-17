# #9 Administer permission presets and custom rules

## Summary

Deliver Prod's Permissions settings category. Guild administrators can manage support-staff, assignment-manager, and configurator presets through combined user/role selectors, and can stage, preview, confirm, inspect, paginate, and remove guild-wide or ticket-specific allow/deny rules without exposing category/channel authorization contexts.

## Acceptance criteria

- [ ] Each preset expands into the specified individual allow rules.
- [ ] Users and roles coexist in one mentionable control with explicit rendered types.
- [ ] Custom object, verb, and permit selections preview before persistence.
- [ ] Removing preset membership does not delete independently configured rules.
- [ ] Rule inspection, individual removal, clear confirmation, and pagination work.
- [ ] All changes are authorized, audited, and rechecked immediately before mutation.
- [ ] Prod does not expose category- or channel-context rule administration.

## TODOs

- [x] Add app-owned permission-rule provenance persistence and migration coverage so preset removal can preserve independent custom rules.
- [x] Implement and test a permission administration service for preset expansion, custom allow/deny rules, inspection, removal, and audited mutations.
- [x] Compose and test the Permissions settings category with combined mentionables, explicit subject types, confirmation, previews, and pagination.
- [ ] Wire current Discord-member authorization and the permission store into application startup, then run focused and repository-wide validation.

## Human validation

- [ ] Automated checks pass before requesting credentials or human action.
- [ ] Provide development Discord credentials and representative users/roles. Configure every preset and custom allow/deny combinations, then validate effective permissions from separate accounts after live role changes. Confirm category/channel controls are absent.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- 2026-07-17: Fast-forwarded `main` in `/home/mia/mia-cx/prod` with `git pull --ff-only origin main`; it was already aligned with `origin/main` at `73f94d2`.
- 2026-07-17: The supplied worktree is clean on `t3code/fast-forward-main`; blockers #4, #5, and #6 are closed.
- 2026-07-17: Issue #9 requires a real-Discord HITL gate. The implementation PR must reference rather than close #9 until a human records a redacted passing result.
- 2026-07-17: Ticket-specific scope means an exact ticket object ID inside the guild-only authorization context. Prod will continue rejecting and hiding category/channel context administration.
- 2026-07-17: Added `permission_rule_origins` with identity-plus-source uniqueness and a SQLite provenance store. Preset, custom, and pre-existing independent ownership can coexist, be queried deterministically, and be removed separately. Generated migration `0003`; all 82 app tests, app typecheck, app lint, and the repository build pass.
- 2026-07-17: Added the permission administration service with the canonical 9/11/13-rule preset expansions, user/role subjects, guild-wide and exact-ticket custom rules, object-specific verb validation, deterministic inspection pages, individual removal, provenance-aware preset clearing, and an injected authorization recheck before each effective mutation. The package audit store records every created, updated, and removed rule. All 89 app tests and 37 permissions-package tests pass with both packages' typecheck and lint clean.
- 2026-07-17: Added the Permissions category with separate preset subcategories, additive combined mentionable selectors, explicit `User`/`Role` rendering, paginated individual removal, two-click clear confirmation, a staged custom-rule object/scope/verb/permit preview, exact-ticket IDs, and paginated rule inspection/removal. The settings runtime now paginates only dynamically visible fields and rejects stale interactions after a field disappears. All 95 app tests and 46 settings-package tests pass; both packages' typecheck and lint are clean.
