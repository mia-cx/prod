# #13 Pause, resume, close, and reopen tickets

## Summary

Implement authorized manual triage control and the full ticket close/reopen
lifecycle. Staff can pause and resume AI triage on tickets in allowed states,
close tickets (marking them closed with triage paused, auditing the
transition, and locking/archiving the private thread), and reopen tickets
(restoring reporter hub access, unlocking/unarchiving the thread, keeping
triage paused, and preserving summaries, labels, suggestions, and assignees).
Closing a reporter's final open ticket removes their shared hub overwrite;
other open tickets retain it. Duplicate and concurrent transitions resolve
safely via state-conditional transactional updates.

## Acceptance criteria

- [x] Pause and resume are valid only for allowed ticket states.
- [x] Closing sets closed plus paused, audits the transition, and locks/archives the thread.
- [x] Closing the final open ticket removes the reporter hub overwrite while other open tickets retain it.
- [x] Reopening restores access, unlocks/unarchives, and remains paused.
- [x] Summaries, labels, suggestions, and assignees survive reopen.
- [x] Duplicate and concurrent transitions resolve safely.
- [x] Automated checks pass before the mandatory real-environment validation gate is handed to a human.

## TODOs

- [x] Add lifecycle event types and state-conditional transactional store methods (close, reopen, pause triage, resume triage) with persistence tests.
- [x] Add thread lock/unlock adapter methods and close/reopen Discord orchestration with final-ticket hub-overwrite maintenance and focused tests.
- [x] Register staff `/close`, `/reopen`, and `/triage pause|resume` actions with ticket-scoped authorization and runtime tests.
- [x] Run the full automated checks and document the pending human validation gate.

## Notes

- Blockers #7 and #9 are closed; branch `t3code/issue-thirteen` starts at `origin/main` commit `051e5c8`.
- Spec anchors: state model and transition rules (spec §4), close/reopen sequences (spec §15), command table `/close [ticket] [reason]`, `/reopen <ticket>`, `/triage pause|resume [ticket]` with no text triggers (spec §8), edge cases (spec §16).
- `tickets.status` already includes `closed`; pause is `triageStatus: "paused"` — no new columns needed. `ticketEvents.eventType` enum needs lifecycle members (TS-only; the SQL column is unconstrained text, so no migration).
- Allowed transitions: close from open (any triage status) → closed+paused; reopen from closed → open+paused; pause from open+collecting → paused; resume from open+ready|paused → collecting. Guard with re-read inside `database.transaction`, mirroring `requireProvisioning`.
- Reuse `hasOtherActiveTicket` + the compensate-style restore sequence (`getReporterAccess` → `restoreReporterAccess` → `finishReporterAccess`) for final-ticket overwrite removal; count other open tickets after marking closed.
- Thread ops: `setLocked` is new (no existing helper); order is lock→archive on close, unarchive→unlock on reopen. Serialize under the existing guild + hub keyed executors.
- Authorization: verbs `close`, `reopen`, `pause_triage`, `resume_triage` and presets already exist in protocord-permissions and `permission-administration.ts`; actions check permissions inside execute via `AuthorizationService.require` (settings.ts pattern). `application.ts` `validateResource` must learn `objectType: "ticket"`.
- Reopening never resumes AI automatically; summaries/labels/suggestions/assignees are simply not touched by reopen — tests must prove they survive.
- Implementer: codex `gpt-5.6-sol` at high reasoning effort; orchestration, verification, and commits stay here.
- TODO 1 passed three Codex-only adversarial review rounds. A reproduced cross-connection `SQLITE_BUSY_SNAPSHOT` race was fixed with bounded retry and fresh-state re-read; rollback and linked-label preservation are covered.
- TODO 1 validation: lifecycle suite 30/30 passed; full app suite 222/222 passed; app typecheck, lint, build, and `git diff --check` passed.
- TODO 2 validation: ticket provisioning suite 40/40 passed; app typecheck and lint passed. Close/reopen is serialized by guild and hub, reconciles duplicate target states, preserves shared access until the final open ticket closes, and applies Discord thread state in the specified order.
- TODO 3 validation: action and ticket suites 56/56 passed; app typecheck and lint passed. Lifecycle commands are ephemeral, infer optional ticket IDs from the current thread, require exact-ticket permissions, and application resource validation confirms the ticket belongs to the authorization guild.
- TODO 4 validation: `corepack pnpm check` passed all 32 Turbo tasks across 8 packages; the Prod app passed 231/231 tests across 21 files. Package boundaries, lint, typecheck, tests, and builds all passed.
- Mandatory HITL gate: issue #13 stays open until a human validates pause/resume/close/reopen against real Discord with staff and reporter accounts.
- Human handoff: configure development Discord credentials and authorized staff/reporter accounts; open two tickets for one reporter; verify pause/resume state, close lock+archive, retained hub overwrite after the first close, overwrite restoration after the final close, reopen access+unarchive+unlock with triage still paused, preserved metadata, and harmless repeated/invalid commands. Record only the outcome—never tokens, private ticket content, or raw diagnostics.
- Review loop cycle 1: fixed close/reopen partial-failure reconciliation, former-hub and already-open reopen rejection, fresh and serialized authorization rechecks, mention suppression, and lifecycle reply wording. `corepack pnpm check` passed all 32 tasks; Prod passed 236/236 tests.
- Review loop cycle 2: fixed stale ownership compensation, shared-access close rollback, lost-close stale returns, and the reopen authorization mutation boundary; non-closed reopen snapshots now reject without racing into unreconciled success. `corepack pnpm check` passed all 32 tasks; Prod passed 238/238 tests.
