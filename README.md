# costly

**Early PoC, not released.** Local AI coding usage collection for Claude Code and Codex, written in TypeScript on Bun. Package name: `costly-cli`; command: `costly`.

Reads usage counts from local session files, stores them in SQLite, estimates USD and sends metrics to Grafana through an OpenTelemetry Collector and Prometheus. No cloud account is required. Prompts and code are not stored or sent. It measures usage; it does not enforce budgets or limits.

## Run locally

Requires Bun 1.4.4 or newer. Docker Desktop is needed only for the included Grafana stack. Nothing needs publishing.

```sh
bun install --frozen-lockfile
bun test
bun run lint
bun run build
bun link
costly start
```

Alternatively, use `bun packages/cli/main.ts` in place of `costly`. The interactive first start imports history, shows estimates, confirms identity and offers local Docker Grafana, your own endpoint, Grafana Cloud or collection without a backend. Non-interactive start never prompts.

For a fully scripted local setup:

```sh
bun packages/cli/main.ts stack up
bun packages/cli/main.ts setup grafana --endpoint http://127.0.0.1:4318
bun packages/cli/main.ts start
bun packages/cli/main.ts status
```

Open [AI Cost in Grafana](http://localhost:3000/d/costly). Anonymous local access is view-only. All published container ports bind to loopback. The dashboard and datasource are provisioned automatically.

```sh
costly report --by project,model
costly report --by project,user --from 2026-11-01 --to 2026-12-01
costly export --format csv --level daily --excel -o costs.csv
costly export --format json --level session -o costs.json
costly project
costly whoami
costly doctor
costly stop
costly stack down
```

Dates use UTC; `--to` is exclusive. Export refuses to overwrite an existing file. `--excel` uses UTF-8 BOM, semicolons, CRLF, quoted fields and formula-injection protection. The daemon creates its database/state, but never CSV/JSON exports on its own.

## Configuration

Config: `~/.config/costly/config.toml`. `COSTLY_HOME` can select an isolated directory, useful for tests or a second synthetic device. Device identity is a separate file, retained across restarts. `connection.json` is written by `costly setup` and contains only the connection (endpoint, auth type, instance ID, history mode, OS credential reference, and the email if you typed one during setup). Everything else stays in `config.toml`.

```toml
user = "developer@example.invalid"
team = "example-team"
user_mode = "email" # or "hash"
allowed_email_domains = ["example.invalid"]
backfill_days = 30
interval_seconds = 60

[[rule]]
match_remote = "github.com/example/payments-*"
project = "checkout"
```

`COSTLY_USER`, `COSTLY_PROJECT` and `COSTLY_COMPONENT` override detected values. Project mapping: environment, nearest `.costly.toml`/AGENTS.md/CLAUDE.md marker, local rule, git remote/folder, `unassigned`. Markers support `project`, `component`, `team`. Rules support `match_path`, `match_remote`, `match_branch`. Reports reevaluate mapping rules; already sent backend labels are not rewritten.

Optional config keys: `claude_dir` (defaults to `~/.claude/projects`), `codex_dir` (`~/.codex/sessions`), `price_file` (JSON overrides, rates in USD per token), `user_alias`, `email_template`. AWS identity lookup runs only for detected Bedrock usage; GCP only for Vertex. Missing cloud tools/credentials fall back to tool login, git email, then an explicitly unknown OS identity. Current tool settings/login are only an inference about historical sessions.

Remote endpoints require HTTPS. For authentication, set a token environment variable privately and pass its **name**, not its value:

```sh
costly setup grafana --endpoint https://collector.example.invalid --token-env COSTLY_OTLP_TOKEN
```

The token is stored using Bun's OS keychain support. Grafana Cloud additionally takes `--instance-id`; Cloud is implemented but only tested with a fake receiver. Linux keychain use requires a working secret-service session. If credentials cannot be stored, setup fails rather than saving plaintext. Without a Grafana API token, import the provided dashboard JSON manually; the local stack handles this automatically.

## Accuracy and current limits

- Costs are estimates and subscription costs are API-equivalent, not invoices. Unpriced usage is separately counted. Prices and their version are frozen on imported records, except when later streaming chunks complete their usage. Unpriced records get a price as soon as an updated price list covers their model.
- On first import, today's Claude Code settings (Bedrock on/off, AWS region, subscription login) are applied to all past sessions. If you switched (e.g. from the API to Bedrock or a subscription), older history is labelled and priced as the current setup. Per-project `.claude/settings.json` and shell variables are not read.
- `user_mode = "hash"` is pseudonymous, not anonymous: without a team secret, a hash can be reversed by hashing known emails. Set `COSTLY_USER_HASH_KEY` (or `user_hash_key`) to the same secret on every team machine to use an HMAC.
- The bundled price snapshot supports offline startup; a public LiteLLM price list refresh is attempted daily. Only the scoped Bedrock override has an independent AWS price check; see [price validation](docs/poc-price-check.md).
- Metrics use closed one-minute buckets, a zero baseline, cumulative totals and separate device IDs. Collection can precede visible metrics by roughly two minutes. Old history stays in SQLite; backend backfill defaults to 30 days.
- Points already accepted by the backend are never changed or resent. Usage imported late (its time is before the last sent point) is added to the next new point, so totals stay correct and only its position on the timeline moves. If the backend refuses a series (HTTP 4xx, e.g. too old), that series switches to current-time totals; if it is still refused, it is skipped and the others are still sent (`costly doctor` reports it).
- `increase()` is an extrapolated Prometheus estimate. Use local reports for exact totals. Reinstalling after deleting the database or changing attribution for sent history can require backend reconciliation.
- The daemon scans session folders every 10 seconds (`scan_seconds`) and reads only files that grew. An in-place rewrite of earlier bytes without truncation is not detected. A line over 16 MiB is skipped and counted as invalid; the rest of the file is still read. Codex cumulative resets are treated as a new baseline; the reset event itself is not charged.
- The local Grafana keeps the default `admin`/`admin` login and anonymous view access. It only listens on localhost; change the password if others use this machine. `scripts/docker-check.ts` leaves synthetic test series in the local Prometheus.
- OS service installation, other tool adapters and billing reconciliation are outside the PoC.

See [validation status](docs/validation.md) for completed tests and remaining acceptance checks. The PoC is not yet fully accepted.

## Development

`packages/core`: metadata, SQLite, attribution, pricing, reports. `packages/collector`: readers and OTLP HTTP/JSON export. `packages/cli`: commands, daemon and setup. `docker`: local observability stack. Tests generate synthetic files in temporary directories and remove them afterward. Additional local checks: `bun scripts/docker-check.ts`, `bun scripts/keychain-check.ts`.

Apache-2.0. The repository is public; source pushes and merges require owner approval. Package publication, releases and image pushes remain disabled.

### Project setup

Run `costly init` inside a repository to choose a project, component and team. It writes `.costly.toml` at the git root and a matching local config rule (normalised remote, or path without a remote). Commit the marker yourself to share it. No git changes are made by init. Outside git it uses the current folder. Parent markers are inherited by child repositories unless a nearer marker overrides them.

Scripts must pass `--project NAME`; optional flags are `--component NAME`, `--team NAME`, `--yes` (skip questions), `--force` (overwrite existing marker labels), `--repo-only` (marker only), and `--local` (local rule only). Names allow 1?63 letters, digits, dots, underscores and hyphens. Existing comments, unrelated keys and rules are preserved. `costly doctor` warns if marker and local rule disagree; the marker wins. Reports reassign old sessions, but already sent Grafana data keeps its old labels.

Use `costly start`, `costly stop`, `costly status` and `costly run` (foreground). The old `costly daemon ?` commands remain compatibility aliases for one version.
