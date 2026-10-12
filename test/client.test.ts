import assert from "node:assert/strict";
import test from "node:test";
import { codexAuthPath, fetchUsageState, parseCodexAuth, USAGE_URL } from "../src/client.ts";

const auth = parseCodexAuth({ auth_mode: "chatgpt", tokens: { access_token: "test-token", account_id: "test-account" } });
const payload = {
  plan_type: "pro",
  rate_limit: { allowed: true, primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1_800_000_000 } },
  credits: { has_credits: false, balance: "0" },
};

function stubFetch(handler: (input: unknown, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input, init) => handler(input, init!)) as typeof fetch;
}

test("uses CODEX_HOME, never pi's auth file", () => {
  assert.equal(codexAuthPath({ CODEX_HOME: "/tmp/codex-test" }), "/tmp/codex-test/auth.json");
  assert.match(codexAuthPath({}), /\.codex\/auth\.json$/);
});

test("accepts Codex CLI auth with or without auth_mode; rejects API keys and direct Pi tokens", () => {
  assert.equal(auth.access, "test-token");
  assert.equal(parseCodexAuth({ tokens: { access_token: "token" } }).accountId, undefined);
  for (const invalid of [null, {}, { auth_mode: "apikey", OPENAI_API_KEY: "sk-secret" }, { openai: { access: "pi-direct-secret" } }]) {
    assert.throws(() => parseCodexAuth(invalid));
  }
  assert.notEqual(auth.fingerprint, parseCodexAuth({ tokens: { access_token: "test-token", account_id: "different" } }).fingerprint);
  assert.notEqual(auth.fingerprint, parseCodexAuth({ tokens: { access_token: "rotated", account_id: "test-account" } }).fingerprint);
});

test("makes only a read-only GET with Codex auth, no body, and no redirects", async () => {
  let calls = 0;
  const state = await fetchUsageState(auth, undefined, stubFetch((url, init) => {
    calls++;
    assert.equal(url, USAGE_URL);
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-token");
    assert.equal((init.headers as Record<string, string>)["ChatGPT-Account-Id"], "test-account");
    assert.ok(init.signal);
    return Response.json(payload);
  }));
  assert.equal(calls, 1);
  assert.equal(state.source, "usage");
  assert.equal(state.primary.windowMinutes, 10080);
});

test("omits account header when unavailable", async () => {
  await fetchUsageState(parseCodexAuth({ tokens: { access_token: "token" } }), undefined, stubFetch((_url, init) => {
    assert.equal(new Headers(init.headers).has("ChatGPT-Account-Id"), false);
    return Response.json(payload);
  }));
});

test("HTTP errors never echo backend bodies and do not retry or refresh tokens", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(fetchUsageState(auth, undefined, stubFetch(() => {
      calls++;
      return new Response("secret-token someone@example.com", { status });
    })), (error: Error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /secret-token|someone@/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("rejects invalid JSON and unsupported payloads without exposing response contents", async () => {
  await assert.rejects(fetchUsageState(auth, undefined, stubFetch(() => new Response("private-backend-data"))), /invalid JSON/);
  await assert.rejects(fetchUsageState(auth, undefined, stubFetch(() => Response.json({ user_id: "private" }))), /no recognized usage/);
});

test("sanitizes network failures and honors cancellation", async () => {
  await assert.rejects(fetchUsageState(auth, undefined, stubFetch(() => {
    throw new Error("secret proxy URL or token");
  })), (error: Error) => {
    assert.match(error.message, /network\/proxy/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchUsageState(auth, controller.signal, stubFetch((_url, init) => {
    init.signal!.throwIfAborted();
    return Response.json(payload);
  })), /cancelled/);
});
