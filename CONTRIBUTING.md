# Contributing

This is an unreleased PoC. Keep TypeScript strict and readable, with small modules and few dependencies.

Run `bun install --frozen-lockfile`, `bun test`, `bun run lint`, and `bun run build` on Windows and Linux. For backend changes run `bun scripts/docker-check.ts` against the local Docker stack. Include test evidence and known limitations in changes.

Use feature branches and pull requests. The owner approves pushes and merges; do not publish npm packages, releases, container images or dashboards. `package.json` stays private until a publishing decision.

Only synthetic fixtures belong in git. Never include personal emails, real session text, prompts, code from sessions, local databases, credentials or exports. Review the full diff and secret scan before a public push. Do not change the user's main worktree branch from an overlapping agent thread.
