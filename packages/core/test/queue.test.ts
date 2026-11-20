import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskQueue } from "../src/index";
import { makeCard, makeSpec, makeTempDb } from "./helpers";

let dir: string;
let dbPath: string;
let queue: TaskQueue;

beforeEach(() => {
  ({ dir, dbPath } = makeTempDb());
  queue = new TaskQueue(dbPath);
});

afterEach(() => {
  queue.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("enqueue", () => {
  it("persists spec as JSON with status queued and creates parent dirs", () => {
    const spec = makeSpec({ goal: "ship it", requiredCapabilities: ["tests"] });
    const record = queue.enqueue(spec);
    expect(record.id).toBe(spec.taskId);
    expect(record.status).toBe("queued");

    const loaded = queue.getTask(spec.taskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.spec).toEqual(spec);
    expect(loaded!.status).toBe("queued");
    expect(queue.listTasks().map((t) => t.id)).toEqual([spec.taskId]);
  });

  it("writes an enqueued event", () => {
    const spec = makeSpec();
    queue.enqueue(spec);
    const events = queue.listEvents(spec.taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("enqueued");
    expect(events[0]!.taskId).toBe(spec.taskId);
  });

  it("returns null for unknown task and empty events for unknown task", () => {
    expect(queue.getTask("t-missing")).toBeNull();
    expect(queue.listEvents("t-missing")).toEqual([]);
  });
});

describe("claimNext matching rules", () => {
  it("matches preferredAgent exactly", () => {
    queue.registerAgent(makeCard("agent-a"));
    queue.registerAgent(makeCard("agent-b"));
    const spec = makeSpec({ preferredAgent: "agent-a" });
    queue.enqueue(spec);

    expect(queue.claimNext("agent-b")).toBeNull();
    const claimed = queue.claimNext("agent-a");
    expect(claimed).not.toBeNull();
    expect(claimed!.task.id).toBe(spec.taskId);
    expect(claimed!.task.status).toBe("running");
    expect(claimed!.runId).toBeTruthy();
  });

  it("preferredAgent ignores capability matching", () => {
    queue.registerAgent(makeCard("agent-a", {
      strengths: { ...makeCard("agent-a").strengths, domains: [] },
    }));
    queue.enqueue(makeSpec({ preferredAgent: "agent-a", requiredCapabilities: ["tests"] }));
    expect(queue.claimNext("agent-a")).not.toBeNull();
  });

  it("matches when requiredCapabilities is a subset of domains", () => {
    queue.registerAgent(makeCard("agent-a"));
    queue.enqueue(makeSpec({ requiredCapabilities: ["tests"] }));
    expect(queue.claimNext("agent-a")).not.toBeNull();
  });

  it("does not match when a required capability is missing", () => {
    queue.registerAgent(makeCard("agent-a"));
    queue.enqueue(makeSpec({ requiredCapabilities: ["tests", "unknown-domain"] }));
    expect(queue.claimNext("agent-a")).toBeNull();
    expect(queue.getTask(queue.listTasks()[0]!.id)!.status).toBe("queued");
  });

  it("empty requiredCapabilities matches any registered agent", () => {
    queue.registerAgent(makeCard("agent-a"));
    queue.enqueue(makeSpec());
    expect(queue.claimNext("agent-a")).not.toBeNull();
  });

  it("returns null for unregistered agent", () => {
    queue.enqueue(makeSpec());
    expect(queue.claimNext("ghost")).toBeNull();
  });
});

describe("claimNext atomicity and FIFO", () => {
  it("claims each task exactly once (queued -> running is atomic)", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);

    const first = queue.claimNext("agent-a");
    expect(first).not.toBeNull();
    expect(queue.getTask(spec.taskId)!.status).toBe("running");
    expect(queue.claimNext("agent-a")).toBeNull();
  });

  it("claims in createdAt FIFO order", () => {
    queue.registerAgent(makeCard("agent-a"));
    const s1 = makeSpec();
    const s2 = makeSpec();
    const s3 = makeSpec();
    queue.enqueue(s1);
    queue.enqueue(s2);
    queue.enqueue(s3);

    expect(queue.claimNext("agent-a")!.task.id).toBe(s1.taskId);
    expect(queue.claimNext("agent-a")!.task.id).toBe(s2.taskId);
    expect(queue.claimNext("agent-a")!.task.id).toBe(s3.taskId);
    expect(queue.claimNext("agent-a")).toBeNull();
  });

  it("skips non-matching tasks and claims the first matching one", () => {
    queue.registerAgent(makeCard("agent-a"));
    const skipped = makeSpec({ requiredCapabilities: ["nope"] });
    const taken = makeSpec({ requiredCapabilities: ["tests"] });
    queue.enqueue(skipped);
    queue.enqueue(taken);
    expect(queue.claimNext("agent-a")!.task.id).toBe(taken.taskId);
    expect(queue.getTask(skipped.taskId)!.status).toBe("queued");
  });

  it("writes a claimed event with runId", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);
    const { runId } = queue.claimNext("agent-a")!;
    const events = queue.listEvents(spec.taskId);
    expect(events.map((e) => e.kind)).toEqual(["enqueued", "claimed"]);
    expect(events[1]!.runId).toBe(runId);
  });
});

