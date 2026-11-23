import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface ChildProcessLike {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export type Spawner = (
  command: string,
  args: readonly string[],
  opts: { cwd: string },
) => ChildProcessLike;

export const nodeSpawn: Spawner = (command, args, opts) =>
  spawn(command, [...args], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

export interface HeadlessRunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
  spawner: Spawner;
  killGraceMs?: number | undefined;
  onStdoutLine?: ((line: string) => void) | undefined;
  onStderrLine?: ((line: string) => void) | undefined;
}

export interface HeadlessRunOutcome {
  ok: boolean;
  aborted: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

const MAX_CAPTURE = 256 * 1024;
const DEFAULT_KILL_GRACE_MS = 5000;

function capAppend(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next;
}

function attachLines(
  stream: Readable | null,
  capture: (chunk: string) => void,
  onLine: ((line: string) => void) | undefined,
): void {
  if (!stream) return;
  let remainder = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    capture(chunk);
    if (!onLine) return;
    remainder += chunk;
    let newline = remainder.indexOf("\n");
    while (newline >= 0) {
      const line = remainder.slice(0, newline);
      remainder = remainder.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = remainder.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (onLine && remainder.length > 0) onLine(remainder);
  });
}

export function runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunOutcome> {
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise((resolve) => {
    if (opts.signal.aborted) {
      resolve({ ok: false, aborted: true, exitCode: null, exitSignal: null, stdout: "", stderr: "" });
      return;
    }

    let child: ChildProcessLike;
    try {
      child = opts.spawner(opts.command, opts.args, { cwd: opts.cwd });
    } catch (err) {
      resolve({
        ok: false,
        aborted: false,
        exitCode: null,
        exitSignal: null,
        stdout: "",
        stderr: "",
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: HeadlessRunOutcome): void => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      resolve(outcome);
    };

    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, graceMs);
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      finish({
        ok: false,
        aborted,
        exitCode: null,
        exitSignal: null,
        stdout,
        stderr,
        spawnError: err.message,
      });
    });
    child.on("exit", (code, signal) => {
      finish({ ok: !aborted && code === 0, aborted, exitCode: code, exitSignal: signal, stdout, stderr });
    });

    attachLines(child.stdout, (chunk) => { stdout = capAppend(stdout, chunk); }, opts.onStdoutLine);
    attachLines(child.stderr, (chunk) => { stderr = capAppend(stderr, chunk); }, opts.onStderrLine);
  });
}