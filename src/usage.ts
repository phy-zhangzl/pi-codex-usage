export type CodexWindow = {
  usedPercent?: number;
  windowMinutes?: number;
  resetAfterSeconds?: number;
  resetAtSeconds?: number;
};

export type UsageSource = "usage";

export type CodexUsageState = {
  observedAt: number;
  source: UsageSource;
  activeLimit?: string;
  planType?: string;
  creditsBalance?: string;
  creditsHasCredits?: boolean;
  creditsUnlimited?: boolean;
  ordinaryUsageAllowed?: boolean;
  limitReached?: boolean;
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

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function usageWindow(value: unknown): CodexWindow {
  const window = object(value);
  const seconds = number(window.limit_window_seconds);
  return {
    usedPercent: number(window.used_percent),
    windowMinutes: seconds === undefined ? undefined : seconds / 60,
    resetAfterSeconds: number(window.reset_after_seconds),
    resetAtSeconds: number(window.reset_at),
  };
}

/** Keep only quota fields, never the endpoint's email/user/account identifiers. */
export function extractStateFromUsage(payload: unknown): CodexUsageState {
  const data = object(payload);
  const limit = object(data.rate_limit);
  const credits = object(data.credits);
  const balance = credits.balance;
  const state: CodexUsageState = {
    observedAt: Date.now(),
    source: "usage",
    activeLimit: "codex",
    planType: typeof data.plan_type === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(data.plan_type)
      ? data.plan_type : undefined,
    creditsBalance: (typeof balance === "string" && balance.trim() && balance.length <= 64 && Number.isFinite(Number(balance)))
      || (typeof balance === "number" && Number.isFinite(balance)) ? String(balance) : undefined,
    creditsHasCredits: boolean(credits.has_credits),
    creditsUnlimited: boolean(credits.unlimited),
    ordinaryUsageAllowed: boolean(limit.allowed),
    limitReached: boolean(limit.limit_reached),
    primary: usageWindow(limit.primary_window),
    secondary: usageWindow(limit.secondary_window),
  };
  if (getUsageWindows(state).length === 0 && state.creditsHasCredits === undefined
    && state.creditsUnlimited === undefined && state.ordinaryUsageAllowed === undefined) {
    throw new Error("Codex quota response contains no recognized usage fields.");
  }
  return state;
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
  const blocked = state.ordinaryUsageAllowed === false || state.limitReached === true;
  const text = windows.length > 0
    ? windows.map(({ label, window }) => `${label} ${formatPercent(remainingPercent(window))}`).join(" · ")
    : state.creditsHasCredits !== undefined || state.creditsUnlimited !== undefined
      ? `credits ${creditsText(state)}` : "windows unavailable";
  return `Codex quota ${text}${blocked ? " · blocked" : ""}`;
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
