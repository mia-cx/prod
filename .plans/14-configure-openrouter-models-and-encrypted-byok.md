# #14 Configure OpenRouter models and encrypted BYOK

## Summary

Implement `@mia-cx/protocord-model-settings` as a reusable consumer of
`@protocord/settings`. The package owns persisted model selection, AES-256-GCM
guild credentials, deployment fallback, and a complete masked settings
category. The initial UI exposes OpenRouter as the
only provider and accepts model IDs directly; Prod composes the category and
the package schema into its application-owned migration history.

## Acceptance criteria

- [x] The package registers a complete model settings category without Prod-specific code inside `@protocord/settings`.
- [x] Model IDs are entered directly without a live catalog selector.
- [x] Guild API keys use AES-256-GCM with a fresh nonce and separate ciphertext, tag, nonce, and hint.
- [x] Clearing a guild key falls back to deployment credentials.
- [x] Wrong encryption keys and malformed ciphertext fail safely.
- [x] Secrets, ciphertext, authorization headers, and full keys never appear in logs or UI.
- [x] The package builds, tests, migrates through Prod's aggregate history, and packs independently.

## TODOs

- [x] Add the package-owned model schema and SQLite store with AES-256-GCM credential persistence and adversarial tests.
- [x] Define secure guild/deployment resolution semantics with focused tests.
- [x] Export and test a complete reusable model settings category with provider selection, direct model entry, masked status, key replacement, and clearing.
- [x] Compose the package into Prod configuration, settings authorization, and the application-owned migration; then run repository validation.

## Human validation

- [x] Automated checks pass before requesting credentials or human action.
- [ ] Provide Discord credentials, an OpenRouter API key, and a generated 32-byte base64 encryption key through local secrets. Select OpenRouter, configure a model ID, configure and clear BYOK in Discord, restart Prod, make a minimal authenticated model request, verify deployment fallback, and inspect logs/UI for accidental secret exposure.
- [ ] Record the validation outcome without secrets, raw tokens, private ticket content, or unredacted diagnostics.

## Notes

