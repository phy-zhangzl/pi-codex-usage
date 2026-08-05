import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  creditsText,
  extractStateFromHeaders,
  formatStatusText,
  formatWindowDetails,
  getUsageWindows,
  remainingPercent,
  type CodexUsageState,
} from "../src/usage.ts";

type PiAuthFile = Record<string, {
  type?: string;
  access?: string;
  accountId?: string;
}>;

const CODEX_PROVIDER = "openai-codex";
const STATE_TYPE = "codex-usage-state";
const STATUS_KEY = "codex-usage";
const COMMAND_DETAILS = "codex-usage";
const COMMAND_REFRESH = "codex-usage-refresh";
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEBUG_LOG = join(homedir(), ".pi", "agent", "codex-usage-debug.log");
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const CODEX_MODEL_OVERRIDE = process.env.PI_CODEX_USAGE_MODEL || undefined;
const DEBUG_ENABLED = process.env.PI_CODEX_USAGE_DEBUG === "1";

function isCodexProvider(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === CODEX_PROVIDER;
}

function debugLog(message: string): void {
  if (!DEBUG_ENABLED) return;
  try {
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Debug logging must never interrupt pi.
  }
}

function statusColor(ctx: ExtensionContext, state: CodexUsageState | undefined): string {
  if (!state) return ctx.ui.theme.fg("dim", "Codex usage: waiting");

  const windows = getUsageWindows(state);
  if (windows.length === 0) return ctx.ui.theme.fg("dim", "Codex usage: unavailable");

  const lowest = Math.min(...windows.map(({ window }) => remainingPercent(window) ?? 100));
  const text = formatStatusText(state);
  if (!text) return ctx.ui.theme.fg("dim", "Codex usage: unavailable");
  if (lowest <= 10) return ctx.ui.theme.fg("error", text);
  if (lowest <= 25) return ctx.ui.theme.fg("warning", text);
  return ctx.ui.theme.fg("accent", text);
}

function updateUi(ctx: ExtensionContext, state: CodexUsageState | undefined): void {
  if (!isCodexProvider(ctx)) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, statusColor(ctx, state));
}

function normalizeHeadersFromResponse(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function loadPiCodexAuth(): { access: string; accountId?: string } {
  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as PiAuthFile;
  const auth = raw[CODEX_PROVIDER];
  if (!auth?.access) throw new Error(`No ${CODEX_PROVIDER} access token found in ${AUTH_PATH}`);
  return { access: auth.access, accountId: auth.accountId };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // We only need headers; ignore stream cancellation failures.
  }
}

