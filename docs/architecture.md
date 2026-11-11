# How the PoC works

The reader scans newline-delimited JSON incrementally. SQLite checkpoints contain byte offsets and only the minimal parser state; incomplete trailing lines are read again on the next poll. Claude uses message/request IDs. Codex uses session identity plus cumulative token counts, and converts cumulative usage to deltas. Cached input is subtracted from Codex input; reasoning is not added twice.

Metadata rows contain token counts, model/provider, timestamps, session ID, cwd, git remote/branch, labels, calculated cost and price version. Prompt, completion and tool-call content is discarded. The daemon polls every second and pushes on a configurable interval, default 60 seconds.

The metrics encoder reconstructs cumulative counters from rows. Each service instance has a stable device ID. Requests in the current minute are withheld so additional live usage cannot alter an already published minute. A zero baseline lets Prometheus observe the first increase. Unchanged acknowledged points are skipped. Points are acknowledged only after an OTLP response with no rejection; failures retain the local source data and retry with exponential backoff, capped at 15 minutes.

The Collector has no asynchronous queue or batch processor: acknowledgement must propagate from Prometheus to the client, otherwise a Collector restart could lose accepted-but-not-forwarded data. Prometheus accepts a 30-day out-of-order window. Grafana's dashboard sums independent device series and uses increase for range estimates.

The daemon lock is acquired atomically. Stop requests use a nonce and graceful exit rather than sending a signal to an arbitrary stale PID. There is a known narrow stale-lock/PID-reuse limitation; long-running OS service supervision is MVP work. A separate device-id file survives database replacement, but deleting usage/state can still require backend reconciliation.

Prices are per-token rates. A public LiteLLM snapshot is cached by content hash and refreshed daily; a bundled subset supports offline first run. Scoped AWS overrides and optional user overrides take precedence. Unknown rates remain unpriced. Subscription/provider inference uses current tool settings and cannot prove historical billing mode.

References: [Codex protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), [Bun Secrets](https://bun.sh/docs/runtime/secrets), [Prometheus OTLP guide](https://prometheus.io/docs/guides/opentelemetry/), [LiteLLM prices](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json).
