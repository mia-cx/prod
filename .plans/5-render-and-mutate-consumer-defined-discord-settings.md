# #5 Render and mutate consumer-defined Discord settings

## Summary

Implement `@protocord/settings` as a deep, reusable Discord Components v2 runtime. Consumers compose public category, subcategory, and field contracts; the package owns versioned routing, bounded rendering, interaction dispatch, input resolution, authorization, validation, mutation, and rerendering.

## Acceptance criteria

- [x] A consumer can define and compose settings categories without importing package internals.
- [x] Versioned custom IDs round-trip and unknown or stale routes fail safely.
- [x] Mentionable selects resolve users and roles into explicit union variants.
- [x] Successful mutations rerender and validation failures preserve actionable context.
- [x] Authorization is rechecked on every view and mutation interaction.
- [x] Component limits and pagination are enforced.
- [x] The package builds, tests, and packs independently.

## TODOs

- [x] Define the public consumer contracts, definition validation, and versioned custom-ID codec.
- [x] Render authorized category/subcategory navigation and bounded Components v2 field pages with pagination.
- [x] Dispatch Discord buttons, selects, mentionables, channels, and modal lifecycles through validation, mutation, and rerendering.
- [x] Prove the complete package boundary with a synthetic consumer and run package/repository validation.

## Human validation

- [x] Automated checks pass before requesting credentials or human action.
- [ ] Provide development Discord credentials. Open the synthetic settings consumer in the development guild and exercise navigation, user/role mentionables, channel selection, modal validation, pagination, mutation, rerendering, and unauthorized interaction behavior.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- Issue #5 is open, marked `Execution: AFK`, and its blocker #2 is closed.
- This session already runs in the clean T3-managed `t3code/slice-four-issue-five` worktree at `origin/main`, so no nested worktree is needed.
- The mandatory real-Discord validation remains HITL. The implementation and PR must leave issue #5 open until that checklist is completed and recorded.
- `@protocord/settings` may depend on Discord's public API types/runtime but must not import application code, package internals, ticketing concepts, permission verbs, models, or persistence.
- Public-contract validation: package lint, typecheck, build, and 9 focused tests pass. Stable IDs are bounded for Discord custom IDs; category, subcategory, field, select, modal, and layout limits are exposed through `SETTINGS_LIMITS`; route decoding distinguishes unrelated, unknown-version, and malformed IDs.
- Components v2 rendering validation: 13 focused tests pass. The renderer filters category navigation by fresh authorization decisions, renders consumer fields into a Components v2 container, partitions fields by their actual component cost, reserves pagination controls, caps containers at 10 components, and rejects stale locations or dynamic selects above 25 options.
- Interaction-runtime validation: 22 focused tests pass. Opening replies ephemerally with the Components v2 flag; navigation and mutations update the original view; buttons, strings, mixed user/role mentionables, channels, and modal submissions recheck authorization; modal validation retains per-user drafts for retry; successful mutations rerender freshly loaded state; unrelated interactions are ignored and unknown, stale, mismatched, or unauthorized routes receive safe ephemeral responses.
- Synthetic consumer validation: Prod registers an app-owned `/settings` action backed only by `@protocord/settings` public exports. The in-memory development consumer covers two categories, subcategory navigation, buttons, strings, user/role mentionables, channels, modal validation, rerendering, and a 15-field pagination fixture. Manage Server is derived afresh from every Discord interaction.
- Final automated validation: `pnpm check` passes all 32 Turbo tasks after the package-boundary check; `pnpm pack:check` passes all 15 tasks. `@protocord/settings` has 22 passing package tests, its packed tarball contains only compiled `dist` output, and its compiled entrypoint exposes the definition, route, and runtime APIs. Prod has 31 passing app tests, including synthetic `/settings`, mutation routing, unauthorized mutation, registration, and readiness coverage.
- The remaining real-Discord checklist is intentionally pending. Do not close #5 until a human runs it with private development credentials and records a redacted outcome.