async function fetchUsageStateDirect(
  signal: AbortSignal | undefined,
  model: string,
): Promise<CodexUsageState> {
  const auth = loadPiCodexAuth();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  const abort = () => controller.abort();

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  try {
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${auth.access}`,
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": "pi",
    };
    if (auth.accountId) requestHeaders["chatgpt-account-id"] = auth.accountId;

    const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        model,
        instructions: "You are a quota probe. Reply with exactly OK.",
        stream: true,
        store: false,
        reasoning: { effort: "low", summary: "auto" },
        text: { verbosity: "low" },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "OK" }],
          },
        ],
      }),
      signal: controller.signal,
    });

    const state = extractStateFromHeaders(normalizeHeadersFromResponse(response.headers), "probe");
    if (state) {
      await cancelResponseBody(response);
      return state;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Codex quota probe failed: ${response.status} ${response.statusText} ${body.slice(0, 160)}`.trim());
    }

    await cancelResponseBody(response);
    throw new Error("Codex quota probe did not include x-codex-* headers");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export default function codexUsageExtension(pi: ExtensionAPI) {
  let latestState: CodexUsageState | undefined;
  let refreshInFlight: Promise<CodexUsageState> | undefined;
  let lastRefreshAt = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let lastCtx: ExtensionContext | undefined;

  async function refreshState(ctx: ExtensionContext, force = false): Promise<CodexUsageState> {
    if (refreshInFlight) return refreshInFlight;
    if (!force && latestState && Date.now() - lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return latestState;

    const model = CODEX_MODEL_OVERRIDE || ctx.model?.id || DEFAULT_CODEX_MODEL;
    refreshInFlight = fetchUsageStateDirect(ctx.signal, model)
      .then((state) => {
        latestState = state;
        lastRefreshAt = Date.now();
        pi.appendEntry(STATE_TYPE, latestState);
        debugLog(`refresh ${state.source} model=${model} windows=${JSON.stringify(getUsageWindows(state).map(({ label }) => label))} plan=${state.planType ?? "unknown"}`);
        return state;
      })
      .finally(() => {
        refreshInFlight = undefined;
      });

    return refreshInFlight;
  }

  async function refreshAndUpdate(ctx: ExtensionContext, force = false): Promise<boolean> {
    if (!isCodexProvider(ctx)) {
      updateUi(ctx, latestState);
      return false;
    }
    try {
      await refreshState(ctx, force);
      return true;
    } catch (error) {
      debugLog(`refresh error=${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      updateUi(ctx, latestState);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    const restored = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)
      .pop() as { data?: CodexUsageState } | undefined;

    if (restored?.data) latestState = restored.data;
    updateUi(ctx, latestState);
    await refreshAndUpdate(ctx);

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (lastCtx) void refreshAndUpdate(lastCtx);
    }, MIN_REFRESH_INTERVAL_MS);
    (refreshTimer as unknown as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    lastCtx = undefined;
  });

  pi.on("model_select", async (_event, ctx) => {
    lastCtx = ctx;
    updateUi(ctx, latestState);
    await refreshAndUpdate(ctx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    lastCtx = ctx;
    if (!isCodexProvider(ctx)) return;

    const nextState = extractStateFromHeaders(event.headers, "headers");
    if (!nextState) {
      debugLog(`after_provider_response status=${event.status} no x-codex headers`);
      return;
    }

    latestState = nextState;
    lastRefreshAt = Date.now();
    pi.appendEntry(STATE_TYPE, latestState);
    debugLog(`headers status=${event.status} windows=${JSON.stringify(getUsageWindows(latestState).map(({ label }) => label))} plan=${latestState.planType ?? "unknown"}`);
    updateUi(ctx, latestState);
  });

  pi.registerCommand(COMMAND_DETAILS, {
    description: "Show latest OpenAI Codex usage details",
    handler: async (_args, ctx) => {
      if (!isCodexProvider(ctx)) {
        ctx.ui.notify(`This command only applies to ${CODEX_PROVIDER}.`, "info");
        return;
      }

      if (!latestState) {
        await refreshAndUpdate(ctx, true);
      }
      if (!latestState) {
        ctx.ui.notify("No Codex usage data available yet.", "warning");
        return;
      }

      updateUi(ctx, latestState);
      const windows = getUsageWindows(latestState);
      ctx.ui.notify(
        [
          `Plan: ${latestState.planType ?? "unknown"}`,
          `Active limit: ${latestState.activeLimit ?? "unknown"}`,
          `Credits: ${creditsText(latestState)}`,
          ...(windows.length > 0
            ? windows.map(({ label, window }) => formatWindowDetails(label, window, latestState!.observedAt))
            : ["Windows: unavailable"]),
          `Source: ${latestState.source}`,
          `Observed: ${new Date(latestState.observedAt).toLocaleString()}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand(COMMAND_REFRESH, {
    description: "Refresh OpenAI Codex usage now",
    handler: async (_args, ctx) => {
      if (!isCodexProvider(ctx)) {
        ctx.ui.notify(`This command only applies to ${CODEX_PROVIDER}.`, "info");
        return;
      }
      ctx.ui.notify("Refreshing Codex usage…", "info");
      const refreshed = await refreshAndUpdate(ctx, true);
      ctx.ui.notify(
        refreshed ? "Codex usage refreshed." : "Codex usage refresh failed.",
        refreshed ? "info" : "error",
      );
    },
  });
}
