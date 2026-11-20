import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskQueue, WorkerHost } from "../src/index";
import type { AgentPlugin, RunResult } from "../src/index";
import { deferred, makeCard, makeSpec, makeTempDb, okResult, stubPlugin } from "./helpers";

let dir: string;
let queue: TaskQueue;
let host: WorkerHost | null;

beforeEach(() => {
  const tmp = makeTempDb();
  dir = tmp.dir;
  queue = new TaskQueue(tmp.dbPath);
  host = null;
});

afterEach(async () => {
  if (host) await host.stop();
  queue.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeHost(plugins: AgentPlugin[]): WorkerHost {
  host = new WorkerHost(queue, plugins, { pollIntervalMs: 10 });
  return host;
}

describe("WorkerHost consumption", () => {
  it("consumes a queued task to done and records plugin events", async () => {
    const spec = makeSpec({ requiredCapabilities: ["tests"] });
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async (_spec, ctx) => {
      ctx.reportEvent("progress", "halfway");
      ctx.heartbeat();
      return okResult(`finished: ${_spec.goal}`);
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("done");
    });
    const events = queue.listEvents(spec.taskId);
    expect(events.map((e) => e.kind)).toEqual(["enqueued", "claimed", "progress", "done"]);
    const progress = events[2]!;
    expect(progress.message).toBe("halfway");
    expect(progress.runId).toBeTruthy();
    expect(events.at(-1)!.message).toBe("finished: test goal");
  });

  it("marks task failed when execute throws", async () => {
    const spec = makeSpec();
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async () => {
      throw new Error("plugin exploded");
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    });
    expect(queue.listEvents(spec.taskId).at(-1)!.message).toBe("plugin exploded");
  });

  it("marks task failed when execute returns ok:false", async () => {
    const spec = makeSpec();
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async () => ({
      ok: false,
      summary: "injected failure",
    }));
    makeHost([plugin]).start();

    await vi.waitFor(() => {
      expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    });
  });

  it("does not consume tasks that do not match the plugin card", async () => {
    const spec = makeSpec({ requiredCapabilities: ["other-domain"] });
    queue.enqueue(spec);
    const plugin = stubPlugin(makeCard("stub-a"), async () => okResult());
    makeHost([plugin]).start();

    await new Promise((r) => setTimeout(r, 50));
    expect(queue.getTask(spec.taskId)!.status).toBe("queued");
  });
});

describe("WorkerHost maxConcurrency", () => {
  it("runs at most maxConcurrency tasks per agent (limit 1)", async () => {
    const s1 = makeSpec();
    const s2 = makeSpec();
    queue.enqueue(s1);
    queue.enqueue(s2);

    const gates = [deferred<RunResult>(), deferred<RunResult>()];
    let calls = 0;
    const plugin = stubPlugin(makeCard("stub-a", { maxConcurrency: 1 }), () => {
      const gate = gates[calls]!;
      calls += 1;
      return gate.promise;
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    expect(queue.getTask(s2.taskId)!.status).toBe("queued");

    gates[0]!.resolve(okResult("first"));
    await vi.waitFor(() => expect(calls).toBe(2));
    gates[1]!.resolve(okResult("second"));
    await vi.waitFor(() => {
      expect(queue.getTask(s1.taskId)!.status).toBe("done");
      expect(queue.getTask(s2.taskId)!.status).toBe("done");
    });
  });

  it("allows parallel runs up to maxConcurrency (limit 2)", async () => {
    const s1 = makeSpec();
    const s2 = makeSpec();
    queue.enqueue(s1);
    queue.enqueue(s2);

    const gate = deferred<RunResult>();
    let calls = 0;
    const plugin = stubPlugin(makeCard("stub-a", { maxConcurrency: 2 }), () => {
      calls += 1;
      return gate.promise;
    });
    makeHost([plugin]).start();

    await vi.waitFor(() => expect(calls).toBe(2));
    expect(queue.getTask(s1.taskId)!.status).toBe("running");
    expect(queue.getTask(s2.taskId)!.status).toBe("running");
    gate.resolve(okResult());
    await vi.waitFor(() => {
      expect(queue.getTask(s1.taskId)!.status).toBe("done");
      expect(queue.getTask(s2.taskId)!.status).toBe("done");
    });
  });
});

describe("WorkerHost stop", () => {
  it("aborts in-flight runs, waits for them to settle, and stops polling", async () => {
    const spec = makeSpec();
    queue.enqueue(spec);
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => {
      started = r;
    });
    const plugin = stubPlugin(makeCard("stub-a"), (_spec, ctx) => {
      started();
      return new Promise<RunResult>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          resolve({ ok: false, summary: "aborted" });
        });
      });
    });
    const h = makeHost([plugin]);
    h.start();
    await startedPromise;
    expect(queue.getTask(spec.taskId)!.status).toBe("running");

    await h.stop();
    expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    expect(queue.listEvents(spec.taskId).at(-1)!.message).toBe("aborted");

    const late = makeSpec();
    queue.enqueue(late);
    await new Promise((r) => setTimeout(r, 50));
    expect(queue.getTask(late.taskId)!.status).toBe("queued");
  });

  it("stop resolves immediately when nothing is in flight", async () => {
    const plugin = stubPlugin(makeCard("stub-a"), async () => okResult());
    const h = makeHost([plugin]);
    h.start();
    await h.stop();
  });
});