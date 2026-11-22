import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { newTaskId } from "../src/index";
import type { AgentPlugin, CapabilityCard, RunResult, TaskSpec } from "../src/index";

export function gitSync(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function makeGitRepo(): { dir: string; head: string } {
  // macOS tmpdir 是 /var → /private/var 符号链接，git 报告解析后的真实路径
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cg-git-test-")));
  gitSync(dir, ["init", "-b", "main"]);
  gitSync(dir, ["config", "user.email", "test@example.com"]);
  gitSync(dir, ["config", "user.name", "CG Test"]);
  gitSync(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  gitSync(dir, ["add", "-A"]);
  gitSync(dir, ["commit", "-m", "initial"]);
  return { dir, head: gitSync(dir, ["rev-parse", "HEAD"]).trim() };
}

export function readLatestRunResult(dbPath: string, taskId: string): RunResult | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT result FROM runs WHERE task_id = ? AND result IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(taskId) as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as RunResult) : null;
  } finally {
    db.close();
  }
}

export function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId: newTaskId(),
    goal: "test goal",
    context: "",
    instructions: "do the thing",
    constraints: [],
    acceptanceCriteria: [],
    assumptions: [],
    requiredCapabilities: [],
    artifacts: ["report"],
    ...overrides,
  };
}

export function makeCard(id: string, overrides: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    id,
    displayName: `Stub ${id}`,
    strengths: {
      instructionFollowing: 3,
      reasoning: 3,
      speed: 5,
      costTier: "cheap",
      domains: ["tests", "mock"],
    },
    maxConcurrency: 1,
    transports: ["headless-cli"],
    ...overrides,
  };
}

export function makeTempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cg-core-test-"));
  return { dir, dbPath: join(dir, "nested", "queue.sqlite") };
}

export function stubPlugin(
  card: CapabilityCard,
  execute: AgentPlugin["execute"],
): AgentPlugin {
  return {
    card,
    healthCheck: async () => ({ ok: true }),
    execute,
    cancel: async () => {},
  };
}

export function okResult(summary = "ok"): RunResult {
  return { ok: true, summary };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}