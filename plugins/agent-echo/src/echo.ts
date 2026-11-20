import type {
  AgentPlugin,
  CapabilityCard,
  RunContext,
  RunResult,
  TaskSpec,
} from "@conductgun/core";

export interface EchoPluginOptions {
  delayMs?: number;
  failNext?: number;
}

const echoCard: CapabilityCard = {
  id: "echo",
  displayName: "Echo (mock)",
  strengths: {
    instructionFollowing: 3,
    reasoning: 3,
    speed: 5,
    costTier: "cheap",
    domains: ["echo", "mock", "tests"],
  },
  maxConcurrency: 2,
  transports: ["headless-cli"],
};

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createEchoPlugin(opts: EchoPluginOptions = {}): AgentPlugin {
  const delayMs = opts.delayMs ?? 0;
  let failuresRemaining = opts.failNext ?? 0;
  // Host owns ctx.signal; cancel() can only abort via a plugin-side controller merged into it.
  const runs = new Map<string, AbortController>();

  return {
    card: echoCard,

    async healthCheck() {
      return { ok: true, detail: "in-process mock, no external dependencies" };
    },

    async execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult> {
      const run = new AbortController();
      runs.set(ctx.runId, run);
      const onHostAbort = () => run.abort();
      if (ctx.signal.aborted) {
        run.abort();
      } else {
        ctx.signal.addEventListener("abort", onHostAbort, { once: true });
      }

      try {
        ctx.reportEvent("start", `echo run ${ctx.runId} for task ${spec.taskId}`);
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          ctx.reportEvent("failed", "injected failure");
          return { ok: false, summary: "injected failure" };
        }
        await abortableDelay(delayMs, run.signal);
        ctx.heartbeat();
        ctx.reportEvent("echo", `goal: ${spec.goal} | instructions: ${spec.instructions}`);
        ctx.reportEvent("done", "echo completed");
        return {
          ok: true,
          summary: `echo ok — goal: ${spec.goal}; instructions: ${spec.instructions}`,
        };
      } catch (err) {
        if (run.signal.aborted) {
          ctx.reportEvent("aborted", `run ${ctx.runId} aborted`);
          return { ok: false, summary: "aborted" };
        }
        throw err;
      } finally {
        ctx.signal.removeEventListener("abort", onHostAbort);
        runs.delete(ctx.runId);
      }
    },

    async cancel(runId: string): Promise<void> {
      runs.get(runId)?.abort();
    },
  };
}

export const echoPlugin: AgentPlugin = createEchoPlugin();