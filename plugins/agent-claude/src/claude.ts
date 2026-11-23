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

export interface ClaudeAdapterOptions {
  spawner?: Spawner;
  killGraceMs?: number;
}

const claudeCard: CapabilityCard = {
  id: "claude",
  displayName: "Claude Code",
  strengths: {
    instructionFollowing: 5,
    reasoning: 5,
    speed: 3,
    costTier: "premium",
    domains: ["coding", "refactor", "tests", "docs"],
  },
  maxConcurrency: 2,
  transports: ["headless-cli"],
};

function extractSummary(stdout: string): string | undefined {
  const events = parseJsonLines(stdout).reverse();
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record.type === "result" && typeof record.result === "string" && record.result.length > 0) {
      return record.result;
    }
  }
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (typeof record.result === "string" && record.result.length > 0) return record.result;
    if (typeof record.text === "string" && record.text.length > 0) return record.text;
  }
  return undefined;
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): AgentPlugin {
  const spawner = opts.spawner ?? nodeSpawn;
  const registry = createRunRegistry();

  return {
    card: claudeCard,

    async healthCheck() {
      if (!(await probeBinary("claude", spawner))) {
        return { ok: false, detail: "claude CLI 未安装" };
      }
      return { ok: true, detail: "claude 已安装（登录态与 headless flag 待真实校准）" };
    },

    async execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult> {
      const signal = registry.begin(ctx.runId, ctx.signal);
      try {
        const prompt = buildAgentPrompt(spec);
        ctx.reportEvent("start", `claude headless（stream-json）于 ${ctx.workdir}`);
        const outcome = await runHeadless({
          command: "claude",
          args: ["-p", prompt, "--output-format", "stream-json"],
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
          return { ok: false, summary: `claude 启动失败：${outcome.spawnError}` };
        }
        const summary =
          extractSummary(outcome.stdout) ??
          (outcome.ok ? "claude 执行完成（无消息输出）" : `claude 退出码 ${outcome.exitCode ?? "未知"}`);
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

export const claudePlugin: AgentPlugin = createClaudeAdapter();