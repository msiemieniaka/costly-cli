# Security

This PoC is not production-ready. Real email labels are enabled by default; notify team members before collecting their usage. Set `user_mode="hash"` when pseudonymous labels are appropriate. Hashes are not anonymization of predictable emails.

Report vulnerabilities through GitHub's private security reporting for this repository if available. Do not post credentials or real session data in public issues. If private reporting is unavailable, contact the maintainer privately before sharing details.

Session files are untrusted input. Only allow-listed usage metadata is persisted. OTLP payloads exclude prompts, code, session IDs and paths. Remote endpoints require HTTPS and redirect following is disabled. Credentials use the OS keychain, never plain config; endpoint error bodies are not logged. The included Docker stack binds ports to localhost and is intended only for local testing.

Do not expose the local Grafana stack to a network without configuring authentication and reviewing its deployment settings. Keep private usage files outside the source tree.
