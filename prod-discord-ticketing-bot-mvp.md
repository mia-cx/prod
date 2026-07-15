# Prod Discord Ticketing Bot MVP

## Summary

Build Prod as a multi-guild Discord ticketing bot using TypeScript, Node 24, discord.js, Effect schemas, Drizzle, SQLite, and pnpm.

The MVP will:

- Create isolated private support threads through `/issue`, `/report`, or `/debugshare`.
- Guide reporters through AI-assisted triage and DEBUGSHARE collection.
- Stop automated responses when triage is complete or staff takes over.
- Allow staff and AI to apply configured labels.
- Use a claim queue with AI-generated assignee suggestions; AI assignment is deferred.
- Support staff-only claiming, closing, reopening, and triage controls.
- Provide guild-scoped Components v2 settings, configurable permissions, labels, identity/tone, OpenRouter model selection, and encrypted BYOK.
- Persist ticket metadata and audit events while leaving message content in Discord.
- Ship the same deployment surfaces as Honeybot: Dockerfile, Compose, raw Kubernetes resources, Helm chart, CI, and container publishing.

External ticket-system forwarding and knowledge-base ingestion are explicitly deferred.

## 1. Project foundation

Scaffold an independent service rather than creating a runtime dependency on Patch or Honeybot.

Reuse and adapt:

- Patch’s canonical action/trigger registry, Discord dispatcher, model tool exposure, availability checks, and conflict validation.
- Honeybot’s Components v2 settings builder, guild configuration authorization, SQLite/Drizzle patterns, `ModelStore`, AES-256-GCM BYOK encryption, deployment files, and CI conventions.

Use:

- Node 24
- TypeScript ESM
- pnpm
- discord.js 14
- Effect schemas for environment, action input, model output, and persisted-domain validation
- Drizzle ORM with `better-sqlite3`
- Vitest
- ESLint and Prettier
- Structured logging with secrets redacted

Repository layout:

```text
src/
  actions/
  ai/
  db/
  discord/
  domain/
  events/
  interactions/
  prompts/
  queues/
  services/
  settings/
  index.ts
prompts/
  triage-system.md
drizzle/
docker/
k8s/
charts/prod/
tests/
fixtures/triage/
```

## 2. Ticket space and Discord permissions

Each guild configures one text channel as its support hub.

The hub follows an “empty hub” privacy contract:

- The bot may maintain one informational message explaining the channel and the issue commands.
- No ticket content is posted in the hub.
- Reporters cannot send messages or create threads in the hub.
- When a reporter has at least one open ticket, their channel overwrite allows:
  - `ViewChannel`
  - `ReadMessageHistory`
  - `SendMessagesInThreads`
  - `UseApplicationCommands`
- Their overwrite explicitly denies:
  - `SendMessages`
  - `CreatePublicThreads`
  - `CreatePrivateThreads`
- Prod creates a private thread and explicitly adds the reporter.
- Staff access private threads through `ManageThreads` or explicit membership.

