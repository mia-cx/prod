# Domain docs

Prod uses a single domain context across `apps/prod` and its reusable packages. Package boundaries do not create separate product vocabularies.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant decisions under `docs/adr/` when they exist.
- Treat `prod-discord-ticketing-bot-mvp.md` as the canonical MVP plan until a later document explicitly supersedes it.

If `CONTEXT.md` or `docs/adr/` does not yet exist, proceed without flagging its absence. Create domain documentation lazily when terminology or architectural decisions need a durable home.

## Vocabulary

Use the canonical terms from the domain context and MVP plan in issue titles, acceptance criteria, tests, and implementation. In particular, use `assignee`, not `claimant`; `/claim` and `/unclaim` are actions that add or remove an assignee.

Surface any conflict with an existing ADR rather than silently overriding it.
