#!/usr/bin/env node
import { parseArgs, USAGE } from "./args.js";
import { logsCommand, runCommand, statusCommand } from "./commands.js";

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
    case "run":
      return runCommand(positional!, dbPath);
    case "status":
      return statusCommand(dbPath);
    case "logs":
      return logsCommand(positional!, dbPath);
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