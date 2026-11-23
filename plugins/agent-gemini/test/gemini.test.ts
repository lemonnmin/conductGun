import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createContractRunHarness,
  makeContractTaskSpec,
  runAgentContractTests,
} from "@conductgun/agent-echo/contract";
import { createScriptedSpawner } from "@conductgun/agent-cli-utils/testing";
import { createGeminiAdapter } from "../src/index.js";

const homeWithCreds = mkdtempSync(join(tmpdir(), "cg-gemini-home-"));
mkdirSync(join(homeWithCreds, ".gemini"), { recursive: true });
writeFileSync(join(homeWithCreds, ".gemini", "oauth_creds.json"), "{}");
const emptyHome = mkdtempSync(join(tmpdir(), "cg-gemini-empty-"));
afterAll(() => {
  rmSync(homeWithCreds, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});

const geminiResponse = JSON.stringify({ response: "gemini finished the task" });

function healthySpawner() {
  return createScriptedSpawner((command) => {
    if (command === "which") return { exitCode: 0 };
    return { stdout: [geminiResponse] };
  });
}

runAgentContractTests(
  "gemini",
  () => createGeminiAdapter({ spawner: healthySpawner(), homeDir: homeWithCreds }),
  {
    createFailing: () => createGeminiAdapter({ spawner: createScriptedSpawner({ exitCode: 1 }) }),
  },
);

describe("gemini specifics", () => {
  it("exposes the frozen card", () => {
    expect(createGeminiAdapter().card).toEqual({
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
    });
  });

  it("uses headless yolo json command line, never -w/--worktree, cwd=ctx.workdir", async () => {
    const spawner = healthySpawner();
    const harness = createContractRunHarness();
    await createGeminiAdapter({ spawner }).execute(makeContractTaskSpec(), harness.ctx);
    const call = spawner.calls.find((c) => c.command === "gemini");
    expect(call?.cwd).toBe(harness.ctx.workdir);
    expect(call?.args).toEqual([
      "-p",
      expect.any(String),
      "--approval-mode",
      "yolo",
      "-o",
      "json",
      "--skip-trust",
    ]);
    expect(call?.args).not.toContain("-w");
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
    await createGeminiAdapter({ spawner }).execute(spec, createContractRunHarness().ctx);
    const prompt = spawner.calls.find((c) => c.command === "gemini")?.args[1] ?? "";
    expect(prompt).toContain("the goal");
    expect(prompt).toContain("the context");
    expect(prompt).toContain("the instructions");
    expect(prompt).toContain("禁止 git push / 任何远端写操作");
    expect(prompt).toContain("tests pass");
  });

  it("extracts response as summary and attaches report artifact", async () => {
    const result = await createGeminiAdapter({ spawner: healthySpawner() }).execute(
      makeContractTaskSpec(),
      createContractRunHarness().ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("gemini finished the task");
    expect(result.artifacts?.[0]).toMatchObject({ kind: "report" });
  });

  it("abort kills with SIGTERM then SIGKILL after grace and returns ok:false", async () => {
    const spawner = createScriptedSpawner({ hang: true, ignoreTerm: true });
    const plugin = createGeminiAdapter({ spawner, killGraceMs: 20 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    harness.controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, summary: "aborted" });
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cancel(runId) aborts the in-flight run and is idempotent", async () => {
    const spawner = createScriptedSpawner({ hang: true });
    const plugin = createGeminiAdapter({ spawner, killGraceMs: 20 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    await plugin.cancel(harness.ctx.runId);
    await plugin.cancel(harness.ctx.runId);
    await plugin.cancel("unknown-run");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(spawner.processes[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("healthCheck: available with OAuth credential file present", async () => {
    const health = await createGeminiAdapter({
      spawner: healthySpawner(),
      homeDir: homeWithCreds,
    }).healthCheck();
    expect(health.ok).toBe(true);
  });

  it("healthCheck: not installed", async () => {
    const health = await createGeminiAdapter({
      spawner: createScriptedSpawner({ exitCode: 1 }),
    }).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("未安装");
  });

  it("healthCheck: not logged in", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    try {
      const health = await createGeminiAdapter({
        spawner: healthySpawner(),
        homeDir: emptyHome,
      }).healthCheck();
      expect(health.ok).toBe(false);
      expect(health.detail).toContain("未登录");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("non-zero exit and spawn errors yield ok:false", async () => {
    const failing = await createGeminiAdapter({
      spawner: createScriptedSpawner({ exitCode: 2 }),
    }).execute(makeContractTaskSpec(), createContractRunHarness().ctx);
    expect(failing.ok).toBe(false);
    expect(failing.summary).toContain("退出码");

    const missing = await createGeminiAdapter({
      spawner: createScriptedSpawner({ spawnError: "spawn gemini ENOENT" }),
    }).execute(makeContractTaskSpec(), createContractRunHarness().ctx);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain("启动失败");
  });
});