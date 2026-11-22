import { describe, expect, it } from "vitest";
import {
  buildAgentPrompt,
  createRunRegistry,
  parseJsonLines,
  probeBinary,
  runHeadless,
  truncate,
} from "../src/index.js";
import { createScriptedSpawner } from "../src/testing.js";

describe("runHeadless", () => {
  it("captures stdout/stderr and exit code", async () => {
    const spawner = createScriptedSpawner({
      stdout: ["line one", "line two"],
      stderr: ["warn"],
      exitCode: 3,
    });
    const lines: string[] = [];
    const errLines: string[] = [];
    const outcome = await runHeadless({
      command: "fake",
      args: ["a"],
      cwd: "/tmp",
      signal: new AbortController().signal,
      spawner,
      onStdoutLine: (l) => lines.push(l),
      onStderrLine: (l) => errLines.push(l),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stdout).toBe("line one\nline two\n");
    expect(outcome.stderr).toBe("warn\n");
    expect(lines).toEqual(["line one", "line two"]);
    expect(errLines).toEqual(["warn"]);
    expect(spawner.calls).toEqual([{ command: "fake", args: ["a"], cwd: "/tmp" }]);
  });

  it("exit 0 is ok", async () => {
    const outcome = await runHeadless({
      command: "fake",
      args: [],
      cwd: "/tmp",
      signal: new AbortController().signal,
      spawner: createScriptedSpawner({ stdout: ["ok"] }),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.aborted).toBe(false);
  });

  it("abort sends SIGTERM then SIGKILL after the grace period", async () => {
    const spawner = createScriptedSpawner({ hang: true, ignoreTerm: true });
    const controller = new AbortController();
    const pending = runHeadless({
      command: "fake",
      args: [],
      cwd: "/tmp",
      signal: controller.signal,
      spawner,
      killGraceMs: 20,
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome.aborted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("abort resolves promptly when the process honors SIGTERM", async () => {
    const spawner = createScriptedSpawner({ hang: true });
    const controller = new AbortController();
    const pending = runHeadless({
      command: "fake",
      args: [],
      cwd: "/tmp",
      signal: controller.signal,
      spawner,
      killGraceMs: 5000,
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome.aborted).toBe(true);
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("pre-aborted signal never spawns", async () => {
    const spawner = createScriptedSpawner({});
    const controller = new AbortController();
    controller.abort();
    const outcome = await runHeadless({
      command: "fake",
      args: [],
      cwd: "/tmp",
      signal: controller.signal,
      spawner,
    });
    expect(outcome.aborted).toBe(true);
    expect(spawner.calls).toHaveLength(0);
  });

  it("surfaces spawn errors without throwing", async () => {
    const outcome = await runHeadless({
      command: "missing",
      args: [],
      cwd: "/tmp",
      signal: new AbortController().signal,
      spawner: createScriptedSpawner({ spawnError: "spawn missing ENOENT" }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.spawnError).toBe("spawn missing ENOENT");
  });
});

describe("probeBinary", () => {
  it("true when which exits 0", async () => {
    const spawner = createScriptedSpawner({ exitCode: 0 });
    expect(await probeBinary("codex", spawner)).toBe(true);
    expect(spawner.calls[0]).toMatchObject({ command: "which", args: ["codex"] });
  });

  it("false when which exits non-zero", async () => {
    expect(await probeBinary("claude", createScriptedSpawner({ exitCode: 1 }))).toBe(false);
  });
});

describe("buildAgentPrompt", () => {
  it("assembles all structured TaskSpec fields", () => {
    const prompt = buildAgentPrompt({
      taskId: "t-x",
      goal: "the goal",
      context: "the context",
      instructions: "the instructions",
      constraints: ["no push"],
      acceptanceCriteria: ["tests pass"],
      assumptions: ["M1 direct-fill exception"],
      requiredCapabilities: [],
      artifacts: ["diff"],
    });
    expect(prompt).toContain("the goal");
    expect(prompt).toContain("the context");
    expect(prompt).toContain("the instructions");
    expect(prompt).toContain("- no push");
    expect(prompt).toContain("- tests pass");
    expect(prompt).toContain("- M1 direct-fill exception");
  });

  it("omits empty sections", () => {
    const prompt = buildAgentPrompt({
      taskId: "t-x",
      goal: "g",
      context: "",
      instructions: "i",
      constraints: [],
      acceptanceCriteria: [],
      assumptions: [],
      requiredCapabilities: [],
      artifacts: [],
    });
    expect(prompt).not.toContain("## Context");
    expect(prompt).not.toContain("## Constraints");
  });
});

describe("text helpers", () => {
  it("truncate keeps short text and caps long text", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a".repeat(20), 10)).toBe(`${"a".repeat(10)}…`);
  });

  it("parseJsonLines skips non-JSON noise", () => {
    expect(parseJsonLines('{"a":1}\nnot json\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("createRunRegistry", () => {
  it("merges host abort into the run signal", () => {
    const registry = createRunRegistry();
    const host = new AbortController();
    const signal = registry.begin("r1", host.signal);
    expect(signal.aborted).toBe(false);
    host.abort();
    expect(signal.aborted).toBe(true);
    registry.end("r1");
  });

  it("begin with already-aborted host signal aborts immediately", () => {
    const registry = createRunRegistry();
    const host = new AbortController();
    host.abort();
    expect(registry.begin("r1", host.signal).aborted).toBe(true);
    registry.end("r1");
  });

  it("cancel aborts only the matching run and is idempotent", () => {
    const registry = createRunRegistry();
    const s1 = registry.begin("r1", new AbortController().signal);
    const s2 = registry.begin("r2", new AbortController().signal);
    registry.cancel("r1");
    registry.cancel("r1");
    registry.cancel("unknown");
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(false);
    registry.end("r1");
    registry.end("r2");
  });

  it("end detaches the host listener", () => {
    const registry = createRunRegistry();
    const host = new AbortController();
    const signal = registry.begin("r1", host.signal);
    registry.end("r1");
    host.abort();
    expect(signal.aborted).toBe(false);
  });
});