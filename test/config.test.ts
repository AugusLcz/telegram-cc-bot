import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isAllowedDir, loadConfig } from "../src/core/config.ts";

test("isAllowedDir respects roots", () => {
  const root = path.resolve("/srv/projects");
  assert.ok(isAllowedDir(path.join(root, "a", "b"), [root]));
  assert.ok(isAllowedDir(root, [root]));
  assert.ok(!isAllowedDir(path.resolve("/srv/projects-evil"), [root]));
  assert.ok(!isAllowedDir(path.resolve("/etc"), [root]));
  assert.ok(isAllowedDir(path.resolve("/etc"), []));
});

test("loadConfig requires token and allowlist", () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t" }), /ALLOWED_USER_IDS/);
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "t", ALLOWED_USER_IDS: "1, 2" });
  assert.deepEqual([...cfg.allowedUserIds], [1, 2]);
  assert.equal(cfg.defaultPermissionMode, "auto");
  assert.equal(cfg.streamMode, "draft");
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", ALLOWED_USER_IDS: "1", DEFAULT_PERMISSION_MODE: "yolo" }));
});
