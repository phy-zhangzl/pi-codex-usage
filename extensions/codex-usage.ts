import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexAuthPath, fetchUsageState, loadCodexAuth, type CodexAuth } from "../src/client.ts";
import {
  creditsText,
  formatStatusText,
  formatWindowDetails,
  getUsageWindows,
  remainingPercent,
  type CodexUsageState,
} from "../src/usage.ts";

const STATE_TYPE = "codex-usage-state";
const STATUS_KEY = "codex-usage";
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SCOPE_NOTE = "Codex account quota; not Pi's OpenAI app allowance. The Codex and Pi logins may be different accounts.";

function isOpenAIProvider(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex";
}

function debugLog(message: string): void {
  if (process.env.PI_CODEX_USAGE_DEBUG !== "1") return;
  try {
    const dir = join(homedir(), ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "codex-usage-debug.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Diagnostics must never interrupt pi.
  }
}

export type UsageDependencies = {
  loadAuth: () => CodexAuth;
  fetchUsage: (auth: CodexAuth, signal?: AbortSignal) => Promise<CodexUsageState>;
};

export function registerCodexUsage(
  pi: ExtensionAPI,
  dependencies: UsageDependencies = { loadAuth: loadCodexAuth, fetchUsage: fetchUsageState },
): void {
  let latestState: CodexUsageState | undefined;
  let latestFingerprint: string | undefined;
  let lastError: string | undefined;
  let refreshInFlight: Promise<boolean> | undefined;
  let refreshController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let lastCtx: ExtensionContext | undefined;
  let stopped = false;

  function updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!isOpenAIProvider(ctx)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const text = latestState ? formatStatusText(latestState) : lastError
      ? "Codex quota: unavailable (/codex-usage)" : "Codex quota: loading";
    const remaining = latestState
      ? getUsageWindows(latestState).map(({ window }) => remainingPercent(window) ?? 100) : [];
    const lowest = remaining.length > 0 ? Math.min(...remaining) : 100;
    const blocked = latestState?.ordinaryUsageAllowed === false || latestState?.limitReached === true;
    const color = blocked || lowest <= 10 ? "error"
      : lastError || lowest <= 25 ? "warning" : latestState ? "accent" : "dim";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text ?? "Codex quota: unavailable"));
  }

  async function performRefresh(ctx: ExtensionContext, force: boolean): Promise<boolean> {
    try {
      if (["1", "true", "yes"].includes(process.env.PI_OFFLINE ?? "")) {
        throw new Error("Codex quota query disabled by PI_OFFLINE.");
      }
      // Reread credentials on every refresh. Do not serve a previous account's cached quota.
      const auth = dependencies.loadAuth();
      if (auth.fingerprint !== latestFingerprint) {
        latestState = undefined;
        latestFingerprint = undefined;
        lastError = undefined;
        updateUi(ctx);
      }
      if (!force && latestState && Date.now() - latestState.observedAt < MIN_REFRESH_INTERVAL_MS) {
        return true;
      }
      refreshController = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, refreshController.signal]) : refreshController.signal;
      const state = await dependencies.fetchUsage(auth, signal);
      if (stopped || signal.aborted) return false;
      if (dependencies.loadAuth().fingerprint !== auth.fingerprint) {
        throw new Error("Codex account changed during the query. Refresh again.");
      }
      latestState = state;
      latestFingerprint = auth.fingerprint;
      lastError = undefined;
      // Only sanitized quota metadata is stored, not account IDs or credentials.
      pi.appendEntry(STATE_TYPE, state);
      debugLog(`refresh usage windows=${getUsageWindows(state).map(({ label }) => label).join(",")} plan=${state.planType ?? "unknown"}`);
      return true;
    } catch (error) {
      if (!stopped) {
        latestState = undefined;
        latestFingerprint = undefined;
        lastError = error instanceof Error ? error.message : "Codex quota query failed.";
        debugLog(`refresh error=${lastError}`);
      }
      return false;
    } finally {
      refreshController = undefined;
      if (!stopped) updateUi(lastCtx ?? ctx);
    }
  }

  async function refreshAndUpdate(ctx: ExtensionContext, force = false): Promise<boolean> {
    if (stopped || (!force && (!ctx.hasUI || !isOpenAIProvider(ctx)))) return false;
    lastCtx = ctx;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = performRefresh(ctx, force);
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    stopped = false;
    lastCtx = ctx;
    latestState = undefined;
    latestFingerprint = undefined;
    lastError = undefined;
    // Do not restore old header/probe snapshots or quota for an unknown previous account.
    updateUi(ctx);
    if (refreshTimer) clearInterval(refreshTimer);
    if (ctx.hasUI) {
      refreshTimer = setInterval(() => {
        if (lastCtx) void refreshAndUpdate(lastCtx);
      }, MIN_REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
      await refreshAndUpdate(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshController?.abort();
    await refreshInFlight;
    lastCtx = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("model_select", async (_event, ctx) => {
    lastCtx = ctx;
    // Refresh before displaying cached state; the Codex login may have changed.
    await refreshAndUpdate(ctx);
    updateUi(ctx);
  });

  pi.registerCommand("codex-usage", {
    description: "Show Codex account quota (separate from Pi's OpenAI app allowance)",
    handler: async (_args, ctx) => {
      await refreshAndUpdate(ctx, !isOpenAIProvider(ctx));
      if (stopped) return;
      if (!latestState) {
        ctx.ui.notify(lastError ?? "No Codex quota available. Use /codex-usage-refresh to query.", "warning");
        return;
      }
      ctx.ui.notify([
        SCOPE_NOTE,
        `Plan: ${latestState.planType ?? "unknown"}`,
        `Included usage allowed: ${latestState.ordinaryUsageAllowed ?? "unknown"}`,
        `Credits: ${creditsText(latestState)}`,
        ...getUsageWindows(latestState).map(({ label, window }) =>
          formatWindowDetails(label, window, latestState!.observedAt)),
        `Credential source: ${codexAuthPath()} (read-only; token refresh belongs to Codex CLI)`,
        `Source: GET /wham/usage`,
        `Observed: ${new Date(latestState.observedAt).toLocaleString()}`,
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("codex-usage-refresh", {
    description: "Refresh Codex account quota with a read-only GET (no model request)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Refreshing Codex account quota…", "info");
      const refreshed = await refreshAndUpdate(ctx, true);
      if (stopped) return;
      ctx.ui.notify(refreshed ? "Codex account quota refreshed." : lastError ?? "Codex quota query cancelled.",
        refreshed ? "info" : "error");
    },
  });
}

export default function codexUsageExtension(pi: ExtensionAPI): void {
  registerCodexUsage(pi);
}
