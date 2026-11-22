import { execFileSync } from "node:child_process";
import { TaskQueue, WorkerHost, WorktreeManager } from "@conductgun/core";
import type { AgentPlugin, TaskEvent, TaskRecord, WorktreeHandle } from "@conductgun/core";
import { ALL_PLUGINS } from "./plugins.js";
import { formatDrainSummary, formatRunOutcome } from "./format.js";
import type { CommandIo } from "./commands.js";

const consoleIo: CommandIo = { print: (line) => console.log(line) };

const POLL_INTERVAL_MS = 100;
const DEFAULT_DRAIN_TIMEOUT_SEC = 600;

export interface DrainOptions {
  timeoutSec?: number;
  plugins?: AgentPlugin[];
  repoRoot?: string;
}

function resolveRepoRoot(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActive(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

export function formatDrainTaskLines(
  task: TaskRecord,
  handle: WorktreeHandle | undefined,
  events: TaskEvent[],
): string[] {
  const lines = [formatRunOutcome(task, events)];
  if (handle) {
    lines.push(`  worktree: ${handle.path}（分支 ${handle.branch}）`);
    lines.push(`  查看 diff: git -C ${handle.path} diff ${handle.baseCommit}`);
  } else {
    lines.push(`  详情: cg logs ${task.id}`);
  }
  return lines;
}

export async function drainCommand(
  dbPath: string,
  io: CommandIo = consoleIo,
  opts: DrainOptions = {},
): Promise<number> {
  const repoRoot = opts.repoRoot ?? resolveRepoRoot();
  if (!repoRoot) {
    io.print("drain 需要在 git 仓库内运行（worktree 隔离依赖 git）");
    return 1;
  }
  const plugins = opts.plugins ?? ALL_PLUGINS;
  const queue = new TaskQueue(dbPath);
  try {
    queue.recover();
    const pending = queue.listTasks().filter(isActive);
    if (pending.length === 0) {
      io.print("队列是空的，没有需要消费的任务");
      return 0;
    }
    const worktrees = new WorktreeManager({ repoRoot });
    const host = new WorkerHost(queue, plugins, { worktrees });
    host.start();
    const deadline = Date.now() + (opts.timeoutSec ?? DEFAULT_DRAIN_TIMEOUT_SEC) * 1000;
    try {
      while (Date.now() < deadline && queue.listTasks().some(isActive)) {
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      await host.stop();
    }
    const timedOut = queue.listTasks().some(isActive);
    const handles = await worktrees.list();
    const byTask = new Map(handles.map((h) => [h.taskId, h]));
    const finalTasks = pending
      .map((p) => queue.getTask(p.id))
      .filter((t): t is TaskRecord => t !== null);
    for (const task of finalTasks) {
      for (const line of formatDrainTaskLines(task, byTask.get(task.id), queue.listEvents(task.id))) {
        io.print(line);
      }
    }
    io.print(formatDrainSummary(finalTasks));
    if (timedOut) {
      io.print("超时仍有任务未完成，可再次运行 cg drain 继续");
      return 1;
    }
    return finalTasks.every((t) => t.status === "done") ? 0 : 1;
  } finally {
    queue.close();
  }
}