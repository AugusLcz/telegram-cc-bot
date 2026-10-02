import { spawn } from "node:child_process";

export interface ExecResult {
  /** Exit code; 127 when the program was not found, -1 when it was stopped for taking too long. */
  code: number;
  stdout: string;
  stderr: string;
  /** Output beyond `maxBytes` was dropped. */
  truncated: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Per stream; default 1 MB. */
  maxBytes?: number;
}

/** Run a program without a shell, with no stdin, a time limit and bounded output. */
export type Exec = (file: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export const runProgram: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 1024 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const collect = (chunks: Buffer[], size: number, chunk: Buffer): number => {
      if (size >= max) {
        truncated = true;
        return size;
      }
      const room = max - size;
      if (chunk.length > room) truncated = true;
      chunks.push(chunk.subarray(0, room));
      return size + Math.min(chunk.length, room);
    };
    child.stdout.on("data", (c: Buffer) => (outBytes = collect(out, outBytes, c)));
    child.stderr.on("data", (c: Buffer) => (errBytes = collect(err, errBytes, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    let done = false;
    const finish = (code: number, extraErr = "") => {
      if (done) return; // "error" can be followed by "close"
      done = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extraErr,
        truncated,
      });
    };
    child.on("error", (e: NodeJS.ErrnoException) => finish(e.code === "ENOENT" ? 127 : 1, `${file}: ${e.message}`));
    child.on("close", (code) => finish(timedOut ? -1 : (code ?? 1), timedOut ? `\n${file} stopped after ${opts.timeoutMs / 1000}s` : ""));
  });
