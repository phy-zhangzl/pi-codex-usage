import assert from "node:assert/strict";
import test from "node:test";
import {
  extractStateFromHeaders,
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
    source: "probe",
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
  assert.equal(formatStatusText(usage), "Codex 7d 67%");
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

test("extracts case-insensitive Codex headers", () => {
  const usage = extractStateFromHeaders({
    "X-Codex-Primary-Used-Percent": "10",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-credits-has-credits": "true",
  }, "probe");

  assert.ok(usage);
  assert.equal(usage.source, "probe");
  assert.equal(usage.primary.usedPercent, 10);
  assert.equal(usage.primary.windowMinutes, 300);
  assert.equal(usage.secondary.windowMinutes, 10080);
  assert.equal(usage.creditsHasCredits, true);
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
