## Agent skills

### Issue tracker

Work is tracked in GitHub Issues for `mia-cx/prod`, using the organization's Issue Types. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the repository's existing labels; execution readiness is recorded in issue bodies instead of adding an AFK/HITL label taxonomy. See `docs/agents/triage-labels.md`.

### Domain docs

Prod uses a single root domain context shared by the app and its extractable packages. See `docs/agents/domain.md`.

### Migration resets

Prod has no production environment or production data. If migrations fail, prefer deleting the local database and regenerating the migration history from scratch instead of preserving or repairing the existing database.