This preserves usable thread history. Discord private threads inherit parent permissions, and denying parent history would also impair the ticket thread; private-thread visibility itself remains invitation- or moderator-based. [Discord thread permissions](https://docs.discord.com/developers/topics/threads)

The bot install requires only the relevant permissions:

- View channels
- Manage channels/permission overwrites
- Create private threads
- Manage threads
- Send messages
- Send messages in threads
- Read message history
- Use application commands
- Embed links

Gateway intents:

- Guilds
- Guild members
- Guild messages
- Message content

## 3. Ticket lifecycle

Model ticket lifecycle as orthogonal state:

```ts
type TicketStatus = "provisioning" | "open" | "closed" | "failed";
type TriageStatus = "collecting" | "ready" | "paused";
```

Assignment is separate:

```ts
type TicketAssignment = {
  claimedByUserId: string | null;
  suggestedAssigneeUserId: string | null;
};
```

Transitions:

1. Creation starts as `provisioning` + `collecting`.
2. Successful Discord provisioning changes it to `open`.
3. AI collects information while `triageStatus === "collecting"`.
4. Completed triage changes it to `ready`.
5. Claiming sets `claimedByUserId` and changes triage to `paused`.
6. Manual pause changes triage to `paused`.
7. Resume is allowed only on open tickets and changes triage to `collecting`.
8. Closing changes the ticket to `closed`, pauses triage, locks and archives the thread.
9. Reopening changes it to `open` while leaving triage paused and preserving the previous claimant, summaries, and labels.
10. Staff must explicitly resume AI triage after reopening.

Multiple open tickets per reporter are supported.

When closing the reporter’s last open ticket, remove their hub overwrite. If other open tickets remain, retain it. Reopening restores the overwrite if necessary.

## 4. Ticket creation and failure recovery

The canonical `create_ticket` action has three slash triggers:

- `/issue [summary]`
- `/report [summary]`
- `/debugshare [summary]`

All accept the same optional short summary and invoke identical domain behavior while recording the originating alias.

Creation sequence:

1. Validate guild context, configured hub, reporter membership, and bot permissions.
2. Insert a `provisioning` ticket with a generated stable ID.
3. Ensure the reporter’s shared hub overwrite exists.
4. Create a private thread named with the short ticket ID and sanitized summary.
5. Add the reporter as a thread member.
6. Post deterministic opening instructions:
   - Confirm the supplied summary, if any.
   - Explain that the reporter should send `DEBUGSHARE` to Poke and paste Poke’s response.
   - Ask for what happened, what was expected, and relevant reproduction context.
7. Persist the thread ID and mark the ticket open.
8. Reply to the original command ephemerally with the thread link.

On partial failure:

- Delete the newly created thread when possible.
- Remove the reporter overwrite only if they have no other open ticket.
- Mark the ticket `failed`.
- Record the failure and compensation results in the event log.
- Return an ephemeral, actionable error.

At startup, reconcile stale `provisioning` tickets by inspecting their stored Discord resources, completing safe recoveries or marking them failed.

## 5. Action and trigger architecture

Define domain actions independently of Discord or model presentation:

```ts
type Action<Input, Output> = {
  name: string;
  description: string;
  inputSchema: Schema.Schema<Input>;
  triggers: ActionTrigger<Input>[];
  availability(context: AvailabilityContext): ActionAvailability;
  authorize(invocation: ActionInvocation<Input>, context: ActionContext): Promise<void>;
  execute(invocation: ActionInvocation<Input>, context: ActionContext): Promise<Output>;
};
```

Supported triggers:

```ts
type ActionTrigger =
  | SlashCommandTrigger
  | MessageContextMenuTrigger
  | ToolCallTrigger;
```

The registry will:

- Index action names and triggers by surface.
- Fail on duplicate action or trigger names.
- Validate parsed input before execution.
- Recheck availability and authorization at execution time.
- Reject model-tool triggers on staff-only or configuration actions.
- Generate Discord registration payloads and OpenRouter tool schemas from the same definitions.
- Keep response presentation in trigger adapters so domain actions remain reusable.

Initial actions:

| Action | Discord trigger | AI tool | Authority |
|---|---|---|---|
| `create_ticket` | `/issue`, `/report`, `/debugshare` | No | Any guild member |
| `view_ticket_queue` | `/tickets` | No | Staff |
| `view_ticket_info` | `/ticket-info [ticket]` | No | Staff |
| `claim_ticket` | `/claim [ticket]` | No | Staff |
| `unclaim_ticket` | `/unclaim [ticket]` | No | Current claimant or configurator |
| `change_ticket_label` | `/label add\|remove <label> [ticket]` | Add/remove label tools | Staff or AI |
| `suggest_assignee` | None | Yes | AI only |
| `complete_triage` | None | Yes | AI only |
| `close_ticket` | `/close [ticket] [reason]` | No | Staff |
| `reopen_ticket` | `/reopen <ticket>` | No | Staff |
| `set_triage_mode` | `/triage pause\|resume [ticket]` | No | Staff |
| `open_settings` | `/settings` | No | Configurators |

Commands with optional ticket selectors infer the ticket from the current thread first. Outside a ticket thread, a ticket ID is required. Autocomplete returns only tickets the staff member is authorized to manage.

Production commands are global. `DISCORD_DEV_GUILD_ID` switches to instant guild-scoped registration during development and clears the opposite scope. Discord recommends guild commands for rapid testing and global commands for released applications. [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)

## 6. Staff and configuration authorization

Reuse Honeybot’s separate authorization domains.

Ticket staff consists of configured:

- User IDs
- Role IDs

Bot configurators consist of separately configured:

- User IDs
- Role IDs

Fallback configuration authority:

- Guild owner
- Administrator
- Manage Guild

Fallback ticket authority:

- Guild owner
- Administrator
- Manage Guild
- Configured staff user or role

Configuration authority also permits ticket operations and forced unclaiming.

Every action performs runtime authorization even if Discord command visibility is customized externally.

## 7. AI triage pipeline

Use OpenRouter only for the MVP, behind a provider adapter interface.

The pipeline runs only when:

- The message is in a persisted open ticket thread.
- The author is the reporter.
- Triage status is `collecting`.
- The ticket is unclaimed.
- The message has not already been processed.

Serialize work per ticket and rate-limit by guild to avoid overlapping replies.

### Internal planner pass

The planner receives:

- The fixed base system prompt.
- Escaped ticket transcript from Discord.
- Opening summary and ticket state.
- Configured labels and descriptions.
- Eligible staff candidates with current claimed-ticket counts.
- Model-visible safe actions.

Available tools:

- `add_ticket_label`
- `remove_ticket_label`
- `suggest_assignee`
- `complete_triage`

The planner’s output is never shown to the reporter. Tool calls execute through the action registry. Use a bounded tool loop with schema validation and a maximum of three rounds.

`complete_triage` requires:

```ts
type CompleteTriageInput = {
  reporterSummary: string;
  internalSummary: string;
};
```

It stores both summaries and changes triage to `ready`.

### Reporter response pass

The reporter responder does not receive labels, assignees, internal summaries, or other staff-only metadata.

If triage remains collecting, it generates the next concise follow-up question using:

- Base behavior prompt
- Guild identity and tone
- Reporter-visible transcript

If triage was completed, skip another unconstrained model response and post a deterministic confirmation containing `reporterSummary`, followed by a request to correct anything inaccurate.

Prod then remains silent unless staff resumes triage.

### Failure behavior

AI failure never prevents ticket creation or staff handling.

On model timeout, invalid output, exhausted retry, missing API key, or rate limiting:

- Log a redacted diagnostic.
- Leave the ticket open and collecting.
- Avoid duplicate replies.
- Send a short fallback only when needed, telling the reporter their information has been saved and staff can continue manually.

## 8. Prompt and knowledge scope

Add a version-controlled `prompts/triage-system.md` defining:

- Prod’s support role.
- The DEBUGSHARE workflow.
- What information to collect.
- When triage is complete.
- How to summarize without inventing facts.
- Prompt-injection resistance.
- Prohibition on exposing staff-only metadata.
- When to use label and suggestion tools.
- When to stop responding.

Guild settings may customize:

- Assistant display identity used in responses; default `Prod`.
- Tone instruction; default friendly, patient, and concise.

The Discord bot username remains unchanged.

No Markdown knowledge ingestion, MCP integration, embeddings, document storage, or retrieval is included. Preserve an AI context-builder seam so knowledge sources can be added later.

## 9. Settings UI

Port Honeybot’s data-driven Components v2 settings builder and route structure.

`/settings` opens an ephemeral panel with these categories:

### Setup

- Select support hub.
- Show required bot/channel permissions.
- Post or refresh the single hub information message.
- Configure assistant identity.
- Configure tone.

### Permissions

- Staff users
- Staff roles
- Configurator users
- Configurator roles

### Labels

Seed new guilds with:

- `bug`
- `account`
- `gameplay`
- `feedback`
- `other`

Each label has:

- Stable ID
- Display name
- Normalized unique name
- Description supplied to the AI
- Active/inactive state

Removing a label deactivates it so historical ticket associations remain intact.

### Model

- Provider displayed as fixed `openrouter`.
- Select or enter the triage model.
- Fetch OpenRouter’s model catalog for suggestions.
- Set encrypted guild API key.
- Clear guild API key and fall back to deployment credentials.
- Display only a masked key hint.
- Show whether the guild is using BYOK or deployment defaults.

All component/modal routes recheck configurator authorization.

## 10. Staff-only metadata UX

Do not create a synchronized staff dashboard in the MVP.

`/tickets` returns an ephemeral paginated queue containing:

- Ticket ID and thread link
- Reporter
- Status and triage status
- Active labels
- Claimant
- Suggested assignee
- Creation/update timestamps

Filters:

- Open
- Unclaimed
- Claimed by me
- Ready for staff
- Closed

`/ticket-info` returns an ephemeral detailed view with:

- Reporter summary
- Internal summary
- Labels
- Claimant and suggestion
- Originating alias
- Lifecycle timestamps
- Recent audit events

Reporter-visible thread messages never include labels, assignment, suggestion, or internal summary.

## 11. Persistence model

Use checked-in Drizzle migrations applied automatically at startup.

Tables:

### `guild_settings`

```text
guild_id, key, value, updated_at
```

Stores hub ID, hub information message ID, assistant identity, tone, and initialization markers.

### `access_subjects`

```text
guild_id, scope, subject_type, subject_id, created_at
```

- `scope`: `staff | configurator`
- `subject_type`: `user | role`

### `models`

Honeybot-compatible structure restricted initially to purpose `triage`:

```text
guild_id, purpose, provider, model_id,
encrypted_api_key, api_key_hint, api_key_nonce, api_key_auth_tag,
created_at, updated_at
```

### `labels`

```text
id, guild_id, name, normalized_name, description, active,
created_at, updated_at
```

Unique active/normalized label name per guild.

### `tickets`

```text
id, guild_id, reporter_user_id, origin_trigger,
opening_summary, status, triage_status,
hub_channel_id, thread_id,
claimed_by_user_id, suggested_assignee_user_id,
reporter_summary, internal_summary,
last_triaged_message_id,
created_at, ready_at, closed_at, reopened_at, updated_at
```

### `ticket_labels`

```text
ticket_id, label_id, applied_by_type, applied_by_id, created_at
```

### `ticket_events`

```text
id, ticket_id, event_type, actor_type, actor_id,
reason, metadata_json, created_at
```

Persist metadata and audit history indefinitely. Do not copy Discord message bodies or DEBUGSHARE responses into SQLite. The summaries are the only derived textual ticket records.

## 12. BYOK security

Port Honeybot’s AES-256-GCM model-key storage:

- Require a base64-encoded 32-byte `API_KEY_ENCRYPTION_KEY`.
- Generate a fresh 12-byte nonce for every stored key.
- Store ciphertext, nonce, authentication tag, and masked hint separately.
- Never log request authorization headers, raw keys, ciphertext, or complete model payloads containing secrets.
- Use the guild key when present, otherwise `OPENROUTER_API_KEY`.
- Keep the OpenRouter base URL deployment-controlled, never guild-controlled.
- Treat model IDs as identifiers, not URLs.

User/thread text is wrapped as untrusted prompt content and escaped from internal prompt delimiters.

## 13. Hub and thread edge cases

Handle explicitly:

- Hub missing, deleted, or wrong channel type.
- Bot missing permission to edit overwrites or create/manage private threads.
- Reporter leaves the guild during provisioning or triage.
- Thread manually deleted, archived, unlocked, or renamed.
- Staff manually archives a collecting ticket.
- Reporter has multiple open tickets.
- Reporter invokes a ticket alias from inside an existing ticket.
- Duplicate Discord delivery of the same reporter message.
- Model finishes after staff claims or closes the ticket.
- Configured staff user leaves or loses their role.
- Configured label is deactivated while attached to open tickets.
- BYOK decryption fails after an encryption-key rotation.
- Discord API succeeds while the following database update fails, and vice versa.

Before committing AI results, re-read ticket state so late model output cannot modify a claimed or closed ticket.

## 14. Deployment and operations

Mirror Honeybot’s deployment surface, renamed for Prod:

- Multi-stage non-root Docker image.
- Persistent `/app/data` volume.
- Docker Compose service and named volume.
- Raw Kubernetes namespace, Secret, ConfigMap, PVC, and Deployment.
- Helm chart with:
  - Image settings
  - Single replica default
  - Recreate strategy
  - Persistent volume
  - Pod/container security contexts
  - External Secret support
  - Resource/node/affinity overrides
- SQLite deployments remain single-replica with `ReadWriteOnce` storage.
- GitHub Actions CI for lint, typecheck, tests, and build.
- Multi-architecture container publishing for amd64 and arm64.

Environment configuration includes:

```text
DISCORD_TOKEN
DISCORD_CLIENT_ID
DISCORD_DEV_GUILD_ID
DATABASE_URL
LOG_LEVEL
OPENROUTER_API_KEY
API_KEY_ENCRYPTION_KEY
DEFAULT_TRIAGE_MODEL
MODEL_CALL_LIMIT
MODEL_CALL_LIMIT_PER_GUILD
MODEL_CALL_WINDOW_SECONDS
MODEL_TIMEOUT_MS
TRIAGE_CONTEXT_MESSAGE_LIMIT
```

Use Honeybot’s current default OpenRouter model as the initial `DEFAULT_TRIAGE_MODEL`, while allowing deployment and guild overrides.

## 15. Tests and acceptance scenarios

### Action system tests

- Registers multiple slash aliases for one action.
- Routes slash and tool triggers to the same action.
- Rejects duplicate action and trigger names.
- Rejects tool triggers on staff/configuration actions.
- Validates inputs and rechecks availability/authorization.
- Ensures late state changes invalidate previously available actions.

### Persistence and security tests

- Guild defaults and generic labels initialize idempotently.
- Multiple tickets per reporter persist correctly.
- Ticket state transitions reject invalid transitions.
- Label deactivation preserves historical associations.
- BYOK encrypt/decrypt round trip succeeds.
- Wrong encryption key and malformed ciphertext fail safely.
- Logs and UI never expose complete API keys.
- Migrations work on an empty and already-initialized database.

### Ticket provisioning tests

- Successful alias invocation creates one private thread and membership.
- Optional summary appears in the opening message.
- DEBUGSHARE alias uses the same action.
- Partial Discord failures are compensated.
- Multiple open tickets retain the shared hub overwrite.
- Closing the final open ticket removes the overwrite.
- Reopening restores it and leaves AI paused.
- Closed threads are locked and archived.

### AI tests

- Only reporter messages trigger collecting-mode triage.
- Initial bot message is deterministic.
- Planner can apply configured labels through tools.
- Planner cannot invent or apply unknown labels.
- Suggested assignee is an eligible staff member and remains staff-only.
- Claiming during an in-flight model request discards the late result.
- Completing triage posts only the reporter-safe summary.
- Prod stays silent after ready, claim, pause, or close.
- Resume restarts triage only for an open ticket.
- Model failure leaves the ticket usable by staff.
- DEBUGSHARE content is recognized as collected but not parsed or fetched.
- Staff metadata is absent from reporter-response prompts.

### Settings tests

- Non-configurators cannot open or mutate settings.
- Staff and configurator scopes remain separate.
- Channel, user, role, model, key, label, identity, and tone controls round-trip.
- Hub information message posting is idempotent.
- Component and modal custom IDs route to the correct handler.

### End-to-end acceptance flow

1. Admin configures the hub, staff roles, and model through `/settings`.
2. Admin posts the hub information message.
3. Reporter runs `/issue summary:...`.
4. Prod grants hub access and creates an invite-only private thread.
5. Prod explains DEBUGSHARE and asks initial questions.
6. Reporter posts issue details and Poke’s DEBUGSHARE response.
7. Prod applies an internal configured label and suggests a staff member.
8. Prod confirms a reporter-safe summary and stops responding.
9. Staff sees the ticket through `/tickets` and `/ticket-info`.
10. Staff claims it; metadata remains invisible to the reporter.
11. Staff closes it; the thread locks and archives.
12. Staff reopens by ticket ID; access returns and AI remains paused.
13. Staff explicitly resumes triage if further automated intake is needed.

## Assumptions and deferred scope

- Prod is multi-guild even though the first deployment targets Interaction’s Poke Community.
- The support hub contains only a bot-managed informational message and no ticket traffic.
- Discord is the source of truth for message history; SQLite stores metadata, summaries, and audit events.
- One ticket has at most one claimant.
- AI assignment is deferred; AI only suggests a claimant in the MVP.
- Generic labels are editable per guild.
- The initial separate command names are provisional product wording but final implementation targets for this MVP; trigger metadata keeps later renaming localized.
- No reporter ticket-cancellation action is included initially; staff close tickets.
- No external ticket forwarding, webhook forwarding, MCP knowledge source, Markdown ingestion, retrieval, embeddings, or web dashboard is included.
- No automatic closed-ticket metadata purge is included.
