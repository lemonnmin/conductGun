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

export interface CodexAdapterOptions {
  spawner?: Spawner;
  killGraceMs?: number;
}

const codexCard: CapabilityCard = {
  id: "codex",
  displayName: "Codex CLI",
  strengths: {
    instructionFollowing: 4,
    reasoning: 5,
    speed: 3,
    costTier: "premium",
    domains: ["coding", "debug", "tests"],
  },
  maxConcurrency: 2,
  transports: ["headless-cli"],
};

function extractSummary(stdout: string): string | undefined {
  for (const event of parseJsonLines(stdout).reverse()) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    const item = record.item as Record<string, unknown> | undefined;
    const text = item?.text ?? record.text ?? record.message;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return undefined;
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): AgentPlugin {
  const spawner = opts.spawner ?? nodeSpawn;
  const registry = createRunRegistry();

  return {
    card: codexCard,

    async healthCheck() {
      if (!(await probeBinary("codex", spawner))) {
        return { ok: false, detail: "codex CLI 未安装（PATH 中找不到 codex）" };
      }
      const login = await runHeadless({
        command: "codex",
        args: ["login", "status"],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        spawner,
      });
      if (login.spawnError !== undefined) {
        return { ok: false, detail: "codex 登录态探测失败，无法确认是否可用" };
      }
      if (!login.ok) {
        return { ok: false, detail: "codex 未登录或登录已过期，请先运行 codex login" };
      }
      return { ok: true, detail: "codex 已安装且已登录" };
    },

    async execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult> {
      const signal = registry.begin(ctx.runId, ctx.signal);
      try {
        const prompt = buildAgentPrompt(spec);
        ctx.reportEvent("start", `codex exec（沙箱 workspace-write）于 ${ctx.workdir}`);
        const outcome = await runHeadless({
          command: "codex",
          args: [
            "exec",
            "-C",
            ctx.workdir,
            "-s",
            "workspace-write",
            "--skip-git-repo-check",
            "--json",
            prompt,
          ],
          cwd: ctx.workdir,
          signal,
          spawner,
          killGraceMs: opts.killGraceMs,
          onStdoutLine: (line) => {
            for (const event of parseJsonLines(line)) {
              if (typeof event !== "object" || event === null) continue;
              const type = (event as Record<string, unknown>).type;
              if (type === "error" || type === "turn.failed") {
                ctx.reportEvent("agent-error", truncate(line, 200));
              }
            }
          },
          onStderrLine: (line) => ctx.reportEvent("stderr", truncate(line, 200)),
        });

        if (outcome.aborted) {
          ctx.reportEvent("aborted", `run ${ctx.runId} aborted`);
          return { ok: false, summary: "aborted" };
        }
        if (outcome.spawnError !== undefined) {
          ctx.reportEvent("failed", outcome.spawnError);
          return { ok: false, summary: `codex 启动失败：${outcome.spawnError}` };
        }
        const summary =
          extractSummary(outcome.stdout) ??
          (outcome.ok ? "codex 执行完成（无消息输出）" : `codex 退出码 ${outcome.exitCode ?? "未知"}`);
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

export const codexPlugin: AgentPlugin = createCodexAdapter();