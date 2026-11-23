import { existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/index";
import { gitSync, makeGitRepo } from "./helpers";

let repoDir: string;
let head: string;
let manager: WorktreeManager;

beforeEach(() => {
  ({ dir: repoDir, head } = makeGitRepo());
  manager = new WorktreeManager({ repoRoot: repoDir });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function worktreePaths(): string[] {
  return gitSync(repoDir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

describe("WorktreeManager.create", () => {
  it("creates a worktree with frozen naming and baseCommit = creation-time HEAD", async () => {
    const handle = await manager.create("agent-a", "t-aaaa1111");
    expect(handle.taskId).toBe("t-aaaa1111");
    expect(handle.agentId).toBe("agent-a");
    expect(handle.path).toBe(join(repoDir, ".cg", "worktrees", "t-aaaa1111"));
    expect(handle.branch).toBe("cg/agent-a/t-aaaa1111");
    expect(handle.baseCommit).toBe(head);
    expect(existsSync(join(handle.path, "README.md"))).toBe(true);
    expect(worktreePaths()).toContain(handle.path);
    expect(gitSync(repoDir, ["rev-parse", "--verify", handle.branch]).trim()).toBe(head);
  });

  it("is idempotent per taskId (returns the existing handle, no second worktree)", async () => {
    const first = await manager.create("agent-a", "t-bbbb2222");
    const second = await manager.create("agent-a", "t-bbbb2222");
    expect(second).toEqual(first);
    expect(worktreePaths().filter((p) => p === first.path)).toHaveLength(1);
  });

  it("idempotency is keyed by taskId even if agentId differs", async () => {
    const first = await manager.create("agent-a", "t-cccc3333");
    const second = await manager.create("agent-b", "t-cccc3333");
    expect(second).toEqual(first);
  });

  it("concurrent creates for different tasks do not interfere", async () => {
    const [h1, h2] = await Promise.all([
      manager.create("agent-a", "t-dddd4444"),
      manager.create("agent-b", "t-eeee5555"),
    ]);
    expect(h1.path).not.toBe(h2.path);
    expect(h1.branch).toBe("cg/agent-a/t-dddd4444");
    expect(h2.branch).toBe("cg/agent-b/t-eeee5555");
    expect(worktreePaths()).toEqual(expect.arrayContaining([h1.path, h2.path]));
    expect(existsSync(join(h1.path, "README.md"))).toBe(true);
    expect(existsSync(join(h2.path, "README.md"))).toBe(true);
  });

  it("concurrent creates for the same task converge to one worktree", async () => {
    const [h1, h2] = await Promise.all([
      manager.create("agent-a", "t-ffff6666"),
      manager.create("agent-a", "t-ffff6666"),
    ]);
    expect(h1).toEqual(h2);
    expect(worktreePaths().filter((p) => p === h1.path)).toHaveLength(1);
  });

  it("honors a custom worktreesDir", async () => {
    const custom = join(repoDir, "elsewhere");
    const m = new WorktreeManager({ repoRoot: repoDir, worktreesDir: custom });
    const handle = await m.create("agent-a", "t-gggg7777");
    expect(handle.path).toBe(join(custom, "t-gggg7777"));
    expect(existsSync(handle.path)).toBe(true);
  });

  it("records baseCommit at creation time even if HEAD advances later", async () => {
    const h1 = await manager.create("agent-a", "t-hhhh8888");
    writeFileSync(join(repoDir, "second.txt"), "advance\n");
    gitSync(repoDir, ["add", "-A"]);
    gitSync(repoDir, ["commit", "-m", "second"]);
    const newHead = gitSync(repoDir, ["rev-parse", "HEAD"]).trim();
    expect(newHead).not.toBe(head);

    const h2 = await manager.create("agent-a", "t-iiii9999");
    expect(h2.baseCommit).toBe(newHead);
    const h1Again = await manager.create("agent-a", "t-hhhh8888");
    expect(h1Again.baseCommit).toBe(head);
  });

  it("rejects when repoRoot is not a git repository", async () => {
    const plain = join(repoDir, "not-a-repo");
    const m = new WorktreeManager({ repoRoot: plain });
    await expect(m.create("agent-a", "t-jjjj0000")).rejects.toThrow();
  });
});

describe("WorktreeManager crash recovery", () => {
  it("a new manager instance reuses the same worktree (idempotent create)", async () => {
    const first = await manager.create("agent-a", "t-kkkk1111");
    const reopened = new WorktreeManager({ repoRoot: repoDir });
    const second = await reopened.create("agent-a", "t-kkkk1111");
    expect(second).toEqual(first);
    expect(worktreePaths().filter((p) => p === first.path)).toHaveLength(1);
  });

  it("rebuilds the handle if the metadata file was lost but the worktree exists", async () => {
    const first = await manager.create("agent-a", "t-llll2222");
    unlinkSync(join(repoDir, ".cg", "worktrees", "t-llll2222.json"));
    const reopened = new WorktreeManager({ repoRoot: repoDir });
    const rebuilt = await reopened.create("agent-a", "t-llll2222");
    expect(rebuilt).toEqual(first);
    expect(worktreePaths().filter((p) => p === first.path)).toHaveLength(1);
  });
});

describe("WorktreeManager.list", () => {
  it("returns handles of created worktrees", async () => {
    const h1 = await manager.create("agent-a", "t-mmmm3333");
    const h2 = await manager.create("agent-b", "t-nnnn4444");
    const listed = await manager.list();
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([h1, h2]));
  });

  it("returns empty when nothing was created", async () => {
    expect(await manager.list()).toEqual([]);
  });
});