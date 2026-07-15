# #3 Prove consumer-defined actions across Discord triggers

## Summary

Implement `protocord` as the reusable canonical action lifecycle and extensible Discord trigger framework. Consumer-owned fixture actions must dispatch through slash-command, message-context, user-context, configurable-prefix text, and synthetic external providers without Protocord shipping any concrete or default action catalog.

## Worktree setup

- Worktree: `/home/mia/.t3/worktrees/prod/t3code-b911669c`
- Branch: `t3code/slice-2`
- Base: `main` at `9fd4354cdc7622e61886f2dfd16551f0a73ec75e`

## Acceptance criteria

- [x] Consumer actions run through shared input parsing, public availability, authorization, protected readiness, execution, and presentation stages.
- [x] Slash aliases, both context-menu forms, and text commands dispatch through the same registry.
- [x] Provider-scoped conflicts fail atomically and disabled text commands register nothing.
- [x] Consumed text commands do not continue into the ordinary message pipeline.
- [x] A synthetic external trigger provider works without changes to built-in provider code.
- [x] The package exports no concrete action or default command.
- [x] The package builds, tests, and packs independently.

## TODOs

- [x] Define the public action, invocation, lifecycle, result, trigger-definition, provider, and registry contracts without exposing Effect in the reusable API.
- [x] Implement atomic action/provider registration, provider-scoped conflict detection, and the canonical parse → public availability → authorization → protected readiness → execute lifecycle with fresh pre-execution checks.
- [x] Implement slash-command, message-context, user-context, and configurable-prefix text providers, including explicit autocomplete access, registration metadata, private acknowledgement, outcome-aware response visibility, and trigger-specific presentation.
- [x] Compose consumer-owned fixture actions in tests and prove aliases, context menus, text parsing/consumption, disabled prefixes, bot/webhook filtering, lifecycle ordering, and failure behavior.
- [x] Prove extensibility with a synthetic external provider and verify the compiled package contains no concrete actions or default command catalog.
- [x] Run package and repository checks, then document the remaining real-Discord HITL gate.

## Recommended execution order

1. Lock the public contracts and registry/lifecycle behavior with focused tests.
2. Implement the provider-agnostic runtime and atomic registration.
3. Implement built-in Discord providers against those contracts; slash/context providers and the text provider can proceed independently once the runtime is stable.
4. Add consumer composition and synthetic-provider coverage.
5. Run build, lint, typecheck, test, packing, and boundary verification before the real-Discord gate.

## Human validation

- [x] Automated checks pass before requesting credentials or human action.
- [ ] Provide development Discord credentials through the runtime environment and verify the app-owned ping action through slash, message-context, user-context, and configured-prefix text dispatch in Discord.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- Issue #3 is open, marked `Execution: AFK`, and its only blocker, issue #2, is closed.
- This session already runs in the clean T3-managed Slice 2 worktree, so no nested `.worktrees/` checkout is needed.
- `packages/protocord` is a deep, extractable package and must not import `apps/prod`, ship concrete actions, or become a shared-utils package.
- Built-in trigger constructors should produce opaque typed definitions registered through provider contracts; the canonical runtime must remain open to third-party providers without editing its trigger union.
- Text commands default to `!`, disable on a trimmed empty prefix, accept prefixes of 1–8 Unicode code points, normalize command names to lowercase, preserve the untouched argument tail, ignore bot/webhook messages, and report whether a message was consumed.
- Text commands are an opt-in Protocord provider capability. Prod defaults the prefix to empty, which omits the privileged message intents and listener; an explicit configured prefix enables the development-guild-only ping validation surface.
- Prod composes one app-owned development validation action across `/ping`, both `Ping Prod` context menus, and the configured-prefix `ping` text command. Every surface replies with `pong!` through the canonical lifecycle.
- Protocord refreshes an explicit global or guild command scope from the complete registered catalog; Discord's authoritative `set` operation updates changed slash/context commands and removes stale ones on every restart.
- The real-Discord validation gate remains HITL and must not require credentials in issues, commits, fixtures, logs, or screenshots.
- Package validation: lint, typecheck, build, dry-run pack, compiled-entrypoint smoke import, and 58 focused tests pass with 91.78% statement coverage.
- Repository validation: `pnpm check` completes 32/32 Turbo tasks and validates all seven reusable-package boundaries; `pnpm pack:check` completes 15/15 tasks.
- Prod validation: 26/26 app tests pass, including all four ping surfaces, configured-prefix development-guild text dispatch, disabled text capability gating, authoritative command refresh, and gateway wiring.
