import { TaskQueue, WorkerHost, newTaskId } from "@conductgun/core";
import type { AgentPlugin, TaskRecord } from "@conductgun/core";
import { echoPlugin } from "@conductgun/agent-echo";
import { buildTaskSpec } from "./spec.js";
import { formatEventLine, formatRunOutcome, formatTaskLine } from "./format.js";

export interface CommandIo {
  print(line: string): void;
}

const consoleIo: CommandIo = { print: (line) => console.log(line) };

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);
const POLL_INTERVAL_MS = 50;
const ECHO_TIMEOUT_MS = 30_000;
const REAL_AGENT_TIMEOUT_MS = 600_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(queue: TaskQueue, taskId: string, timeoutMs: number): Promise<TaskRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = queue.getTask(taskId);
    if (task && TERMINAL_STATUSES.has(task.status)) return task;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

export interface RunOptions {
  agent?: string;
  noWait?: boolean;
  timeoutSec?: number;
}

export async function runCommand(
  text: string,
  dbPath: string,
  io: CommandIo = consoleIo,
  plugins: AgentPlugin[] = [echoPlugin],
  opts: RunOptions = {},
): Promise<number> {
  const queue = new TaskQueue(dbPath);
  try {
    queue.recover();
    const record = queue.enqueue(buildTaskSpec(newTaskId(), text, opts.agent));
    if (opts.noWait) {
      io.print(`已入队 ${record.id}，稍后运行 cg drain 消费`);
      return 0;
    }
    for (const plugin of plugins) queue.registerAgent(plugin.card);
    const host = new WorkerHost(queue, plugins);
    host.start();
    try {
      const isRealAgent = opts.agent !== undefined && opts.agent !== "echo";
      const timeoutMs = opts.timeoutSec !== undefined
        ? opts.timeoutSec * 1000
        : isRealAgent ? REAL_AGENT_TIMEOUT_MS : ECHO_TIMEOUT_MS;
      const task = await waitForTerminal(queue, record.id, timeoutMs);
      if (!task) {
        io.print(`任务 ${record.id} 超时未完成，可用 cg logs ${record.id} 查看详情`);
        return 1;
      }
      io.print(formatRunOutcome(task, queue.listEvents(task.id)));
      return task.status === "done" ? 0 : 1;
    } finally {
      await host.stop();
    }
  } finally {
    queue.close();
  }
}

export function statusCommand(
  dbPath: string,
  io: CommandIo = consoleIo,
): number {
  const queue = new TaskQueue(dbPath);
  try {
    queue.recover();
    const tasks = queue.listTasks();
    if (tasks.length === 0) {
      io.print('队列是空的，用 cg run "<text>" 添加任务');
      return 0;
    }
    for (const task of tasks) io.print(formatTaskLine(task));
    return 0;
  } finally {
    queue.close();
  }
}

export function logsCommand(
  taskId: string,
  dbPath: string,
  io: CommandIo = consoleIo,
): number {
  const queue = new TaskQueue(dbPath);
  try {
    queue.recover();
    if (!queue.getTask(taskId)) {
      io.print(`找不到任务 ${taskId}，用 cg status 查看现有任务`);
      return 1;
    }
    const events = queue.listEvents(taskId);
    if (events.length === 0) {
      io.print("该任务还没有事件记录");
      return 0;
    }
    for (const event of events) io.print(formatEventLine(event));
    return 0;
  } finally {
    queue.close();
  }
}