# #14 Configure OpenRouter models and encrypted BYOK

## Summary

Implement `@mia-cx/protocord-model-settings` as a reusable consumer of
`@protocord/settings`. The package owns persisted model selection, AES-256-GCM
guild credentials, injected provider catalog access, deployment fallback, and a
complete masked settings category; Prod composes the category and the package
schema into its application-owned migration history.

## Acceptance criteria

- [x] The package registers a complete model settings category without Prod-specific code inside `@protocord/settings`.
- [x] Provider catalog failures leave manual model entry usable.
- [x] Guild API keys use AES-256-GCM with a fresh nonce and separate ciphertext, tag, nonce, and hint.
- [x] Clearing a guild key falls back to deployment credentials.
- [x] Wrong encryption keys and malformed ciphertext fail safely.
- [x] Secrets, ciphertext, authorization headers, and full keys never appear in logs or UI.
- [x] The package builds, tests, migrates through Prod's aggregate history, and packs independently.

## TODOs

- [x] Add the package-owned model schema and SQLite store with AES-256-GCM credential persistence and adversarial tests.
- [x] Define injected provider catalog access and secure guild/deployment resolution semantics with focused tests.
- [x] Export and test a complete reusable model settings category with catalog suggestions, manual entry, masked status, key replacement, and clearing.
- [x] Compose the package into Prod configuration, OpenRouter catalog access, settings authorization, and the application-owned migration; then run repository validation.

## Human validation

- [x] Automated checks pass before requesting credentials or human action.
- [ ] Provide Discord credentials, an OpenRouter API key, and a generated 32-byte base64 encryption key through local secrets. Configure and clear BYOK in Discord, fetch the live catalog, restart Prod, make a minimal authenticated model request, verify deployment fallback, and inspect logs/UI for accidental secret exposure.
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