describe("run terminal transitions", () => {
  it("completeRun with ok:true marks task done and records summary", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);
    const { runId } = queue.claimNext("agent-a")!;

    queue.completeRun(runId, { ok: true, summary: "all good" });
    expect(queue.getTask(spec.taskId)!.status).toBe("done");
    const events = queue.listEvents(spec.taskId);
    expect(events.map((e) => e.kind)).toEqual(["enqueued", "claimed", "done"]);
    expect(events[2]!.message).toBe("all good");
    expect(events[2]!.runId).toBe(runId);
  });

  it("completeRun with ok:false marks task failed", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);
    const { runId } = queue.claimNext("agent-a")!;

    queue.completeRun(runId, { ok: false, summary: "injected failure" });
    expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    expect(queue.listEvents(spec.taskId).at(-1)!.kind).toBe("failed");
  });

  it("failRun marks task failed and records the error", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);
    const { runId } = queue.claimNext("agent-a")!;

    queue.failRun(runId, "boom");
    expect(queue.getTask(spec.taskId)!.status).toBe("failed");
    const last = queue.listEvents(spec.taskId).at(-1)!;
    expect(last.kind).toBe("failed");
    expect(last.message).toBe("boom");
  });

  it("cancelRun marks task cancelled", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);
    const { runId } = queue.claimNext("agent-a")!;

    queue.cancelRun(runId);
    expect(queue.getTask(spec.taskId)!.status).toBe("cancelled");
    expect(queue.listEvents(spec.taskId).at(-1)!.kind).toBe("cancelled");
  });

  it("rejects transitions on unknown or already-terminal runs", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);
    const { runId } = queue.claimNext("agent-a")!;
    queue.completeRun(runId, { ok: true, summary: "done" });

    expect(() => queue.completeRun(runId, { ok: true, summary: "again" })).toThrow();
    expect(() => queue.failRun(runId, "late")).toThrow();
    expect(() => queue.cancelRun(runId)).toThrow();
    expect(() => queue.completeRun("r-missing", { ok: true, summary: "x" })).toThrow();
    expect(queue.getTask(spec.taskId)!.status).toBe("done");
  });
});

describe("recover (crash recovery)", () => {
  it("resets running tasks to queued after reopening the same db file", () => {
    queue.registerAgent(makeCard("agent-a"));
    const spec = makeSpec();
    queue.enqueue(spec);
    queue.claimNext("agent-a");
    expect(queue.getTask(spec.taskId)!.status).toBe("running");

    // simulate crash: drop the instance without completing the run
    queue.close();
    queue = new TaskQueue(dbPath);

    expect(queue.recover()).toBe(1);
    expect(queue.getTask(spec.taskId)!.status).toBe("queued");
    expect(queue.listEvents(spec.taskId).at(-1)!.kind).toBe("recovered");

    queue.registerAgent(makeCard("agent-a"));
    const reclaimed = queue.claimNext("agent-a");
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.task.id).toBe(spec.taskId);
    queue.completeRun(reclaimed!.runId, { ok: true, summary: "finished after recovery" });
    expect(queue.getTask(spec.taskId)!.status).toBe("done");
  });

  it("is idempotent and leaves terminal tasks untouched", () => {
    queue.registerAgent(makeCard("agent-a"));
    const running = makeSpec();
    const done = makeSpec();
    queue.enqueue(done);
    queue.enqueue(running);
    const doneRun = queue.claimNext("agent-a")!;
    queue.completeRun(doneRun.runId, { ok: true, summary: "ok" });
    queue.claimNext("agent-a");

    expect(queue.recover()).toBe(1);
    expect(queue.recover()).toBe(0);
    expect(queue.getTask(running.taskId)!.status).toBe("queued");
    expect(queue.getTask(done.taskId)!.status).toBe("done");
  });
});