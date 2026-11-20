export const DEFAULT_DB_PATH = ".cg/queue.sqlite";

export const USAGE = `用法:
  cg run "<text>" [--db <path>]   把一句话任务入队并执行，输出结果摘要
  cg status [--db <path>]         查看队列中的任务
  cg logs <task-id> [--db <path>] 查看某个任务的事件记录

默认队列文件: ${DEFAULT_DB_PATH}（相对当前目录）`;

export interface ParsedArgs {
  command: "run" | "status" | "logs" | "help";
  positional: string | null;
  dbPath: string;
}

export type ParseResult =
  | { ok: true; args: ParsedArgs }
  | { ok: false; error: string };

export function parseArgs(argv: string[]): ParseResult {
  let dbPath = DEFAULT_DB_PATH;
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
    return { ok: true, args: { command, positional, dbPath } };
  }

  if (command === "status") {
    if (rest.length > 1) {
      return { ok: false, error: `cg status 不接受额外参数: ${rest.slice(1).join(" ")}` };
    }
    return { ok: true, args: { command: "status", positional: null, dbPath } };
  }

  return { ok: false, error: `未知命令 "${command}"` };
}