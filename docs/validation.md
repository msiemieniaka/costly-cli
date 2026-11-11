# PoC validation status

Early PoC, not released. Status as of 2026-11-11.

## Passed on this machine

- `bun test`: 38 tests pass on Windows and WSL Ubuntu (synthetic fixtures only).
- `bun run lint` (tsc, strict): no errors.
- Local Docker stack (OTel Collector → Prometheus → Grafana): two synthetic devices sum correctly; a repeated push sends nothing new.
- Late usage (imported after a later minute was already sent) reaches Prometheus as a rising total with no HTTP 400 and no counter reset.
- Real local Claude Code history: token totals match `ccusage`; cost differs by 0.33% (target ±2%).
- OS keychain write/read/delete (`scripts/keychain-check.ts`).

## Not yet checked

- Real Codex logs; whether earlier streamed Claude lines carry lower output counts than the last one.
- Live LiteLLM provider names for Vertex and Bedrock (mapping is tested with synthetic entries only).
- Bedrock prices beyond Sonnet 4.6 in us-east-1; any real AWS bill.
- Grafana Cloud (only a fake receiver was used).
- Daemon as an OS service; idle CPU/memory targets.

## Known limits

See "Accuracy and current limits" in the README.
