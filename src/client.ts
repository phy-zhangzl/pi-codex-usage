import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractStateFromUsage, type CodexUsageState } from "./usage.ts";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 15_000;

export type CodexAuth = {
  access: string;
  accountId?: string;
  // Runtime-only cache identity. Never written to session history or logs.
  fingerprint: string;
};

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
}

export function parseCodexAuth(raw: unknown): CodexAuth {
  const auth = raw as { auth_mode?: unknown; tokens?: { access_token?: unknown; account_id?: unknown } } | null;
  if (auth?.auth_mode !== undefined && auth.auth_mode !== "chatgpt") {
    throw new Error("Codex ChatGPT login required; API-key credentials cannot query subscription quota.");
  }
  const access = auth?.tokens?.access_token;
  if (typeof access !== "string" || !access.trim()) {
    throw new Error("No Codex ChatGPT access token. Sign in with the Codex CLI first.");
  }
  const accountId = typeof auth?.tokens?.account_id === "string" && auth.tokens.account_id.trim()
    ? auth.tokens.account_id : undefined;
  return {
    access,
    accountId,
    fingerprint: createHash("sha256").update(JSON.stringify([access, accountId])).digest("hex"),
  };
}

export function loadCodexAuth(): CodexAuth {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(codexAuthPath(), "utf8"));
  } catch {
    throw new Error(`Cannot read Codex credentials at ${codexAuthPath()}. Sign in with the Codex CLI; keychain-only credentials are not supported.`);
  }
  return parseCodexAuth(raw);
}

export async function fetchUsageState(
  auth: CodexAuth,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CodexUsageState> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access}`,
    Accept: "application/json",
    "User-Agent": "pi-codex-usage",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  let response: Response;
  try {
    // Pi's global fetch supplies its proxy settings. Never follow redirects with credentials.
    requestSignal.throwIfAborted();
    response = await fetcher(USAGE_URL, { method: "GET", headers, redirect: "error", signal: requestSignal });
  } catch {
    if (signal?.aborted) throw new Error("Codex quota query cancelled.");
    if (timeout.aborted) throw new Error("Codex quota query timed out after 15 seconds.");
    throw new Error("Codex quota query failed; check network/proxy settings. Redirects are not allowed.");
  }

  if (!response.ok) {
    // Do not echo backend bodies: they may contain account data or credentials.
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Codex quota HTTP ${response.status}. Refresh/sign in through the Codex CLI; pi's new OpenAI token cannot be substituted.`);
    }
    throw new Error(`Codex quota HTTP ${response.status}; try again later.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
    requestSignal.throwIfAborted();
  } catch {
    if (signal?.aborted) throw new Error("Codex quota query cancelled.");
    if (timeout.aborted) throw new Error("Codex quota query timed out after 15 seconds.");
    throw new Error("Codex quota endpoint returned invalid JSON.");
  }
  return extractStateFromUsage(payload);
}
