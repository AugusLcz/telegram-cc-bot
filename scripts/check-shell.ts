// Syntax-check the shell scripts (bash -n), plus shellcheck when it is installed.
// Part of `npm run check`. Without bash (plain Windows) it says so and passes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const scripts = [
  path.join("deploy", "deploy.sh"),
  ...fs.readdirSync(path.join(root, "deploy", "test")).filter((f) => f.endsWith(".sh")).map((f) => path.join("deploy", "test", f)),
];

const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

if (!has("bash")) {
  console.log("check-shell: bash not found, skipped");
  process.exit(0);
}
let failed = false;
for (const file of scripts) {
  const r = spawnSync("bash", ["-n", file], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) {
    failed = true;
    console.error(`bash -n ${file}:\n${r.stderr}`);
  }
}
if (has("shellcheck")) {
  const r = spawnSync("shellcheck", ["-S", "warning", "-x", ...scripts], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) failed = true;
} else {
  console.log("check-shell: shellcheck not installed, only bash -n ran");
}
console.log(failed ? "check-shell: FAILED" : `check-shell: ${scripts.length} scripts OK`);
process.exit(failed ? 1 : 0);
