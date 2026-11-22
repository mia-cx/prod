# Prod

<a href="https://0rwx.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://0rwx.com/static/AI-W-dark.svg">
    <img alt="AI:W" src="https://0rwx.com/static/AI-W-light.svg" height="48">
  </picture>
</a>

A Discord support bot for managing tickets in your server.

## What it does

Prod organizes support threads into hubs, tracks ticket labels and assignees, and controls access through guild permissions.
Server settings include model selection and encrypted API keys for AI triage. Data lives in SQLite.

## Setup

Use Node.js 24 and pnpm 11.13.1.

```sh
git clone --recurse-submodules https://github.com/mia-cx/prod.git
cd prod
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
```

Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` in `.env` for your Discord application.
Set `API_KEY_ENCRYPTION_KEY` to the generated key.
Enable the Message Content intent in the Discord developer portal, then invite the bot with the `bot` and `applications.commands` scopes.

`DATABASE_URL` defaults to `file:./data/prod.sqlite`, relative to `apps/prod`.
Set `OPENROUTER_API_KEY` for deployment-provided AI credentials, or configure credentials through the bot's settings.
The remaining options are in `.env.example`.

## Run

```sh
pnpm dev
```

Startup applies database migrations and refreshes slash commands.
For a compiled run, use `pnpm start`; it builds the workspace first.
Run `pnpm check` for lint, types, tests, and builds.
