import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const isWindows = process.platform === "win32";

function executable(file: string): boolean {
  try {
    fs.accessSync(file, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `claude` on PATH, as a shell would find it. */
function onPath(env: NodeJS.ProcessEnv): string | undefined {
  const names = isWindows ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (executable(file)) return file;
    }
  }
  return undefined;
}

/** The Claude Code binary bundled with the Agent SDK (its platform package). */
function bundled(): string | undefined {
  const require = createRequire(import.meta.url);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const variants = process.platform === "linux" ? [`linux-${arch}`, `linux-${arch}-musl`] : [`${process.platform}-${arch}`];
  for (const v of variants) {
    try {
      const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${v}/package.json`));
      const file = path.join(dir, isWindows ? "claude.exe" : "claude");
      if (executable(file)) return file;
    } catch {
      // not installed for this platform
    }
  }
  return undefined;
}

/**
 * The Claude Code CLI for management commands (`claude plugin …`): CLAUDE_PATH,
 * else the account's own `claude`, else the binary the SDK brings.
 */
export function claudeCli(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return configured || onPath(env) || bundled();
}
