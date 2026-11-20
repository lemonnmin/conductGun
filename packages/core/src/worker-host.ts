import { appendEventInternal, TaskQueue } from "./queue.js";
import type { AgentPlugin, RunContext, TaskRecord } from "./types.js";

interface InflightRun {
  promise: Promise<void>;
  controller: AbortController;
}

export class WorkerHost {
  private readonly queue: TaskQueue;
  private readonly plugins: AgentPlugin[];
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private readonly activeCounts = new Map<string, number>();
  private readonly inflight = new Map<string, InflightRun>();

  constructor(queue: TaskQueue, plugins: AgentPlugin[], opts?: { pollIntervalMs?: number }) {
    this.queue = queue;
    this.plugins = plugins;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 200;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    for (const plugin of this.plugins) {
      this.queue.registerAgent(plugin.card);
    }
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const run of this.inflight.values()) {
      run.controller.abort();
    }
    await Promise.all([...this.inflight.values()].map((run) => run.promise));
  }

  private tick(): void {
    if (this.stopping) return;
    for (const plugin of this.plugins) {
      const agentId = plugin.card.id;
      while ((this.activeCounts.get(agentId) ?? 0) < plugin.card.maxConcurrency) {
        const claimed = this.queue.claimNext(agentId);
        if (!claimed) break;
        this.launch(plugin, claimed.task, claimed.runId);
      }
    }
  }

  private launch(plugin: AgentPlugin, task: TaskRecord, runId: string): void {
    const agentId = plugin.card.id;
    this.activeCounts.set(agentId, (this.activeCounts.get(agentId) ?? 0) + 1);
    const controller = new AbortController();
    const ctx: RunContext = {
      runId,
      taskId: task.id,
      workdir: process.cwd(),
      signal: controller.signal,
      reportEvent: (kind, message) => {
        appendEventInternal(this.queue, {
          taskId: task.id,
          runId,
          ts: Date.now(),
          kind,
          message,
        });
      },
      heartbeat: () => {},
    };
    const promise = (async () => {
      try {
        const result = await plugin.execute(task.spec, ctx);
        this.queue.completeRun(runId, result);
      } catch (err) {
        this.queue.failRun(runId, err instanceof Error ? err.message : String(err));
      } finally {
        this.activeCounts.set(agentId, (this.activeCounts.get(agentId) ?? 1) - 1);
        this.inflight.delete(runId);
      }
    })();
    this.inflight.set(runId, { promise, controller });
  }
}