// Ask the real Claude Code (the binary the Agent SDK brings) what it offers in a
// directory: slash commands sorted the way the bot sorts them, subagents, MCP
// servers, models. Sends no message, so it writes no transcript and uses no tokens.
// Needs Claude Code signed in for the current account.
//
//   node scripts/probe-claude.ts [directory]        (or: bun scripts/probe-claude.ts)
import path from "node:path";
import { withProbe } from "../src/claude/catalog.ts";
import { commandKind } from "../src/claude/cmdnames.ts";
import { SdkProcessFactory } from "../src/claude/process.ts";

const dir = path.resolve(process.argv[2] ?? process.cwd());
// Without the bot's own command names, its commands' Claude Code namesakes show as "hidden" or "menu".
const botCommands = new Set<string>();

const result = await withProbe(new SdkProcessFactory({ claudePath: process.env.CLAUDE_PATH }), dir, "default", async (h) => ({
  commands: await h.supportedCommands(),
  agents: await h.supportedAgents(),
  mcp: await h.mcpServerStatus(),
  models: h.models,
}));

console.log(`Claude Code in ${dir}\n`);
const groups = new Map<string, string[]>();
for (const c of result.commands) {
  const kind = commandKind(c, botCommands);
  groups.set(kind, [...(groups.get(kind) ?? []), c.name]);
}
for (const kind of ["menu", "own-skill", "skill", "hidden"]) {
  const names = (groups.get(kind) ?? []).sort();
  console.log(`${kind} (${names.length}): ${names.join(" ")}`);
}
console.log(`\nsubagents: ${result.agents.map((a) => a.name).join(" ") || "-"}`);
console.log(`mcp: ${result.mcp.map((m) => `${m.name}=${m.status}`).join(" ") || "-"}`);
console.log(`models: ${result.models.map((m) => m.value).join(" ") || "-"}`);
