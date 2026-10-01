import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandNameMap, parseCommand, toTelegramName } from "../src/claude/cmdnames.ts";

test("toTelegramName normalizes Claude command names", () => {
  assert.equal(toTelegramName("compact"), "compact");
  assert.equal(toTelegramName("code-review"), "code_review");
  assert.equal(toTelegramName("plugin:My-Skill"), "plugin_my_skill");
  assert.equal(toTelegramName("x".repeat(40)), null);
  assert.equal(toTelegramName("---"), null);
});

test("CommandNameMap maps both spellings and never shadows local commands", () => {
  const map = new CommandNameMap();
  const claude = ["compact", "code-review", "model", "trade:trade"];
  const pairs = map.rebuild(claude, new Set(["model", "new"]));
  assert.deepEqual(pairs, [
    ["compact", "compact"],
    ["code_review", "code-review"],
    ["trade_trade", "trade:trade"],
  ]);
  assert.equal(map.resolve("code_review", claude), "code-review");
  assert.equal(map.resolve("code-review", claude), "code-review");
  assert.equal(map.resolve("trade:trade", claude), "trade:trade");
  assert.equal(map.resolve("theme", claude), null);
});

test("parseCommand handles bot mentions and multi-line args", () => {
  assert.deepEqual(parseCommand("/compact"), { name: "compact", args: "" });
  assert.deepEqual(parseCommand("/model@my_bot opus"), { name: "model", args: "opus" });
  assert.deepEqual(parseCommand("/review fix this\nand that"), { name: "review", args: "fix this\nand that" });
  assert.deepEqual(parseCommand("/trade:trade NVDA"), { name: "trade:trade", args: "NVDA" });
  assert.equal(parseCommand("hello /compact"), null);
});
