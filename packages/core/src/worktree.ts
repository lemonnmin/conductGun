import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeHandle {
  taskId: string;
  agentId: string;
  path: string;
  branch: string;
  baseCommit: string;
}

async function git(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer });
  return stdout;
}

/** @internal 包内使用，不从 index.ts 导出 */
export async function captureDiffInternal(handle: WorktreeHandle): Promise<string> {
  await git(handle.path, ["add", "-A"]);
  return git(handle.path, ["diff", "--cached", handle.baseCommit], 16 * 1024 * 1024);
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly worktreesDir: string;
  // git worktree add 并发执行会竞争 refs 锁，实例内串行化创建
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: { repoRoot: string; worktreesDir?: string }) {
    this.repoRoot = resolve(opts.repoRoot);
    this.worktreesDir = resolve(opts.worktreesDir ?? join(this.repoRoot, ".cg", "worktrees"));
  }

  create(agentId: string, taskId: string): Promise<WorktreeHandle> {
    const run = this.chain.then(() => this.createInternal(agentId, taskId));
    this.chain = run.catch(() => {});
    return run;
  }

  async list(): Promise<WorktreeHandle[]> {
    if (!existsSync(this.worktreesDir)) return [];
    const handles: WorktreeHandle[] = [];
    for (const file of readdirSync(this.worktreesDir)) {
      if (!file.endsWith(".json")) continue;
      const handle = this.readHandleFile(join(this.worktreesDir, file));
      if (handle && existsSync(handle.path)) handles.push(handle);
    }
    return handles;
  }

  private async createInternal(agentId: string, taskId: string): Promise<WorktreeHandle> {
    const path = join(this.worktreesDir, taskId);
    const existing = this.readHandleFile(this.handlePath(taskId));
    if (existing && existsSync(existing.path)) return existing;

    if (existsSync(path)) {
      // worktree 已建但 handle 文件丢失（建后写前崩溃）：从 git 登记信息重建
      const rebuilt = await this.rebuildHandle(path, taskId);
      this.writeHandle(rebuilt);
      return rebuilt;
    }

    const baseCommit = (await git(this.repoRoot, ["rev-parse", "HEAD"])).trim();
    const branch = `cg/${agentId}/${taskId}`;
    mkdirSync(this.worktreesDir, { recursive: true });
    await git(this.repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
    const handle: WorktreeHandle = { taskId, agentId, path, branch, baseCommit };
    this.writeHandle(handle);
    return handle;
  }

  private async rebuildHandle(path: string, taskId: string): Promise<WorktreeHandle> {
    const porcelain = await git(this.repoRoot, ["worktree", "list", "--porcelain"]);
    let branch: string | null = null;
    let currentPath: string | null = null;
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
      else if (line.startsWith("branch ") && currentPath === path) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
    if (!branch) {
      throw new Error(`directory exists but is not a registered git worktree: ${path}`);
    }
    const agentId = branch.split("/")[1] ?? "";
    const baseCommit = (await git(this.repoRoot, ["merge-base", branch, "HEAD"])).trim();
    return { taskId, agentId, path, branch, baseCommit };
  }

  private handlePath(taskId: string): string {
    return join(this.worktreesDir, `${taskId}.json`);
  }

  private readHandleFile(file: string): WorktreeHandle | null {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as WorktreeHandle;
  }

  private writeHandle(handle: WorktreeHandle): void {
    // handle 元数据放在 worktree 目录之外，避免混入 git add -A 的 diff
    writeFileSync(this.handlePath(handle.taskId), JSON.stringify(handle, null, 2));
  }
}