- 2026-07-17: `~/mia-cx/prod` was already aligned with `origin/main` after `git pull --ff-only origin main`; its existing untracked `.worktrees/` directory was left untouched.
- 2026-07-17: The supplied worktree is clean on `t3code/fast-forward-main-2` at `origin/main`; blockers #4, #5, and #6 are closed.
- 2026-07-17: The canonical persistence decision separates schema from migration ownership: this package exports its Drizzle declarations, while Prod generates and applies the single deployment migration stream.
- 2026-07-17: The mandatory Discord/OpenRouter validation is HITL. The implementation PR must reference rather than close #14 until a human records a redacted passing result.
- 2026-07-17: Added the package-prefixed model configuration schema and SQLite store. Credentials use validated 32-byte base64 master keys, fresh 12-byte nonces, separate ciphertext/auth-tag/nonce/hint columns, authenticated decryption, guild-first resolution, and atomic credential clearing. The package has 6 passing tests; focused test, typecheck, lint, and build commands pass.
- 2026-07-17: Added an injected provider-catalog boundary with bounded, deduplicated model suggestions and deliberately detail-free failure results so catalog outages never disable manual entry or leak adapter errors. Secure resolution now has a public contract for guild-first, deployment-fallback, and unavailable outcomes. All 9 package tests, typecheck, lint, and build pass.
- 2026-07-17: Exported the complete `Model` category with fixed OpenRouter provider status, catalog selection, independent manual model entry, BYOK replacement and clearing, masked credential source, caller-supplied authorization, and no secret prefill. Catalog outages render a safe keep-current selector while manual entry continues to mutate normally. All 14 package tests, typecheck, lint, and build pass.
- 2026-07-17: Prod now composes the Model category under the existing fresh settings authorization check, validates the required encryption key and deployment-controlled OpenRouter endpoint, redacts configured secrets, and injects an OpenRouter catalog adapter whose errors never include response or authorization details. Generated aggregate migration `0003` creates the package-owned model table.
- 2026-07-17: Final `corepack pnpm check` passes all 32 boundary, lint, typecheck, test, and build tasks; the model package has 14 passing tests and Prod has 85. Final `corepack pnpm pack:check` passes all 15 build and package checks. The two real Discord/OpenRouter HITL items remain intentionally pending.
- 2026-07-20: Flattened Model into one direct settings page. The page now has a one-option OpenRouter provider select, an API-key section, and a direct model-ID section; the live catalog selector is no longer composed into settings.
- 2026-07-22: Review loop round six (confirmation) on `6502e07`: all four correctness/security reviewers plus GPT coverage clean; CI, Cursor Bugbot, and CodeRabbit green. Claude coverage surfaced two test-only pins, both landed: direct `validate` assertions for all three category fields (ends the recurring validate/mutate-drift concern) and a partial-null credential-row test proving `ModelCredentialError` on tampered rows. Three consecutive rounds produced zero behavior defects — the loop is converged; remaining work is the HITL Discord/OpenRouter validation.
- 2026-07-22: Review loop round five on `fd57a0c`: five of six reviewers fully clean (both correctness, both security, GPT coverage); round-four fixes verified including against freshly packed tarballs. One coverage gap fixed: the store's `assertIdentifier` throw path — the package's own validation boundary — now has direct rejection tests (constructor, `get`, `setModel`), plus an `OPENROUTER_API_KEY` whitespace-rejection config test. Round six is the confirmation round.
- 2026-07-22: Review loop round four on `e8afd8a`: four of six reviewers fully clean (both security, Claude correctness, GPT coverage); CI and bots green. Two real findings fixed: packed tarballs declared source-only `development` export conditions that `files: ["dist"]` excludes (now stripped at pack time via `publishConfig.exports` in all five packages, verified against a real tarball), and `decodeEncryptionKey`'s canonical-base64 round-trip check had no test (now covered with a non-canonical 32-byte-decoding key). Declined: driving invalid input through the runtime `validate` path (mutate re-runs the identical check before persistence).
- 2026-07-22: Review loop round three on `137539f`: GPT security clean; three reviewers independently converged on a config/store validation mismatch (backticks), now unified behind a shared `isValidModelIdentifier` allow-list used by the store, category, and Prod config. Also landed: credentials cleared when `setModel` changes the provider (AAD would otherwise brick them), hint-threshold boundary tests, empty-key tests, category error-path tests, a deployment-credential render integration test, a dev-fixture `--conditions=development` assertion, and a `postbuild` compiled-exports import check. Still deliberately deferred to inference wiring: redaction of dynamically decrypted guild keys at the provider HTTP boundary.
- 2026-07-22: Review loop round two ran the six-reviewer matrix (correctness/security/coverage × Claude/GPT) on `b7516e2`; both correctness and both security reviewers were clean, and PR CI plus all three bots passed. Landed hardening from latent findings — AAD now binds to the stored provider row, fixed-width key hints (24-char reveal threshold) stop leaking length, identifiers reject backticks — plus coverage: corrupted-ciphertext/tag decryption tests, config-validation tests, a shared `configSecrets` helper proving entrypoint redaction, full interaction-runtime integration tests for the model category, and a dev-watch auto-discovery restart test (root override via `DEV_WATCH_PACKAGES_ROOT`). Deliberately declined: log-redaction of dynamically resolved guild keys (no consumer exists yet — must be handled when inference wiring lands) and the `ensure()` "race" (better-sqlite3 is synchronous; no interleaving point).
- 2026-07-21: Review loop round one (Fable + local Codex) landed four fixes: restored the committed two-migration history instead of the uncommitted squash that rewrote main's `0000`; deleted the now-unreferenced provider-catalog stack (package catalog module, Prod OpenRouter adapter, `OPENROUTER_BASE_URL` config); removed the injectable `createNonce` seam so AES-GCM nonces are always freshly random; and stopped `keyHint` revealing affixes of keys shorter than 16 characters. Prod's drizzle instance was verified to run without a query logger, so credential columns stay out of logs.
