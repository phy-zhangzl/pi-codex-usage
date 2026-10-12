# pi-codex-usage

Display **Codex account quota** in pi's footer, including when pi uses the new
`openai` / Sign in with ChatGPT provider.

> This is Codex quota, **not the remaining allowance of pi's new OpenAI OAuth app**.
> The Codex and pi logins can be different accounts. Even for the same account,
> do not assume their quota buckets and per-app limits are identical.
>
> This package calls an internal ChatGPT/Codex endpoint, not a public OpenAI usage
> API. Its response format and authentication may change without notice.

## How it works

- Read the existing Codex CLI credential from `$CODEX_HOME/auth.json`, or
  `~/.codex/auth.json` when `CODEX_HOME` is unset.
- Make a read-only `GET https://chatgpt.com/backend-api/wham/usage` with the Codex
  access token and, when present, `ChatGPT-Account-Id`.
- Do **not** generate a model response, launch app-server, read pi's auth file,
  follow redirects, refresh tokens, or modify either login.
- Show the status when pi's provider is `openai` or `openai-codex`:

  ```text
  Codex quota 5h 85% · 7d 67%
  ```

  Percentages are **remaining**, not used. Windows come from the server's
  `limit_window_seconds`: 18000 seconds means `5h`, 604800 means `7d`;
  other positive durations display as minutes. Missing/zero-duration windows are
  omitted; a missing percentage is `?`, never assumed to mean 100% remaining.
- Respect the backend's `allowed`/`limit_reached` state with a `blocked` suffix.
  Percentages and reset times alone do not establish permission to make requests.
- Refresh on interactive session startup, OpenAI model selection, and every five
  minutes. Successful results are cached for five minutes; concurrent requests
  are coalesced. `/codex-usage-refresh` bypasses the cache.
- Reread the credential on refresh and discard cached quota on account/token
  changes. Failed refreshes show `unavailable`, not a stale percentage.
- Bound each query to 15 seconds; cancel outstanding queries on session shutdown
  or extension reload. Headless startup does not poll; `PI_OFFLINE=1` disables queries.

Only sanitized quota metadata is saved as custom session entries, outside the LLM
context. Old session snapshots are not restored because their account ownership
cannot be established. Email, user/account IDs, credentials, and backend error
bodies are not saved or logged.

## Requirements

- pi (tested with `@earendil-works/pi-coding-agent` 1.1.0).
- Node.js >=22.19.0.
- An existing **Codex CLI ChatGPT login** stored in `auth.json`. API-key logins,
  keychain-only credential storage, and pi's new direct OAuth token are not accepted.

If necessary, sign in separately using `codex login`. This does not require adding
`openai-codex` back to pi's defaults, model configuration, or `auth.json`.

The plugin does not renew credentials. On HTTP 401/403, refresh/sign in through
Codex CLI and run `/codex-usage-refresh` again. Do not substitute pi's new `openai`
token: [OpenAI currently does not support a remaining-quota API for that grant](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3).

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-codex-usage
```

For the published GitHub source, after these changes have been pushed:

```bash
pi install git:github.com/phy-zhangzl/pi-codex-usage
```

Run `/reload` in an existing pi session, or restart pi.

## Commands

- `/codex-usage` — show Codex plan, credits, remaining quota, reset times,
  credential source, and observation time. Also reports the reason for failure.
- `/codex-usage-refresh` — force one fresh read-only query.

Explicit commands can be used with any active model. The persistent footer is
shown only for OpenAI providers.

## Configuration and privacy

Use `CODEX_HOME` to select the existing Codex credential directory. No model
configuration or `PI_CODEX_USAGE_MODEL` is needed anymore.

Within pi, requests use pi's global fetch and inherit its HTTP proxy configuration.
Standalone Node diagnostics should use the same configured transport; on Node
versions that support it, `--use-env-proxy` enables environment proxies.

Optional local diagnostics:

```bash
PI_CODEX_USAGE_DEBUG=1 pi
```

The log is `~/.pi/agent/codex-usage-debug.log`; it contains quota window labels,
plan names, and sanitized errors. Treat it as private diagnostic data.

Credentials are read locally and sent only to the fixed HTTPS endpoint (and
through your configured proxy). Review OpenAI/ChatGPT terms and account policies
before using or distributing this integration. Never commit Codex/pi credentials,
session history, or debug logs. Pi extensions run with full local permissions;
review their source before installing.

## Development

```bash
npm test
npm run pack:dry-run
```

Tests use fake credentials/responses and make no network requests. They cover GET
request safety, auth selection, quota parsing, missing windows, reset times,
OpenAI footer/commands, cache invalidation, error handling, and shutdown cancellation.

## License

MIT. See [LICENSE](LICENSE).
