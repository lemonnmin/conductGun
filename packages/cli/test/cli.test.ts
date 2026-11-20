import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskQueue, WorkerHost, newTaskId } from "@conductgun/core";
import type { AgentPlugin, CapabilityCard, RunContext, RunResult, TaskSpec } from "@conductgun/core";
import { createEchoPlugin, echoPlugin } from "@conductgun/agent-echo";
import { logsCommand, runCommand, statusCommand } from "../src/commands.js";
import type { CommandIo } from "../src/commands.js";
import { buildTaskSpec } from "../src/spec.js";

function collector(): { io: CommandIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { print: (line) => lines.push(line) }, lines };
}

// 本地 stub：card.id 用 "echo" 以匹配 M0 TaskSpec 的 preferredAgent
function createStubPlugin(): AgentPlugin {
  const card: CapabilityCard = {
    id: "echo",
    displayName: "Stub (cli test)",
    strengths: { instructionFollowing: 3, reasoning: 3, speed: 5, costTier: "cheap", domains: ["echo"] },
    maxConcurrency: 1,
    transports: ["headless-cli"],
  };
  return {
    card,
    async healthCheck() {
      return { ok: true };
    },
    async execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult> {
      ctx.reportEvent("stub", `stub echo: ${spec.goal}`);
      return { ok: true, summary: `stub echo: ${spec.goal}` };
    },
    async cancel() {},
  };
}

async function waitUntilDone(queue: TaskQueue, taskId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = queue.getTask(taskId);
    if (task?.status === "done") return;
    if (task?.status === "failed" || task?.status === "cancelled") {
      throw new Error(`task ended as ${task.status}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for task done");
}

describe("CLI 闭环（真实 SQLite 队列）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cg-cli-test-"));
    dbPath = join(dir, "queue.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stub 插件消费闭环：run 入队→消费→done", async () => {
    const { io, lines } = collector();
    const exit = await runCommand("hello stub", dbPath, io, [createStubPlugin()]);
    expect(exit).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("完成");
    expect(lines[0]).toContain("stub echo: hello stub");

    const queue = new TaskQueue(dbPath);
    try {
      const tasks = queue.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe("done");
      expect(tasks[0]!.spec.goal).toBe("hello stub");
    } finally {
      queue.close();
    }
  });

  it("真实 echo 集成：cg run → done + 摘要；status 可见；logs 有事件", async () => {
    const run = collector();
    const exit = await runCommand("hello", dbPath, run.io);
    expect(exit).toBe(0);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toContain("完成");
    expect(run.lines[0]).toContain("hello");

    const queue = new TaskQueue(dbPath);
    let taskId: string;
    try {
      const tasks = queue.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe("done");
      taskId = tasks[0]!.id;
    } finally {
      queue.close();
    }

    const status = collector();
    expect(statusCommand(dbPath, status.io)).toBe(0);
    expect(status.lines.join("\n")).toContain(taskId);
    expect(status.lines.join("\n")).toContain("done");

    const logs = collector();
    expect(logsCommand(taskId, dbPath, logs.io)).toBe(0);
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(logs.lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} {2}\[/);
  });

  it("失败路径：注入失败的 echo → 退出码非 0 + 失败提示", async () => {
    const { io, lines } = collector();
    const exit = await runCommand("boom", dbPath, io, [createEchoPlugin({ failNext: 1 })]);
    expect(exit).toBe(1);
    expect(lines[0]).toContain("失败");
  });

  it("logs 任务不存在 → 友好提示 + 退出码 1", () => {
    const { io, lines } = collector();
    expect(logsCommand("t-nonexist", dbPath, io)).toBe(1);
    expect(lines[0]).toContain("找不到任务");
  });

  it("status 空队列 → 友好提示", () => {
    const { io, lines } = collector();
    expect(statusCommand(dbPath, io)).toBe(0);
    expect(lines[0]).toContain("队列是空的");
  });

  it("重启恢复：claim 后崩溃 → 新实例 recover → 重新消费至 done", async () => {
    const spec = buildTaskSpec(newTaskId(), "crash me");

    const crashed = new TaskQueue(dbPath);
    crashed.registerAgent(echoPlugin.card);
    crashed.enqueue(spec);
    const claimed = crashed.claimNext("echo");
    expect(claimed).not.toBeNull();
    expect(crashed.getTask(spec.taskId)!.status).toBe("running");
    crashed.close(); // 模拟进程崩溃：不 complete 直接丢弃

    const revived = new TaskQueue(dbPath);
    try {
      expect(revived.recover()).toBe(1);
      expect(revived.getTask(spec.taskId)!.status).toBe("queued");
      expect(revived.recover()).toBe(0); // 幂等

      revived.registerAgent(echoPlugin.card);
      const host = new WorkerHost(revived, [echoPlugin]);
      host.start();
      try {
        await waitUntilDone(revived, spec.taskId);
      } finally {
        await host.stop();
      }
      expect(revived.getTask(spec.taskId)!.status).toBe("done");
    } finally {
      revived.close();
    }
  });

  it("重启恢复经 cg run 触发：遗留 running 任务被 recover 并一起消费", async () => {
    const spec = buildTaskSpec(newTaskId(), "leftover");
    const crashed = new TaskQueue(dbPath);
    crashed.registerAgent(echoPlugin.card);
    crashed.enqueue(spec);
    crashed.claimNext("echo");
    crashed.close();

    const { io } = collector();
    expect(await runCommand("new task", dbPath, io)).toBe(0);

    const queue = new TaskQueue(dbPath);
    try {
      const tasks = queue.listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.status === "done")).toBe(true);
    } finally {
      queue.close();
    }
  });
});