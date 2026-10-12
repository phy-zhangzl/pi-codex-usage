# Changelog

## Unreleased

- Replace quota-probe model requests and response-header collection with read-only `GET /wham/usage`.
- Use the existing Codex CLI `auth.json`, independently of pi's new OpenAI OAuth login.
- Show explicitly labeled Codex quota under both OpenAI providers, with useful failure messages.
- Invalidate quota on credential changes, clear failed snapshots, and cancel in-flight queries on shutdown.
- Add transport/parser/lifecycle tests and document the quota scope and credential limitations.

## 0.1.0

- Initial standalone pi package.
- Detect 5-hour and 7-day windows from `windowMinutes`.
- Ignore empty quota windows.
- Use the current Codex model for probes by default.
- Add package metadata, documentation, tests, MIT license, and Git ignore rules.
