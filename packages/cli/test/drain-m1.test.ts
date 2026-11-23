import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskQueue, newTaskId } from "@conductgun/core";
import type { AgentPlugin, CapabilityCard, RunContext, RunResult, TaskSpec } from "@conductgun/core";
import { drainCommand } from "../src/drain.js";
import { runCommand } from "../src/commands.js";
import type { CommandIo } from "../src/commands.js";
import { buildTaskSpec } from "../src/spec.js";

function collector(): { io: CommandIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { print: (line) => lines.push(line) }, lines };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface StubStats {
  active: number;
  maxActive: number;
}

// 写文件型 stub：模拟真实 agent 在 ctx.workdir 内产出改动
function createWritingStub(id: string, stats: StubStats, opts: { delayMs?: number; fail?: boolean } = {}): AgentPlugin {
  const card: CapabilityCard = {
    id,
    displayName: `Stub ${id}`,
    strengths: { instructionFollowing: 4, reasoning: 4, speed: 4, costTier: "cheap", domains: ["coding"] },
    maxConcurrency: 2,
    transports: ["headless-cli"],
  };
  return {
    card,
    async healthCheck() {
      return { ok: true };
    },
    async execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult> {
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        ctx.reportEvent("stub", `${id} working in ${ctx.workdir}`);
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
        if (opts.fail) return { ok: false, summary: `${id} injected failure` };
        writeFileSync(join(ctx.workdir, `${id}-out.md`), `# ${spec.goal}\n`);
        return { ok: true, summary: `${id} done: ${spec.goal}` };
      } finally {
        stats.active--;
      }
    },
    async cancel() {},
  };
}

describe("cg drain 全链路（stub + 临时 git 仓库，零真实 CLI）", () => {
  let repoRoot: string;
  let dbPath: string;
  let stats: StubStats;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "cg-drain-repo-"));
    git(repoRoot, "init", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "CG Test");
    writeFileSync(join(repoRoot, ".gitignore"), ".cg/\n");
    writeFileSync(join(repoRoot, "README.md"), "fixture\n");
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-m", "initial");
    dbPath = join(repoRoot, ".cg", "queue.sqlite");
    stats = { active: 0, maxActive: 0 };
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("--no-wait 入队两任务 → drain 并行消费：worktree 隔离 + diff 可审查 + 总结", async () => {
    const codex = createWritingStub("codex", stats, { delayMs: 200 });
    const gemini = createWritingStub("gemini", stats, { delayMs: 200 });
    const plugins = [codex, gemini];

    const enq = collector();
    expect(await runCommand("任务A", dbPath, enq.io, plugins, { agent: "codex", noWait: true })).toBe(0);
    expect(await runCommand("任务B", dbPath, enq.io, plugins, { agent: "gemini", noWait: true })).toBe(0);

    const { io, lines } = collector();
    const exit = await drainCommand(dbPath, io, { plugins, repoRoot, timeoutSec: 30 });
    expect(exit).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("drain 结束：2 done / 0 failed");
    expect(stats.maxActive).toBeGreaterThanOrEqual(2);

    const queue = new TaskQueue(dbPath);
    try {
      const tasks = queue.listTasks();
      expect(tasks.every((t) => t.status === "done")).toBe(true);
      const baseCommit = git(repoRoot, "rev-parse", "HEAD");
      for (const task of tasks) {
        const agentId = task.spec.preferredAgent!;
        const wtPath = join(repoRoot, ".cg", "worktrees", task.id);
        expect(existsSync(wtPath)).toBe(true);
        expect(output).toContain(wtPath);
        expect(output).toContain(`git -C ${wtPath} diff ${baseCommit}`);
        expect(git(repoRoot, "branch", "--list", `cg/${agentId}/${task.id}`)).toContain(task.id);
        expect(readFileSync(join(wtPath, `${agentId}-out.md`), "utf8")).toContain(task.spec.goal);
        // WorkerHost 已 git add -A，diff --cached 基线可审查
        expect(git(wtPath, "diff", "--cached", baseCommit)).toContain(`${agentId}-out.md`);
        // worktree 事件已上报
        expect(queue.listEvents(task.id).some((e) => e.kind === "worktree")).toBe(true);
      }
      // 两个 worktree 互相隔离、主工作区未被触碰
      const [a, b] = queue.listTasks();
      expect(existsSync(join(repoRoot, ".cg", "worktrees", a!.id, "gemini-out.md"))).toBe(false);
      expect(existsSync(join(repoRoot, ".cg", "worktrees", b!.id, "codex-out.md"))).toBe(false);
      expect(git(repoRoot, "status", "--porcelain")).toBe("");
      expect(git(repoRoot, "rev-parse", "HEAD")).toBe(baseCommit);
    } finally {
      queue.close();
    }
  }, 30_000);

  it("失败任务：drain exit 1，worktree 保留供排查", async () => {
    const failing = createWritingStub("codex", stats, { fail: true });
    const enq = collector();
    await runCommand("会失败", dbPath, enq.io, [failing], { agent: "codex", noWait: true });

    const { io, lines } = collector();
    const exit = await drainCommand(dbPath, io, { plugins: [failing], repoRoot, timeoutSec: 30 });
    expect(exit).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("drain 结束：0 done / 1 failed");
    expect(output).toContain("injected failure");

    const queue = new TaskQueue(dbPath);
    try {
      const task = queue.listTasks()[0]!;
      expect(task.status).toBe("failed");
      expect(existsSync(join(repoRoot, ".cg", "worktrees", task.id))).toBe(true);
      expect(output).toContain(join(repoRoot, ".cg", "worktrees", task.id));
    } finally {
      queue.close();
    }
  }, 30_000);

  it("崩溃遗留 running 任务：drain recover 后重新消费至 done", async () => {
    const codex = createWritingStub("codex", stats);
    const spec = buildTaskSpec(newTaskId(), "崩溃遗留", "codex");
    const crashed = new TaskQueue(dbPath);
    crashed.registerAgent(codex.card);
    crashed.enqueue(spec);
    crashed.claimNext("codex");
    crashed.close();

    const { io, lines } = collector();
    const exit = await drainCommand(dbPath, io, { plugins: [codex], repoRoot, timeoutSec: 30 });
    expect(exit).toBe(0);
    expect(lines.join("\n")).toContain("drain 结束：1 done / 0 failed");

    const queue = new TaskQueue(dbPath);
    try {
      expect(queue.getTask(spec.taskId)!.status).toBe("done");
    } finally {
      queue.close();
    }
  }, 30_000);

  it("空队列：友好提示 exit 0", async () => {
    const { io, lines } = collector();
    const exit = await drainCommand(dbPath, io, { plugins: [], repoRoot, timeoutSec: 5 });
    expect(exit).toBe(0);
    expect(lines[0]).toContain("队列是空的");
  });
});