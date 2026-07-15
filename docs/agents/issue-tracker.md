# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues at `mia-cx/prod`. Use the `gh` CLI for issue operations and infer the repository from the local Git remote.

## Issue Types

Use the organization-provided GitHub Issue Types:

- `📋 task` for implementation slices
- `🐛 bug` for unexpected behavior
- `⚡ enhancement` for feature requests outside an approved plan
- `📄 documentation` for documentation-only work
- `❔ question` for unresolved support or design questions
- `📝 prd` for product requirements documents

The installed `gh` CLI cannot set Issue Types during `gh issue create`. Create the issue first, then assign its organization Issue Type through GitHub's GraphQL API.

## Relationships

- Use GitHub's native sub-issue relationship for work belonging to a PRD or other parent issue.
- Use GitHub's native issue dependency relationship for `blocked by` sequencing; a Markdown reference alone is not sufficient.
- The current REST endpoints are `POST /repos/{owner}/{repo}/issues/{parent}/sub_issues` and `POST /repos/{owner}/{repo}/issues/{blocked}/dependencies/blocked_by`.
- Keep a human-readable `## Blocked by` section in the body, but treat the native relationship as the source of truth.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

When a skill says to publish to the issue tracker, create a GitHub issue in this repository.
