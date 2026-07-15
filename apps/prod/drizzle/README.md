# Prod-owned migrations

Prod owns the single ordered migration history for the database it deploys.
Installed extensions expose Drizzle tables through public `./schema` entrypoints;
`apps/prod/src/schema.ts` selects and re-exports those tables alongside Prod's own
tables. Run `pnpm db:generate` from the repository root to diff that aggregate
schema and write generated migrations here.

Extensions must not publish or apply a parallel migration history. The checked-in
empty journal allows startup to run Drizzle's real migrator before the first table
is implemented.
