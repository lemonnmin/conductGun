import { describe, expect, it } from "vitest";
import {
  createContractRunHarness,
  makeContractTaskSpec,
  runAgentContractTests,
} from "@conductgun/agent-echo/contract";
import { createScriptedSpawner } from "@conductgun/agent-cli-utils/testing";
import { createCodexAdapter } from "../src/index.js";

const agentMessage = JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "codex finished the task" },
});

function healthySpawner() {
  return createScriptedSpawner((command, args) => {
    if (command === "which") return { exitCode: 0 };
    if (args[0] === "login") return { exitCode: 0 };
    return { stdout: [agentMessage] };
  });
}

runAgentContractTests("codex", () => createCodexAdapter({ spawner: healthySpawner() }), {
  createFailing: () => createCodexAdapter({ spawner: createScriptedSpawner({ exitCode: 1 }) }),
});

describe("codex specifics", () => {
  it("exposes the frozen card", () => {
    expect(createCodexAdapter().card).toEqual({
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
    });
  });

  it("uses the sandboxed headless command line with cwd=ctx.workdir", async () => {
    const spawner = healthySpawner();
    const harness = createContractRunHarness();
    await createCodexAdapter({ spawner }).execute(makeContractTaskSpec(), harness.ctx);
    const call = spawner.calls.find((c) => c.command === "codex" && c.args[0] === "exec");
    expect(call).toBeDefined();
    expect(call?.cwd).toBe(harness.ctx.workdir);
    expect(call?.args).toEqual([
      "exec",
      "-C",
      harness.ctx.workdir,
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "--json",
      expect.any(String),
    ]);
    expect(call?.args).not.toContain("--worktree");
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
    await createCodexAdapter({ spawner }).execute(spec, createContractRunHarness().ctx);
    const prompt = spawner.calls.find((c) => c.args[0] === "exec")?.args.at(-1) ?? "";
    expect(prompt).toContain("the goal");
    expect(prompt).toContain("the context");
    expect(prompt).toContain("the instructions");
    expect(prompt).toContain("禁止 git push / 任何远端写操作");
    expect(prompt).toContain("tests pass");
  });

  it("extracts the final agent message as summary and attaches report artifact", async () => {
    const result = await createCodexAdapter({ spawner: healthySpawner() }).execute(
      makeContractTaskSpec(),
      createContractRunHarness().ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("codex finished the task");
    expect(result.artifacts?.[0]).toMatchObject({ kind: "report" });
  });

  it("abort kills with SIGTERM then SIGKILL after grace and returns ok:false", async () => {
    const spawner = createScriptedSpawner({ hang: true, ignoreTerm: true });
    const plugin = createCodexAdapter({ spawner, killGraceMs: 20 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    harness.controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, summary: "aborted" });
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cancel(runId) aborts the in-flight run and is idempotent", async () => {
    const spawner = createScriptedSpawner({ hang: true });
    const plugin = createCodexAdapter({ spawner, killGraceMs: 20 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    await plugin.cancel(harness.ctx.runId);
    await plugin.cancel(harness.ctx.runId);
    await plugin.cancel("unknown-run");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("healthCheck: available", async () => {
    const health = await createCodexAdapter({ spawner: healthySpawner() }).healthCheck();
    expect(health.ok).toBe(true);
  });

  it("healthCheck: not installed", async () => {
    const health = await createCodexAdapter({
      spawner: createScriptedSpawner({ exitCode: 1 }),
    }).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("未安装");
  });

  it("healthCheck: not logged in", async () => {
    const spawner = createScriptedSpawner((command, args) => {
      if (command === "which") return { exitCode: 0 };
      if (args[0] === "login") return { exitCode: 1 };
      return {};
    });
    const health = await createCodexAdapter({ spawner }).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("未登录");
  });

  it("non-zero exit and spawn errors yield ok:false", async () => {
    const failing = await createCodexAdapter({
      spawner: createScriptedSpawner({ exitCode: 2 }),
    }).execute(makeContractTaskSpec(), createContractRunHarness().ctx);
    expect(failing.ok).toBe(false);
    expect(failing.summary).toContain("退出码");

    const missing = await createCodexAdapter({
      spawner: createScriptedSpawner({ spawnError: "spawn codex ENOENT" }),
    }).execute(makeContractTaskSpec(), createContractRunHarness().ctx);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain("启动失败");
  });

  it("reports stderr lines as low-density events", async () => {
    const harness = createContractRunHarness();
    await createCodexAdapter({
      spawner: createScriptedSpawner({ stderr: ["something warned"] }),
    }).execute(makeContractTaskSpec(), harness.ctx);
    expect(harness.events.some((e) => e.kind === "stderr")).toBe(true);
  });
});