import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskQueue, WorkerHost, WorktreeManager } from "../src/index";
import type { AgentPlugin } from "../src/index";
import {
  gitSync,
  makeCard,
  makeGitRepo,
  makeSpec,
  makeTempDb,
  okResult,
  readLatestRunResult,
  stubPlugin,
} from "./helpers";

const WAIT = { timeout: 5000, interval: 20 };

let repoDir: string;
let dbDir: string;
let dbPath: string;
let queue: TaskQueue;
let manager: WorktreeManager;
let host: WorkerHost | null;

beforeEach(() => {
  ({ dir: repoDir } = makeGitRepo());
  ({ dir: dbDir, dbPath } = makeTempDb());
  queue = new TaskQueue(dbPath);
  manager = new WorktreeManager({ repoRoot: repoDir });
  host = null;
});

afterEach(async () => {
  if (host) await host.stop();
  queue.close();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

function makeHost(plugins: AgentPlugin[], withWorktrees = true): WorkerHost {
  host = new WorkerHost(queue, plugins, {
    pollIntervalMs: 10,
    ...(withWorktrees ? { worktrees: manager } : {}),
  });
  return host;
}

describe("WorkerHost with worktrees (end to end)", () => {
  it("runs the plugin inside the task worktree and appends a reviewable diff artifact", async () => {
    const spec = makeSpec({ artifacts: ["diff", "report"] });
    queue.enqueue(spec);
    let seenWorkdir = "";
    const plugin = stubPlugin(makeCard("stub-a"), async (_s, ctx) => {
      seenWorkdir = ctx.workdir;
      writeFileSync(join(ctx.workdir, "hello.txt"), "hello from stub\n");
      return { ok: true, summary: "written", artifacts: [{ kind: "report", content: "r" }] };
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("done");
    }, WAIT);

    const [handle] = await manager.list();
    expect(handle).toBeTruthy();
    expect(seenWorkdir).toBe(handle!.path);
    expect(handle!.branch).toBe(`cg/stub-a/${spec.taskId}`);
    expect(existsSync(join(handle!.path, "hello.txt"))).toBe(true);

    const events = queue.listEvents(spec.taskId);
    const worktreeEvent = events.find((e) => e.kind === "worktree");
    expect(worktreeEvent?.message).toBe(handle!.path);

    const result = readLatestRunResult(dbPath, spec.taskId)!;
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts![0]).toEqual({ kind: "report", content: "r" });
    const diff = result.artifacts![1]!;
    expect(diff.kind).toBe("diff");
    expect(diff.content).toContain("hello.txt");
    expect(diff.content).toContain("+hello from stub");

    // worktree kept for review, visible in git worktree list
    const listed = gitSync(repoDir, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(handle!.path);
    // main working tree untouched
    expect(existsSync(join(repoDir, "hello.txt"))).toBe(false);
  });

  it("captures diffs of both committed and uncommitted plugin changes", async () => {
    const spec = makeSpec({ artifacts: ["diff"] });
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async (_s, ctx) => {
      writeFileSync(join(ctx.workdir, "committed.txt"), "committed line\n");
      gitSync(ctx.workdir, ["add", "-A"]);
      gitSync(ctx.workdir, ["commit", "-m", "plugin commit"]);
      writeFileSync(join(ctx.workdir, "uncommitted.txt"), "uncommitted line\n");
      return okResult("mixed");
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("done");
    }, WAIT);
    const result = readLatestRunResult(dbPath, spec.taskId)!;
    const diff = result.artifacts!.find((a) => a.kind === "diff")!;
    expect(diff.content).toContain("committed.txt");
    expect(diff.content).toContain("uncommitted.txt");
  });

  it("does not append a diff artifact when spec.artifacts lacks diff", async () => {
    const spec = makeSpec({ artifacts: ["report"] });
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async (_s, ctx) => {
      writeFileSync(join(ctx.workdir, "file.txt"), "x\n");
      return { ok: true, summary: "ok", artifacts: [{ kind: "report", content: "r" }] };
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("done");
    }, WAIT);
    const result = readLatestRunResult(dbPath, spec.taskId)!;
    expect(result.artifacts).toEqual([{ kind: "report", content: "r" }]);
  });

  it("keeps worktrees isolated across parallel tasks", async () => {
    const s1 = makeSpec({ artifacts: ["diff"] });
    const s2 = makeSpec({ artifacts: ["diff"] });
    queue.enqueue(s1);
    queue.enqueue(s2);
    const plugin = stubPlugin(makeCard("stub-a", { maxConcurrency: 2 }), async (spec, ctx) => {
      writeFileSync(join(ctx.workdir, `${spec.taskId}.txt`), `${spec.taskId}\n`);
      return okResult(spec.taskId);
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(s1.taskId)!.status).toBe("done");
      expect(queue.getTask(s2.taskId)!.status).toBe("done");
    }, WAIT);

    const handles = await manager.list();
    expect(handles).toHaveLength(2);
    const r1 = readLatestRunResult(dbPath, s1.taskId)!;
    const r2 = readLatestRunResult(dbPath, s2.taskId)!;
    const d1 = r1.artifacts!.find((a) => a.kind === "diff")!.content!;
    const d2 = r2.artifacts!.find((a) => a.kind === "diff")!.content!;
    expect(d1).toContain(`${s1.taskId}.txt`);
    expect(d1).not.toContain(`${s2.taskId}.txt`);
    expect(d2).toContain(`${s2.taskId}.txt`);
    expect(d2).not.toContain(`${s1.taskId}.txt`);
  });
});

