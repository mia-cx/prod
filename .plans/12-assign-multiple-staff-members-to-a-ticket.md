# #12 Assign multiple staff members to a ticket

## Summary

Add many-to-many ticket assignment. Staff self-claim and self-unclaim through
`/claim` and `/unclaim`; delegated `/assign` and `/unassign` act on a chosen
target under a distinct permission and require the target to be eligible to
self-claim. Assignment rows carry provenance, every change is audited as a
ticket event, duplicate adds/removals are idempotent no-ops, the first
assignee pauses triage, and removing the final assignee leaves triage paused.

## Acceptance criteria

- [ ] Claim and delegated assignment add rows without a single-assignee field.
- [ ] Unclaim removes only the invoking assignee and delegated unassign removes the selected assignee.
- [ ] Duplicate adds/removals are idempotent.
- [ ] Delegated assignment requires its distinct permission and the target must be eligible to self-claim.
- [ ] Adding the first assignee pauses triage; later additions preserve state.
- [ ] Removing the final assignee does not resume triage.
- [ ] Assignment provenance and events are persisted.
- [ ] Automated checks pass before the mandatory real-environment validation gate is handed to a human.

## TODOs

- [x] Add the `ticket_assignees` schema, migration, assignment ticket events, and ticket-store assignment methods (idempotent add/remove with provenance, thread lookup, first-assignee triage pause in one transaction) with persistence tests.
- [ ] Implement the ticket assignment service enforcing `claim_self`/`unclaim_self`/`assign_other`/`unassign_other` authorization, target self-claim eligibility for delegated adds, idempotent outcomes, and audit events, with unit tests.
- [ ] Register `/claim`, `/unclaim`, `/assign`, `/unassign` actions resolving the ticket from the invoking thread with ephemeral presentation, and extend the authorization resource validator plus application wiring to ticket objects, with runtime tests.
- [ ] Run the full automated checks, record results, and document the pending human validation gate.

## Notes

- Blockers #7 and #9 are closed; parent #1 remains open.
- Permission verbs `claim_self`, `unclaim_self`, `assign_other`, `unassign_other` already exist in the schema enum (`apps/prod/src/schema.ts` permissionRuleOrigins); the authorization resource validator in `application.ts` currently only admits `settings`/`permissions` objects with objectId `*` and must learn ticket objects.
- Triage semantics: adding the first assignee sets `triageStatus` to `paused`; later adds preserve whatever state is present; removing the final assignee leaves `triageStatus` untouched (no resume).
- Target eligibility for delegated assignment = an authorization check of `claim_self` for the target member's subject, so eligibility follows permission changes automatically.
- Tickets already have a unique `tickets_thread` index, enabling thread → ticket resolution for in-thread commands.
- Mandatory HITL gate: the issue stays open after the PR; the PR uses `Refs #12` and calls out the human validation checklist.
- Implementation is delegated to codex (gpt-5.6-sol, high reasoning) per task, with orchestrator verification of diffs and tests before each commit.
- Persistence validation: migration `0002_shallow_the_order.sql` creates only `ticket_assignees` plus its assignee index; `addAssignee`/`removeAssignee` run status check, idempotency check, triage pause, and event insert in one transaction. App `pnpm test` (204/204), `pnpm typecheck`, and `pnpm lint` all passed locally; codex's reported `dev-process` failures were its sandbox environment only.
