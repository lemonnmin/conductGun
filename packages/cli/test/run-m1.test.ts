import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskQueue } from "@conductgun/core";
import type { AgentPlugin, CapabilityCard, RunContext, RunResult, TaskSpec } from "@conductgun/core";
import { runCommand } from "../src/commands.js";
import type { CommandIo } from "../src/commands.js";
import { M1_CONSTRAINTS, M1_SCAFFOLD_ASSUMPTION } from "../src/spec.js";

function collector(): { io: CommandIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { print: (line) => lines.push(line) }, lines };
}

function createStubAgent(id: string, opts: { delayMs?: number } = {}): AgentPlugin {
  const card: CapabilityCard = {
    id,
    displayName: `Stub ${id}`,
    strengths: { instructionFollowing: 3, reasoning: 3, speed: 5, costTier: "cheap", domains: ["coding"] },
    maxConcurrency: 2,
    transports: ["headless-cli"],
  };
  return {
    card,
    async healthCheck() {
      return { ok: true };
    },
    async execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult> {
      ctx.reportEvent("stub", `${id} start: ${spec.goal}`);
      if (opts.delayMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, opts.delayMs);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (ctx.signal.aborted) return { ok: false, summary: "aborted" };
      }
      return { ok: true, summary: `${id} done: ${spec.goal}` };
    },
    async cancel() {},
  };
}

describe("cg run M1 扩展（stub，零真实 CLI）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cg-run-m1-"));
    dbPath = join(dir, "queue.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--agent 路由到指定 agent，落库 Spec 含约束注入与 diff", async () => {
    const { io, lines } = collector();
    const exit = await runCommand("写文档", dbPath, io, [createStubAgent("codex")], { agent: "codex" });
    expect(exit).toBe(0);
    expect(lines[0]).toContain("codex done: 写文档");

    const queue = new TaskQueue(dbPath);
    try {
      const task = queue.listTasks()[0]!;
      expect(task.status).toBe("done");
      expect(task.spec.preferredAgent).toBe("codex");
      expect(task.spec.requiredCapabilities).toEqual([]);
      expect(task.spec.constraints).toEqual(M1_CONSTRAINTS);
      expect(task.spec.assumptions).toEqual([M1_SCAFFOLD_ASSUMPTION]);
      expect(task.spec.artifacts).toContain("diff");
    } finally {
      queue.close();
    }
  });

  it("--no-wait 只入队不消费，打印任务 id，exit 0", async () => {
    const { io, lines } = collector();
    const exit = await runCommand("稍后做", dbPath, io, [createStubAgent("codex")], { agent: "codex", noWait: true });
    expect(exit).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/已入队 t-/);
    expect(lines[0]).toContain("cg drain");

    const queue = new TaskQueue(dbPath);
    try {
      const tasks = queue.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe("queued");
      expect(lines[0]).toContain(tasks[0]!.id);
    } finally {
      queue.close();
    }
  });

  it("--timeout 覆盖：超时未完成 → exit 1 + 友好提示", async () => {
    const { io, lines } = collector();
    const exit = await runCommand("慢任务", dbPath, io, [createStubAgent("codex", { delayMs: 5000 })], {
      agent: "codex",
      timeoutSec: 1,
    });
    expect(exit).toBe(1);
    expect(lines[0]).toContain("超时未完成");
    expect(lines[0]).toContain("cg logs");
  }, 10_000);

  it("默认无 --agent 仍走 echo（M0 行为不变）", async () => {
    const { io, lines } = collector();
    const exit = await runCommand("hello", dbPath, io);
    expect(exit).toBe(0);
    expect(lines[0]).toContain("完成");

    const queue = new TaskQueue(dbPath);
    try {
      const task = queue.listTasks()[0]!;
      expect(task.spec.preferredAgent).toBe("echo");
      expect(task.spec.constraints).toEqual([]);
      expect(task.spec.artifacts).toEqual(["report"]);
    } finally {
      queue.close();
    }
  });
});