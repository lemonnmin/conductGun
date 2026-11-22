import { describe, expect, it } from "vitest";
import {
  createContractRunHarness,
  makeContractTaskSpec,
  runAgentContractTests,
} from "@conductgun/agent-echo/contract";
import { createScriptedSpawner } from "@conductgun/agent-cli-utils/testing";
import { createClaudeAdapter } from "../src/index.js";

const resultEvent = JSON.stringify({ type: "result", result: "claude finished the task" });

function healthySpawner() {
  return createScriptedSpawner((command) => {
    if (command === "which") return { exitCode: 0 };
    return { stdout: [resultEvent] };
  });
}

runAgentContractTests("claude", () => createClaudeAdapter({ spawner: healthySpawner() }), {
  createFailing: () => createClaudeAdapter({ spawner: createScriptedSpawner({ exitCode: 1 }) }),
});

describe("claude specifics", () => {
  it("exposes the frozen card", () => {
    expect(createClaudeAdapter().card).toEqual({
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
    });
  });

  it("uses -p with stream-json output and cwd=ctx.workdir", async () => {
    const spawner = healthySpawner();
    const harness = createContractRunHarness();
    await createClaudeAdapter({ spawner }).execute(makeContractTaskSpec(), harness.ctx);
    const call = spawner.calls.find((c) => c.command === "claude");
    expect(call?.cwd).toBe(harness.ctx.workdir);
    expect(call?.args).toEqual(["-p", expect.any(String), "--output-format", "stream-json"]);
  });

  it("prompt carries every structured TaskSpec field", async () => {
    const spawner = healthySpawner();
    const spec = makeContractTaskSpec({
      goal: "the goal",
      context: "the context",
      instructions: "the instructions",
      constraints: ["禁止 git push / 任何远端写操作"],
      acceptanceCriteria: ["tests pass"],
    });
    await createClaudeAdapter({ spawner }).execute(spec, createContractRunHarness().ctx);
    const prompt = spawner.calls.find((c) => c.command === "claude")?.args[1] ?? "";
    expect(prompt).toContain("the goal");
    expect(prompt).toContain("the context");
    expect(prompt).toContain("the instructions");
    expect(prompt).toContain("禁止 git push / 任何远端写操作");
    expect(prompt).toContain("tests pass");
  });

  it("extracts the stream-json result event as summary", async () => {
    const result = await createClaudeAdapter({ spawner: healthySpawner() }).execute(
      makeContractTaskSpec(),
      createContractRunHarness().ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("claude finished the task");
    expect(result.artifacts?.[0]).toMatchObject({ kind: "report" });
  });

  it("abort kills with SIGTERM then SIGKILL after grace and returns ok:false", async () => {
    const spawner = createScriptedSpawner({ hang: true, ignoreTerm: true });
    const plugin = createClaudeAdapter({ spawner, killGraceMs: 20 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    harness.controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, summary: "aborted" });
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cancel(runId) aborts the in-flight run and is idempotent", async () => {
    const spawner = createScriptedSpawner({ hang: true });
    const plugin = createClaudeAdapter({ spawner, killGraceMs: 20 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    await plugin.cancel(harness.ctx.runId);
    await plugin.cancel(harness.ctx.runId);
    await plugin.cancel("unknown-run");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("healthCheck: installed (stub)", async () => {
    const health = await createClaudeAdapter({ spawner: healthySpawner() }).healthCheck();
    expect(health.ok).toBe(true);
  });

  it("healthCheck: not installed (stub)", async () => {
    const health = await createClaudeAdapter({
      spawner: createScriptedSpawner({ exitCode: 1 }),
    }).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toBe("claude CLI 未安装");
  });

  it("non-zero exit and spawn errors yield ok:false", async () => {
    const failing = await createClaudeAdapter({
      spawner: createScriptedSpawner({ exitCode: 2 }),
    }).execute(makeContractTaskSpec(), createContractRunHarness().ctx);
    expect(failing.ok).toBe(false);
    expect(failing.summary).toContain("退出码");

    const missing = await createClaudeAdapter({
      spawner: createScriptedSpawner({ spawnError: "spawn claude ENOENT" }),
    }).execute(makeContractTaskSpec(), createContractRunHarness().ctx);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain("启动失败");
  });
});