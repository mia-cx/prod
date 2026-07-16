# #5 Render and mutate consumer-defined Discord settings

## Summary

Implement `@protocord/settings` as a deep, reusable Discord Components v2 runtime. Consumers compose public category, subcategory, and field contracts; the package owns versioned routing, bounded rendering, interaction dispatch, input resolution, authorization, validation, mutation, and rerendering.

## Acceptance criteria

- [ ] A consumer can define and compose settings categories without importing package internals.
- [ ] Versioned custom IDs round-trip and unknown or stale routes fail safely.
- [ ] Mentionable selects resolve users and roles into explicit union variants.
- [ ] Successful mutations rerender and validation failures preserve actionable context.
- [ ] Authorization is rechecked on every view and mutation interaction.
- [ ] Component limits and pagination are enforced.
- [ ] The package builds, tests, and packs independently.

## TODOs

- [ ] Define the public consumer contracts, definition validation, and versioned custom-ID codec.
- [ ] Render authorized category/subcategory navigation and bounded Components v2 field pages with pagination.
- [ ] Dispatch Discord buttons, selects, mentionables, channels, and modal lifecycles through validation, mutation, and rerendering.
- [ ] Prove the complete package boundary with a synthetic consumer and run package/repository validation.

## Human validation

- [ ] Automated checks pass before requesting credentials or human action.
- [ ] Provide development Discord credentials. Open the synthetic settings consumer in the development guild and exercise navigation, user/role mentionables, channel selection, modal validation, pagination, mutation, rerendering, and unauthorized interaction behavior.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- Issue #5 is open, marked `Execution: AFK`, and its blocker #2 is closed.
- This session already runs in the clean T3-managed `t3code/slice-four-issue-five` worktree at `origin/main`, so no nested worktree is needed.
- The mandatory real-Discord validation remains HITL. The implementation and PR must leave issue #5 open until that checklist is completed and recorded.
- `@protocord/settings` may depend on Discord's public API types/runtime but must not import application code, package internals, ticketing concepts, permission verbs, models, or persistence.
