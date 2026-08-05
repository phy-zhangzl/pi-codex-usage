# pi-codex-usage

A pi extension that displays OpenAI Codex usage windows in the footer and on demand.

> **Status:** This package uses an internal ChatGPT/Codex endpoint and internal
> `x-codex-*` response headers. It is not an official OpenAI usage API client.
> The endpoint, headers, or authentication behavior may change without notice.

## What it does

- Reads the local `openai-codex` OAuth credential from `~/.pi/agent/auth.json`.
- Uses Codex response headers when pi exposes them.
- Falls back to a small quota-probe request when a refresh is needed.
- Identifies windows from their server-reported `windowMinutes` value:
  - `300` minutes → `5h`
  - `10080` minutes → `7d`
  - other positive values are shown as minutes instead of guessed.
- Ignores empty windows such as `windowMinutes=0`.
- Persists the latest state as a pi custom session entry without adding it to the LLM context.

The extension does **not** send credentials to this GitHub project. The access token is
read locally and sent only to the configured ChatGPT/Codex endpoint used by the probe.

## Requirements

- pi 0.83 or newer
- A logged-in `openai-codex` provider in pi
- Node.js supported by the installed pi version (the package metadata currently uses `>=22.19.0`)

## Install from a GitHub checkout

After this repository is pushed to GitHub:

```bash
pi install git:github.com/phy-zhangzl/pi-codex-usage
```

Pin a tag or commit for reproducible installs:

```bash
pi install git:github.com/phy-zhangzl/pi-codex-usage@v0.1.0
```

For local development:

```bash
pi install /absolute/path/to/pi-codex-usage
```

Then run `/reload` in pi if it was already running.

## Commands

- `/codex-usage` — show plan, credits, detected usage windows, reset times, and source.
- `/codex-usage-refresh` — force a fresh quota probe.

The footer status is shown only when the active provider is `openai-codex`.

## Configuration

The probe uses the active Codex model when available. Override it with:

```bash
PI_CODEX_USAGE_MODEL=gpt-5.5 pi
```

Enable local diagnostic logging with:

```bash
PI_CODEX_USAGE_DEBUG=1 pi
```

The debug log is written to `~/.pi/agent/codex-usage-debug.log` and contains usage
metadata and errors, not the OAuth token. Treat it as local diagnostic data anyway.

## Important quota and privacy warning

The fallback probe is a real `POST` request to:

```text
https://chatgpt.com/backend-api/codex/responses
```

It asks for a minimal streamed `OK` response and cancels the stream after receiving
headers. Cancelling the stream does not prove that the request is free or excluded from
quota accounting. Refreshes can happen at session start, on model selection, every five
minutes, or when a user runs `/codex-usage-refresh`.

The endpoint and headers are internal implementation details. Review the applicable
OpenAI/ChatGPT terms and your account policy before using or distributing this package.

Do not commit any of the following:

```text
~/.pi/agent/auth.json
~/.pi/agent/auth.json.backup*
~/.pi/agent/sessions/
~/.pi/agent/codex-usage-debug.log
```

Pi extensions run with full local process and filesystem permissions. Review the source
before installing a package from an untrusted repository.

## Development

```bash
npm test
npm run pack:dry-run
```

Tests do not make network requests. They cover window identification, header parsing,
empty-window handling, reset-time calculation, and extension registration.

## License

MIT. See [LICENSE](LICENSE).
