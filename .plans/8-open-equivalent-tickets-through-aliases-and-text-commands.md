# #8 Open equivalent tickets through aliases and text commands

## Summary

Route `/report` and `/debugshare` slash aliases plus configurable-prefix
`issue`, `report`, and `debugshare` text triggers to the single app-owned
create-ticket action, recording the originating trigger. Most of this scope
shipped with #7 (PR #28): all three slash aliases, prefix text triggers via
`TEXT_COMMAND_PREFIX` (empty prefix disables them and drops the message
intents), `originating_alias` persistence, bot/webhook filtering, auto-deleting
minimal-link text acknowledgements, and ephemeral slash replies. The remaining
gap is structural: the `MessageCreate` listener discards the `consumed` flag,
so nothing guarantees a consumed text command never continues into the future
AI message pipeline (`@protocord/ai` is still a boundary stub).

## Acceptance criteria

- [ ] All aliases produce equivalent ticket domain behavior while recording the originating trigger.
- [ ] The configured prefix is honored and an empty prefix disables text triggers.
- [ ] Text acknowledgements expose only a minimal thread link and auto-delete.
- [ ] Bot and webhook messages are ignored.
- [ ] Text command messages never continue into the AI message pipeline.
- [ ] Slash output remains ephemeral.
- [ ] Automated checks pass before the mandatory human validation gate is handed off.

## TODOs

- [x] Record the plan for #8 with the audit of what #7 already delivered.
- [x] Add an unconsumed-message seam: the gateway forwards a message downstream only when text-command dispatch did not consume it, so consumed text commands can never reach the future AI pipeline; cover with gateway/runtime tests.
- [x] Audit alias-equivalence test coverage (same domain behavior across all six triggers with correct origin metadata) and add any missing focused tests.
- [ ] Run the full `pnpm check`, update the plan, push, and file the PR with the human validation gate called out.

## Notes

- Blocker #7 is closed; parent #1 remains open.
- Implementation delegated to Codex (gpt-5.6-sol, high reasoning effort) per user instruction; orchestration, verification, and commits stay with Claude.
- Evidence for the shipped scope: `apps/prod/src/actions/create-ticket.ts` (aliases + both trigger kinds, ephemeral defer), `packages/protocord/src/text-commands.ts` (prefix normalization, empty-prefix disable, bot/webhook filter), `apps/prod/src/config.ts` (`TEXT_COMMAND_PREFIX`, default empty), `apps/prod/src/schema.ts` (`originating_alias`), `apps/prod/src/actions/runtime.ts` (30s auto-delete reply), `apps/prod/src/discord.ts` (intents gated on prefix presence).
- Gap evidence: `apps/prod/src/discord.ts` `MessageCreate` listener calls `handleMessage` fire-and-forget and ignores the returned `consumed` boolean; no downstream message-consumer seam exists.
- Seam implementation (Codex gpt-5.6-sol:high): `DiscordActionSurface.handleUnconsumedMessage` added; the `MessageCreate` listener awaits `handleMessage` and forwards downstream only when not consumed; dispatch errors are terminal (no fall-through); message intents now also key on the downstream hook; runtime passes the optional hook through for future application wiring. Four gateway tests cover consumed, unconsumed, rejection, and downstream-only paths.
- Seam validation: `pnpm --filter @prod/app test` (210/210, with `--config.verify-deps-before-run=false` — the preflight needs a TTY in this environment), typecheck, and lint all passed.
- Codex-only review-loop round one found that bot/webhook messages marked unconsumed by the text provider would reach the downstream seam, plus missing text-alias and runtime-composition coverage. The gateway now drops bot/webhook messages before either handler, all three text aliases prove their originating metadata and transient reply behavior, and the disabled-prefix runtime path proves the downstream hook is preserved.
- Codex-only review-loop round two found that the text triggers discarded their optional summary despite the product spec requiring the same summary behavior across all six triggers, and that composition coverage exercised the downstream hook only with text commands disabled. Text triggers now pass a non-empty argument tail as the opening summary, and runtime tests preserve both handlers in enabled-prefix mode as well as the downstream-only disabled-prefix mode.
- Codex-only review-loop round three found one remaining coverage gap around downstream-handler rejection. The gateway suite now proves downstream failures are awaited and routed through the centralized action error handler.
- PR precedent: #28 used `Closes #7` with the mandatory HITL checklist completed before merge; #8 follows the same pattern.
