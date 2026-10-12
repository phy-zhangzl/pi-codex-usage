import assert from "node:assert/strict";
import test from "node:test";
import {
  extractStateFromUsage,
  formatStatusText,
  formatWindowDetails,
  getUsageWindows,
  getWindowLabel,
  resetSeconds,
  type CodexUsageState,
} from "../src/usage.ts";

function state(overrides: Partial<CodexUsageState> = {}): CodexUsageState {
  return {
    observedAt: 1_700_000_000_000,
    source: "usage",
    primary: {},
    secondary: {},
    ...overrides,
  };
}

test("identifies supported windows from windowMinutes", () => {
  assert.equal(getWindowLabel({ windowMinutes: 300 }), "5h");
  assert.equal(getWindowLabel({ windowMinutes: 10080 }), "7d");
  assert.equal(getWindowLabel({ windowMinutes: 60 }), "60m");
  assert.equal(getWindowLabel({ windowMinutes: 0 }), undefined);
});

test("does not treat an empty secondary window as a real quota window", () => {
  const usage = state({
    primary: { usedPercent: 33, windowMinutes: 10080 },
    secondary: { usedPercent: 0, windowMinutes: 0 },
  });

  assert.deepEqual(
    getUsageWindows(usage).map(({ slot, label }) => ({ slot, label })),
    [{ slot: "primary", label: "7d" }],
  );
  assert.equal(formatStatusText(usage), "Codex quota 7d 67%");
});

test("sorts recognized windows as 5h then 7d regardless of server slot", () => {
  const usage = state({
    primary: { usedPercent: 33, windowMinutes: 10080 },
    secondary: { usedPercent: 10, windowMinutes: 300 },
  });

  assert.deepEqual(
    getUsageWindows(usage).map(({ label }) => label),
    ["5h", "7d"],
  );
});

test("parses wham usage JSON and keeps only quota metadata", () => {
  const usage = extractStateFromUsage({
    email: "private@example.com",
    account_id: "private-account",
    user_id: "private-user",
    plan_type: "prolite",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 300, reset_at: 1800000000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
    },
    credits: { has_credits: true, unlimited: false, balance: "12.5" },
  });
  assert.equal(usage.source, "usage");
  assert.equal(usage.primary.usedPercent, 10);
  assert.equal(usage.primary.windowMinutes, 300);
  assert.equal(usage.primary.resetAfterSeconds, 300);
  assert.equal(usage.primary.resetAtSeconds, 1800000000);
  assert.equal(usage.secondary.windowMinutes, 10080);
  assert.equal(usage.creditsHasCredits, true);
  assert.equal(usage.creditsBalance, "12.5");
  assert.equal(usage.ordinaryUsageAllowed, true);
  assert.doesNotMatch(JSON.stringify(usage), /private/);
});

test("null secondary windows and invalid numbers do not imply unused quota", () => {
  const usage = extractStateFromUsage({ rate_limit: {
    primary_window: { used_percent: "10", limit_window_seconds: 604800, reset_at: -1 },
    secondary_window: null,
  } });
  assert.equal(usage.primary.usedPercent, undefined);
  assert.equal(usage.primary.resetAtSeconds, undefined);
  assert.deepEqual(getUsageWindows(usage).map(({ label }) => label), ["7d"]);
  assert.equal(formatStatusText(usage), "Codex quota 7d ?");
});

test("credits-only and blocked responses are not shown as 100% remaining", () => {
  assert.equal(formatStatusText(extractStateFromUsage({ credits: { unlimited: true } })), "Codex quota credits unlimited");
  assert.match(formatStatusText(extractStateFromUsage({ rate_limit: {
    allowed: false, primary_window: { used_percent: 20, limit_window_seconds: 604800 },
  } }))!, /80% · blocked$/);
  assert.throws(() => extractStateFromUsage(null), /no recognized usage/);
  assert.throws(() => extractStateFromUsage({ rate_limit: {}, credits: {} }), /no recognized usage/);
});

test("uses absolute resetAt so restored state does not show a stale duration", () => {
  const now = 1_700_000_060_000;
  const resetAt = now / 1000 + 120;
  assert.equal(resetSeconds({ resetAtSeconds: resetAt }, 1_700_000_000_000, now), 120);
});

test("formats details using the detected window label", () => {
  const details = formatWindowDetails(
    "7d",
    { usedPercent: 33, windowMinutes: 10080, resetAtSeconds: 1_700_000_120 },
    1_700_000_000_000,
  );

  assert.match(details, /^7d: 67% left \(33% used\)/);
  assert.match(details, /window 7d$/);
});
