export type CodexWindow = {
  usedPercent?: number;
  windowMinutes?: number;
  resetAfterSeconds?: number;
  resetAtSeconds?: number;
};

export type UsageSource = "headers" | "probe" | "usage";

export type CodexUsageState = {
  observedAt: number;
  source: UsageSource;
  activeLimit?: string;
  planType?: string;
  creditsBalance?: string;
  creditsHasCredits?: boolean;
  creditsUnlimited?: boolean;
  primary: CodexWindow;
  secondary: CodexWindow;
};

export type UsageWindowSlot = "primary" | "secondary";

export type UsageWindow = {
  slot: UsageWindowSlot;
  label: string;
  window: CodexWindow;
};

export const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
export const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;

export function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return undefined;
}

export function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

export function extractStateFromHeaders(
  headersInput: Record<string, string>,
  source: Exclude<UsageSource, "usage">,
): CodexUsageState | undefined {
  const headers = normalizeHeaders(headersInput);
  const foundCodexHeaders = Object.keys(headers).some((key) => key.startsWith("x-codex-"));
  if (!foundCodexHeaders) return undefined;

  return {
    observedAt: Date.now(),
    source,
    activeLimit: headers["x-codex-active-limit"],
    planType: headers["x-codex-plan-type"],
    creditsBalance: headers["x-codex-credits-balance"],
    creditsHasCredits: parseBoolean(headers["x-codex-credits-has-credits"]),
    creditsUnlimited: parseBoolean(headers["x-codex-credits-unlimited"]),
    primary: {
      usedPercent: parseNumber(headers["x-codex-primary-used-percent"]),
      windowMinutes: parseNumber(headers["x-codex-primary-window-minutes"]),
      resetAfterSeconds: parseNumber(headers["x-codex-primary-reset-after-seconds"]),
      resetAtSeconds: parseNumber(headers["x-codex-primary-reset-at"]),
    },
    secondary: {
      usedPercent: parseNumber(headers["x-codex-secondary-used-percent"]),
      windowMinutes: parseNumber(headers["x-codex-secondary-window-minutes"]),
      resetAfterSeconds: parseNumber(headers["x-codex-secondary-reset-after-seconds"]),
      resetAtSeconds: parseNumber(headers["x-codex-secondary-reset-at"]),
    },
  };
}

/**
 * Derive a display label from the server-reported window size.
 * Unknown positive sizes are shown as minutes instead of being guessed.
 */
export function getWindowLabel(window: CodexWindow): string | undefined {
  const minutes = window.windowMinutes;
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (minutes === FIVE_HOUR_WINDOW_MINUTES) return "5h";
  if (minutes === SEVEN_DAY_WINDOW_MINUTES) return "7d";
  return `${Math.round(minutes)}m`;
}

function windowSortRank(label: string): number {
  if (label === "5h") return 0;
  if (label === "7d") return 1;
  return 2;
}

/**
 * Return only windows with a positive server-reported duration.
 * This prevents an empty secondary window (for example windowMinutes=0)
 * from being displayed as a valid 100%-remaining window.
 */
export function getUsageWindows(state: CodexUsageState): UsageWindow[] {
  const candidates: UsageWindow[] = [
    { slot: "primary" as const, label: getWindowLabel(state.primary) ?? "", window: state.primary },
    { slot: "secondary" as const, label: getWindowLabel(state.secondary) ?? "", window: state.secondary },
  ].filter((candidate) => candidate.label.length > 0);

  return candidates.sort((a, b) => {
    const rankDifference = windowSortRank(a.label) - windowSortRank(b.label);
    if (rankDifference !== 0) return rankDifference;
    return (a.window.windowMinutes ?? 0) - (b.window.windowMinutes ?? 0);
  });
}

export function remainingPercent(window: CodexWindow): number | undefined {
  if (window.usedPercent == null || !Number.isFinite(window.usedPercent)) return undefined;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function formatStatusText(state: CodexUsageState): string | undefined {
  const windows = getUsageWindows(state);
  if (windows.length === 0) return undefined;
  return `Codex ${windows
    .map(({ label, window }) => `${label} ${formatPercent(remainingPercent(window))}`)
    .join(" · ")}`;
}

export function formatPercent(value: number | undefined): string {
  return value == null ? "?" : `${Math.round(value)}%`;
}

export function resetSeconds(
  window: CodexWindow,
  observedAt = Date.now(),
  now = Date.now(),
): number | undefined {
  if (typeof window.resetAtSeconds === "number" && Number.isFinite(window.resetAtSeconds)) {
    return Math.max(0, window.resetAtSeconds - now / 1000);
  }
  if (typeof window.resetAfterSeconds === "number" && Number.isFinite(window.resetAfterSeconds)) {
    const elapsed = Number.isFinite(observedAt) ? Math.max(0, (now - observedAt) / 1000) : 0;
    return Math.max(0, window.resetAfterSeconds - elapsed);
  }
  return undefined;
}

export function formatDuration(totalSeconds: number | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "unknown";
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.slice(0, 2).join(" ");
}

export function formatWindowDetails(
  label: string,
  window: CodexWindow,
  observedAt: number,
): string {
  const left = formatPercent(remainingPercent(window));
  const used = formatPercent(window.usedPercent);
  const reset = formatDuration(resetSeconds(window, observedAt));
  const size = getWindowLabel(window) ?? "unknown";
  return `${label}: ${left} left (${used} used), resets ${reset}, window ${size}`;
}

export function creditsText(state: CodexUsageState): string {
  if (state.creditsUnlimited) return "unlimited";
  if (state.creditsHasCredits === false) return "none";
  if (state.creditsBalance) return state.creditsBalance;
  if (state.creditsHasCredits) return "available";
  return "unknown";
}
