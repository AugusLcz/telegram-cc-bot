import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstanceLock {
  readonly file: string;
  release(): void;
}

/** Thrown when another copy of this bot already runs on this machine. */
export class AlreadyRunningError extends Error {
  readonly pid: number;
  constructor(pid: number, file: string) {
    super(`another tg-cc-bot instance (pid ${pid}) already polls this bot on this machine (lock ${file})`);
    this.name = "AlreadyRunningError";
    this.pid = pid;
  }
}

/** Is `pid` a live process that looks like this bot? */
function isLiveBot(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false; // EPERM: alive, other user
  }
  // Guard against PID reuse after a crash: on Linux, check what the process is.
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("index.ts") || cmd.includes("tg-cc-bot");
  } catch {
    return true; // no /proc (or unreadable): trust the PID
  }
}

function readPid(file: string): number {
  try {
    return Number(fs.readFileSync(file, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** Machine-wide on Linux whatever TMPDIR the account sets. */
const defaultDir = () => (process.platform === "win32" ? os.tmpdir() : "/tmp");

/**
 * Telegram allows one poller per bot token; two copies of this bot on one
 * machine (the service plus a manual `bun src/index.ts`, two install
 * directories, two accounts…) would steal each other's messages with 409
 * Conflict. The lock is per bot, in a directory every account shares, so it
 * does not depend on the working directory or the state file. A stale lock
 * (its process is gone) is taken over, even one another account left behind:
 * the file is world-writable because a sticky /tmp forbids deleting it.
 */
export function acquireInstanceLock(botId: number, dir = defaultDir()): InstanceLock {
  const file = path.join(dir, `tg-cc-bot-${botId}.lock`);
  const mine = String(process.pid);
  const lock: InstanceLock = {
    file,
    release: () => {
      if (readPid(file) !== process.pid) return;
      try {
        fs.unlinkSync(file);
      } catch {
        try {
          fs.writeFileSync(file, ""); // can't delete it here: leave it empty, i.e. stale
        } catch {
          // gone or unwritable: nothing to release
        }
      }
    },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o666);
      try {
        fs.fchmodSync(fd, 0o666); // past the umask, so any account can take over a stale lock
      } catch {
        // not supported here: deleting a stale lock still works for its owner
      }
      fs.writeSync(fd, mine);
      fs.closeSync(fd);
      return lock;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = readPid(file);
      if (pid && pid !== process.pid && isLiveBot(pid)) throw new AlreadyRunningError(pid, file);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Another account's stale lock in a sticky directory: overwrite it instead.
        try {
          fs.writeFileSync(file, mine);
          if (readPid(file) === process.pid) return lock;
        } catch {
          // fall through to the error below
        }
      }
    }
  }
  throw new Error(`could not take the lock ${file}; delete it if no tg-cc-bot runs on this machine`);
}
