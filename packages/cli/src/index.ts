#!/usr/bin/env node
import { parseArgs, USAGE } from "./args.js";
import { logsCommand, runCommand, statusCommand } from "./commands.js";
import type { RunOptions } from "./commands.js";
import { agentsCommand } from "./agents.js";
import { drainCommand } from "./drain.js";
import type { DrainOptions } from "./drain.js";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    return 1;
  }
  const { command, positional, dbPath } = parsed.args;
  switch (command) {
    case "help":
      console.log(USAGE);
      return 0;
    case "run": {
      const opts: RunOptions = {};
      if (parsed.args.agent !== undefined) opts.agent = parsed.args.agent;
      if (parsed.args.noWait) opts.noWait = true;
      if (parsed.args.timeoutSec !== undefined) opts.timeoutSec = parsed.args.timeoutSec;
      return runCommand(positional!, dbPath, undefined, undefined, opts);
    }
    case "status":
      return statusCommand(dbPath);
    case "logs":
      return logsCommand(positional!, dbPath);
    case "agents":
      return agentsCommand();
    case "drain": {
      const opts: DrainOptions = {};
      if (parsed.args.timeoutSec !== undefined) opts.timeoutSec = parsed.args.timeoutSec;
      return drainCommand(dbPath, undefined, opts);
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`出错了：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);