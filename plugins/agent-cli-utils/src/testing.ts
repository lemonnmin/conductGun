import { PassThrough } from "node:stream";
import type { ChildProcessLike, Spawner } from "./spawn.js";

export interface StubScript {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  exitDelayMs?: number;
  /** Never exit on its own; only a kill ends the process. */
  hang?: boolean;
  /** With hang: ignore SIGTERM, exit only on SIGKILL (for grace-period assertions). */
  ignoreTerm?: boolean;
  /** Emit an error event instead of running (e.g. "spawn ENOENT"). */
  spawnError?: string;
}

export interface StubProcess extends ChildProcessLike {
  readonly killSignals: NodeJS.Signals[];
}

export interface ScriptedSpawner {
  (command: string, args: readonly string[], opts: { cwd: string }): StubProcess;
  readonly calls: { command: string; args: string[]; cwd: string }[];
  readonly processes: StubProcess[];
}

function makeStubProcess(script: StubScript): StubProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  const killSignals: NodeJS.Signals[] = [];
  let exited = false;
  let exitTimer: NodeJS.Timeout | undefined;

  const doExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    if (exitTimer) clearTimeout(exitTimer);
    stdout.end();
    stderr.end();
    setImmediate(() => {
      for (const listener of exitListeners) listener(code, signal);
    });
  };

  const proc: StubProcess = {
    pid: 424242,
    stdout,
    stderr,
    killSignals,
    kill(signal?: NodeJS.Signals): boolean {
      const sig = signal ?? "SIGTERM";
      killSignals.push(sig);
      if (script.hang && (sig === "SIGKILL" || !script.ignoreTerm)) {
        doExit(null, sig);
      }
      return true;
    },
    on(
      event: "exit" | "error",
      listener:
        | ((code: number | null, signal: NodeJS.Signals | null) => void)
        | ((err: Error) => void),
    ): StubProcess {
      if (event === "exit") {
        exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      } else {
        errorListeners.push(listener as (err: Error) => void);
      }
      return proc;
    },
  };

  if (script.spawnError !== undefined) {
    const message = script.spawnError;
    setImmediate(() => {
      for (const listener of errorListeners) listener(new Error(message));
    });
  } else {
    setImmediate(() => {
      for (const line of script.stdout ?? []) stdout.write(`${line}\n`);
      for (const line of script.stderr ?? []) stderr.write(`${line}\n`);
      if (script.hang) return;
      exitTimer = setTimeout(() => doExit(script.exitCode ?? 0, null), script.exitDelayMs ?? 0);
    });
  }

  return proc;
}

export function createScriptedSpawner(
  script: StubScript | ((command: string, args: readonly string[]) => StubScript) = {},
): ScriptedSpawner {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const processes: StubProcess[] = [];
  const spawner: ScriptedSpawner = Object.assign(
    (command: string, args: readonly string[], opts: { cwd: string }): StubProcess => {
      calls.push({ command, args: [...args], cwd: opts.cwd });
      const resolved = typeof script === "function" ? script(command, args) : script;
      const proc = makeStubProcess(resolved);
      processes.push(proc);
      return proc;
    },
    { calls, processes },
  );
  return spawner;
}

export type { Spawner };