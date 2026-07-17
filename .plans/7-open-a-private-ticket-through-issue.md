# #7 Open a private ticket through /issue

## Summary

Implement the first reporter ticket path end to end. A reporter can use any
ticket-opening alias with an optional sanitized summary; Prod persists a
provisioning ticket, grants only shared hub/thread access, creates an
invite-only private thread, adds the reporter, posts deterministic DEBUGSHARE
instructions, and returns the private thread link. Partial failures are audited
and compensated, and startup reconciles interrupted provisioning idempotently.

## Acceptance criteria

- [ ] Multiple open tickets per reporter are supported.
- [ ] The hub contains no ticket content and the reporter cannot create or write outside ticket threads.
- [ ] Ticket state moves from provisioning to open only after Discord resources succeed.
- [ ] Discord and database partial failures are compensated and audited.
- [ ] Startup reconciles stale provisioning rows safely.
- [ ] The optional opening summary is sanitized and appears in the opening message.
- [ ] Automated tests cover privacy-relevant permission overwrites and idempotent recovery.
- [ ] Automated checks pass before the mandatory real-environment validation gate is handed to a human.

## TODOs

- [x] Add the application-owned ticket and event schema, migration, SQLite store, and persistence tests.
- [ ] Implement Discord ticket provisioning, sanitized deterministic instructions, compensation, and focused privacy/idempotency tests.
- [ ] Register `/issue`, `/report`, `/debugshare` and prefix-text aliases with private/minimal link presentation and runtime tests.
- [ ] Reconcile stale provisioning tickets after Discord startup, run the full automated checks, and document the pending human validation gate.

## Notes

- Issue #6, the sole blocker, is closed.
- Canonical `/home/mia/mia-cx/prod` `main` was fetched and confirmed equal to `origin/main` before work began; its existing untracked `.worktrees/` directory was preserved.
- This supplied branch started exactly at the fetched `origin/main` commit `73f94d2`.
- A deterministic hidden ticket marker in the opening instructions will make recovery safe if Discord succeeds immediately before a database write fails.
- Reporter overwrite cleanup will query for other active (`provisioning` or `open`) tickets before removing shared hub access.
- The issue must remain open until the mandatory real-Discord checklist is completed by a human; the PR will explicitly call out that gate.
- Persistence validation: `corepack pnpm build`, focused app tests (the app runner executed all 82 tests), app typecheck, and app lint passed.
