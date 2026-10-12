import assert from "node:assert/strict";
import test from "node:test";
import { registerCodexUsage, type UsageDependencies } from "../extensions/codex-usage.ts";
import { parseCodexAuth } from "../src/client.ts";
import { extractStateFromUsage } from "../src/usage.ts";

const quota = () => extractStateFromUsage({
  plan_type: "prolite",
  rate_limit: { allowed: true, primary_window: { used_percent: 1, limit_window_seconds: 604800 } },
});
const auth = (token = "test") => parseCodexAuth({ tokens: { access_token: token, account_id: "account" } });

type Handler = (event: unknown, ctx: any) => Promise<void>;
function harness(dependencies: UsageDependencies) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const entries: unknown[] = [];
  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    model: { provider: "openai", id: "gpt-6.1-sol" },
    signal: undefined,
    sessionManager: { getBranch: () => { throw new Error("Old account's persisted quota must not be restored"); } },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (text: string) => notifications.push(text),
    },
  };
  registerCodexUsage({
    on: (name: string, handler: Handler) => events.set(name, handler),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    appendEntry: (_type: string, state: unknown) => entries.push(state),
  } as never, dependencies);
  return { events, commands, entries, statuses, notifications, ctx,
    start: () => events.get("session_start")!(null, ctx),
    stop: () => events.get("session_shutdown")!(null, ctx),
    select: () => events.get("model_select")!(null, ctx),
    command: (name: string) => commands.get(name)!.handler("", ctx),
  };
}

test("registers lifecycle and commands, not response-header/probe hooks", () => {
  const h = harness({ loadAuth: auth, fetchUsage: async () => quota() });
  assert.deepEqual([...h.events.keys()], ["session_start", "session_shutdown", "model_select"]);
  assert.deepEqual([...h.commands.keys()], ["codex-usage", "codex-usage-refresh"]);
});

test("shows quota under new openai login, caches, and supports forced refresh", async () => {
  let calls = 0;
  const h = harness({ loadAuth: auth, fetchUsage: async () => { calls++; return quota(); } });
  try {
    await h.start();
    assert.equal(h.statuses.at(-1), "Codex quota 7d 99%");
    assert.equal(calls, 1);
    await h.select();
    await h.command("codex-usage");
    assert.equal(calls, 1);
    assert.match(h.notifications.at(-1)!, /not Pi's OpenAI app allowance/);
    assert.doesNotMatch(JSON.stringify(h.entries), /test|fingerprint|account_id|access_token/);
    await h.command("codex-usage-refresh");
    assert.equal(calls, 2);
    h.ctx.model.provider = "deepseek";
    await h.select();
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(calls, 2);
  } finally { await h.stop(); }
});

test("does not start automatic network activity in headless mode", async () => {
  const h = harness({ loadAuth: () => { throw new Error("should not read credentials"); }, fetchUsage: async () => { throw new Error("should not fetch"); } });
  h.ctx.hasUI = false;
  await h.start();
  await h.stop();
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(h.entries, []);
});

test("rereads credentials and invalidates cached quota after account/token switch", async () => {
  let current = auth();
  let calls = 0;
  const h = harness({ loadAuth: () => current, fetchUsage: async () => {
    calls++;
    assert.equal(h.statuses.at(-1), "Codex quota: loading");
    return quota();
  } });
  try {
    await h.start();
    current = auth("rotated");
    await h.select();
    assert.equal(calls, 2);
    assert.equal(h.statuses.at(-1), "Codex quota 7d 99%");
  } finally { await h.stop(); }
});

test("failed refresh clears old quota and details display the useful error without a duplicate query", async () => {
  let fail = false;
  let calls = 0;
  const h = harness({ loadAuth: auth, fetchUsage: async () => {
    calls++;
    if (fail) throw new Error("Codex quota HTTP 401. Sign in through Codex CLI.");
    return quota();
  } });
  try {
    await h.start();
    fail = true;
    await h.command("codex-usage-refresh");
    assert.match(h.statuses.at(-1)!, /unavailable/);
    assert.match(h.notifications.at(-1)!, /401/);
    await h.command("codex-usage");
    assert.equal(calls, 3);
    assert.match(h.notifications.at(-1)!, /401/);
    assert.equal(h.entries.length, 1);
  } finally { await h.stop(); }
});

test("missing credentials are reported; Pi's new login is not used as fallback", async () => {
  const h = harness({ loadAuth: () => { throw new Error("No Codex ChatGPT access token"); }, fetchUsage: async () => { throw new Error("must not fetch"); } });
  try {
    await h.start();
    await h.command("codex-usage");
    assert.match(h.notifications.at(-1)!, /No Codex ChatGPT/);
    assert.equal(h.entries.length, 0);
  } finally { await h.stop(); }
});

test("coalesces concurrent refreshes and aborts in-flight requests on shutdown", async () => {
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  const h = harness({ loadAuth: auth, fetchUsage: async (_auth, signal) => {
    calls++;
    requestSignal = signal;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  const start = h.start();
  const refresh = h.command("codex-usage-refresh");
  assert.equal(calls, 1);
  await h.stop();
  await Promise.all([start, refresh]);
  assert.equal(requestSignal!.aborted, true);
  assert.equal(h.entries.length, 0);
  assert.equal(h.statuses.at(-1), undefined);
});

test("does not publish a response if the credential changes while querying", async () => {
  let current = auth();
  let switches = 0;
  const h = harness({ loadAuth: () => current, fetchUsage: async () => {
    current = auth(`new-account-token-${++switches}`);
    return quota();
  } });
  try {
    await h.start();
    assert.equal(h.entries.length, 0);
    assert.match(h.statuses.at(-1)!, /unavailable/);
    await h.command("codex-usage");
    assert.match(h.notifications.at(-1)!, /account changed/);
  } finally { await h.stop(); }
});

test("honors PI_OFFLINE without reading credentials or making requests", async () => {
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const h = harness({ loadAuth: () => { throw new Error("must not read"); }, fetchUsage: async () => { throw new Error("must not fetch"); } });
  try {
    await h.start();
    await h.command("codex-usage-refresh");
    assert.match(h.notifications.at(-1)!, /PI_OFFLINE/);
    assert.equal(h.entries.length, 0);
  } finally {
    await h.stop();
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});
