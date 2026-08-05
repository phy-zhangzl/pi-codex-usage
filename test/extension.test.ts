import assert from "node:assert/strict";
import test from "node:test";
import codexUsageExtension from "../extensions/codex-usage.ts";

test("registers the Codex usage lifecycle hooks and commands", () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const pi = {
    on(name: string) {
      events.add(name);
    },
    registerCommand(name: string) {
      commands.add(name);
    },
    appendEntry() {},
  };

  codexUsageExtension(pi as never);

  assert.deepEqual([...events], [
    "session_start",
    "session_shutdown",
    "model_select",
    "after_provider_response",
  ]);
  assert.deepEqual([...commands], ["codex-usage", "codex-usage-refresh"]);
});
