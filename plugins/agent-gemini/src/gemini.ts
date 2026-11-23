import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentPlugin,
  CapabilityCard,
  RunContext,
  RunResult,
  TaskSpec,
} from "@conductgun/core";
import {
  buildAgentPrompt,
  createRunRegistry,
  nodeSpawn,
  parseJsonLines,
  probeBinary,
  runHeadless,
  truncate,
  type Spawner,
} from "@conductgun/agent-cli-utils";

export interface GeminiAdapterOptions {
  spawner?: Spawner;
  killGraceMs?: number;
  homeDir?: string;
}

const geminiCard: CapabilityCard = {
  id: "gemini",
  displayName: "Gemini CLI",
  strengths: {
    instructionFollowing: 4,
    reasoning: 4,
    speed: 4,
    costTier: "standard",
    domains: ["coding", "search", "docs"],
  },
  maxConcurrency: 2,
  transports: ["headless-cli"],
};

function extractSummary(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) {
      const response = (parsed as Record<string, unknown>).response;
      if (typeof response === "string" && response.length > 0) return response;
    }
  } catch {
    // not a single JSON blob; fall through to JSONL scan
  }
  for (const event of parseJsonLines(stdout).reverse()) {
    if (typeof event !== "object" || event === null) continue;
    const response = (event as Record<string, unknown>).response;
    if (typeof response === "string" && response.length > 0) return response;
  }
  return undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createGeminiAdapter(opts: GeminiAdapterOptions = {}): AgentPlugin {
  const spawner = opts.spawner ?? nodeSpawn;
  const registry = createRunRegistry();

  return {
    card: geminiCard,

    async healthCheck() {
      if (!(await probeBinary("gemini", spawner))) {
        return { ok: false, detail: "gemini CLI 未安装（PATH 中找不到 gemini）" };
      }
      // Existence check only — credential contents are never read or printed.
      const credsPath = join(opts.homeDir ?? homedir(), ".gemini", "oauth_creds.json");
      if (await fileExists(credsPath)) {
        return { ok: true, detail: "gemini 已安装，检测到 OAuth 凭据文件" };
      }
      if (process.env.GEMINI_API_KEY !== undefined && process.env.GEMINI_API_KEY.length > 0) {
        return { ok: true, detail: "gemini 已安装，检测到 GEMINI_API_KEY 环境变量" };
      }
      return { ok: false, detail: "gemini 未登录：未找到 OAuth 凭据，请先交互式运行一次 gemini 完成登录" };
    },

    async execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult> {
      const signal = registry.begin(ctx.runId, ctx.signal);
      try {
        const prompt = buildAgentPrompt(spec);
        ctx.reportEvent("start", `gemini headless（approval-mode yolo）于 ${ctx.workdir}`);
        const outcome = await runHeadless({
          command: "gemini",
          // -w/--worktree is deliberately never passed: worktree isolation belongs to core.
          // --skip-trust: fresh task worktrees are untrusted folders and would block headless runs.
          args: ["-p", prompt, "--approval-mode", "yolo", "-o", "json", "--skip-trust"],
          cwd: ctx.workdir,
          signal,
          spawner,
          killGraceMs: opts.killGraceMs,
          onStderrLine: (line) => ctx.reportEvent("stderr", truncate(line, 200)),
        });

        if (outcome.aborted) {
          ctx.reportEvent("aborted", `run ${ctx.runId} aborted`);
          return { ok: false, summary: "aborted" };
        }
        if (outcome.spawnError !== undefined) {
          ctx.reportEvent("failed", outcome.spawnError);
          return { ok: false, summary: `gemini 启动失败：${outcome.spawnError}` };
        }
        const summary =
          extractSummary(outcome.stdout) ??
          (outcome.ok ? "gemini 执行完成（无消息输出）" : `gemini 退出码 ${outcome.exitCode ?? "未知"}`);
        ctx.reportEvent(outcome.ok ? "done" : "failed", truncate(summary, 200));
        const result: RunResult = { ok: outcome.ok, summary: truncate(summary, 500) };
        if (spec.artifacts.includes("report")) {
          result.artifacts = [{ kind: "report", content: summary }];
        }
        return result;
      } finally {
        registry.end(ctx.runId);
      }
    },

    async cancel(runId: string): Promise<void> {
      registry.cancel(runId);
    },
  };
}

export const geminiPlugin: AgentPlugin = createGeminiAdapter();