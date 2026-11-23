export const DEFAULT_DB_PATH = ".cg/queue.sqlite";

export const USAGE = `用法:
  cg run "<text>" [--db <path>]              把一句话任务入队并执行，输出结果摘要
      [--agent <id>]                         指定执行 agent（claude/codex/gemini），默认 echo
      [--no-wait]                            只入队不执行，之后用 cg drain 消费
      [--timeout <sec>]                      等待超时秒数（echo 默认 30，真实 agent 默认 600）
  cg status [--db <path>]                    查看队列中的任务
  cg logs <task-id> [--db <path>]            查看某个任务的事件记录
  cg agents                                  列出可用 agent 及健康状态
  cg drain [--db <path>] [--timeout <sec>]   消费队列中所有任务（worktree 隔离），默认超时 600s

默认队列文件: ${DEFAULT_DB_PATH}（相对当前目录）`;

export interface ParsedArgs {
  command: "run" | "status" | "logs" | "agents" | "drain" | "help";
  positional: string | null;
  dbPath: string;
  agent?: string;
  noWait?: boolean;
  timeoutSec?: number;
}

export type ParseResult =
  | { ok: true; args: ParsedArgs }
  | { ok: false; error: string };

export function parseArgs(argv: string[]): ParseResult {
  let dbPath = DEFAULT_DB_PATH;
  let agent: string | undefined;
  let noWait = false;
  let timeoutSec: number | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: "--db 需要一个路径参数，例如 --db .cg/queue.sqlite" };
      }
      dbPath = value;
      i++;
    } else if (arg === "--agent") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: "--agent 需要一个 agent id，例如 --agent codex" };
      }
      agent = value;
      i++;
    } else if (arg === "--timeout") {
      const value = argv[i + 1];
      const parsed = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false, error: "--timeout 需要一个正整数秒数，例如 --timeout 900" };
      }
      timeoutSec = parsed;
      i++;
    } else if (arg === "--no-wait") {
      noWait = true;
    } else if (arg.startsWith("--") && arg !== "--help") {
      return { ok: false, error: `未知选项 ${arg}` };
    } else {
      rest.push(arg);
    }
  }

  const command = rest[0];
  if (command === undefined || command === "--help" || command === "help") {
    return { ok: true, args: { command: "help", positional: null, dbPath } };
  }

  if (command === "run" || command === "logs") {
    const positional = rest[1];
    if (positional === undefined || positional.trim() === "") {
      const what = command === "run" ? "任务内容" : "任务 id";
      return { ok: false, error: `cg ${command} 缺少${what}。${command === "run" ? '例如: cg run "hello"' : "例如: cg logs t-abc123"}` };
    }
    if (rest.length > 2) {
      return { ok: false, error: `cg ${command} 只接受一个参数，多余: ${rest.slice(2).join(" ")}` };
    }
    if (command === "logs" && (agent !== undefined || noWait || timeoutSec !== undefined)) {
      return { ok: false, error: "cg logs 不支持 --agent/--no-wait/--timeout" };
    }
    const args: ParsedArgs = { command, positional, dbPath };
    if (command === "run") {
      if (agent !== undefined) args.agent = agent;
      if (noWait) args.noWait = true;
      if (timeoutSec !== undefined) args.timeoutSec = timeoutSec;
    }
    return { ok: true, args };
  }

  if (command === "status" || command === "agents" || command === "drain") {
    if (rest.length > 1) {
      return { ok: false, error: `cg ${command} 不接受额外参数: ${rest.slice(1).join(" ")}` };
    }
    if (agent !== undefined || noWait || (command !== "drain" && timeoutSec !== undefined)) {
      return { ok: false, error: `cg ${command} 不支持 --agent/--no-wait${command === "drain" ? "" : "/--timeout"}` };
    }
    const args: ParsedArgs = { command, positional: null, dbPath };
    if (command === "drain" && timeoutSec !== undefined) args.timeoutSec = timeoutSec;
    return { ok: true, args };
  }

  return { ok: false, error: `未知命令 "${command}"` };
}