describe("WorkerHost worktree failure paths", () => {
  it("keeps the worktree when execute throws", async () => {
    const spec = makeSpec({ artifacts: ["diff"] });
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async (_s, ctx) => {
      writeFileSync(join(ctx.workdir, "partial.txt"), "partial work\n");
      throw new Error("boom after partial work");
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    }, WAIT);
    const [handle] = await manager.list();
    expect(existsSync(join(handle!.path, "partial.txt"))).toBe(true);
    expect(queue.listEvents(spec.taskId).at(-1)!.message).toBe("boom after partial work");
  });

  it("keeps the worktree and skips diff capture when execute returns ok:false", async () => {
    const spec = makeSpec({ artifacts: ["diff"] });
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async (_s, ctx) => {
      writeFileSync(join(ctx.workdir, "partial.txt"), "partial\n");
      return { ok: false, summary: "injected failure" };
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    }, WAIT);
    const [handle] = await manager.list();
    expect(existsSync(handle!.path)).toBe(true);
    const result = readLatestRunResult(dbPath, spec.taskId)!;
    expect(result.artifacts ?? []).toEqual([]);
  });

  it("fails the run when worktree creation fails", async () => {
    const spec = makeSpec();
    queue.enqueue(spec);
    manager = new WorktreeManager({ repoRoot: join(repoDir, "not-a-repo") });
    const plugin = stubPlugin(makeCard("stub-a"), async () => okResult());
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    }, WAIT);
    expect(queue.listEvents(spec.taskId).at(-1)!.kind).toBe("failed");
  });
});

describe("WorkerHost workdir semantics", () => {
  it("without worktrees, workdir stays process.cwd() and no worktree event is written (M0)", async () => {
    const spec = makeSpec({ artifacts: ["diff"] });
    queue.enqueue(spec);
    let seenWorkdir = "";
    const plugin = stubPlugin(makeCard("stub-a"), async (_s, ctx) => {
      seenWorkdir = ctx.workdir;
      return okResult();
    });
    makeHost([plugin], false).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("done");
    }, WAIT);
    expect(seenWorkdir).toBe(process.cwd());
    expect(queue.listEvents(spec.taskId).some((e) => e.kind === "worktree")).toBe(false);
    expect(await manager.list()).toEqual([]);
  });

  it("after a simulated crash, recover + idempotent create reuses the same worktree", async () => {
    const spec = makeSpec({ artifacts: ["diff"] });
    const original = await manager.create("stub-a", spec.taskId);
    writeFileSync(join(original.path, "before-crash.txt"), "survives\n");

    queue.registerAgent(makeCard("stub-a"));
    queue.enqueue(spec);
    queue.claimNext("stub-a");
    queue.close();

    queue = new TaskQueue(dbPath);
    expect(queue.recover()).toBe(1);

    let seenWorkdir = "";
    const plugin = stubPlugin(makeCard("stub-a"), async (_s, ctx) => {
      seenWorkdir = ctx.workdir;
      writeFileSync(join(ctx.workdir, "after-crash.txt"), "resumed\n");
      return okResult("resumed");
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("done");
    }, WAIT);
    expect(seenWorkdir).toBe(original.path);
    expect(existsSync(join(original.path, "before-crash.txt"))).toBe(true);
    const handles = await manager.list();
    expect(handles).toHaveLength(1);
    expect(handles[0]).toEqual(original);
    const result = readLatestRunResult(dbPath, spec.taskId)!;
    const diff = result.artifacts!.find((a) => a.kind === "diff")!.content!;
    expect(diff).toContain("before-crash.txt");
    expect(diff).toContain("after-crash.txt");
  });
});