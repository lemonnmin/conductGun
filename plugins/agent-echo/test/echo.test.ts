import { describe, expect, it } from "vitest";
import {
  createContractRunHarness,
  makeContractTaskSpec,
  runAgentContractTests,
} from "../src/contract.js";
import { createEchoPlugin, echoPlugin } from "../src/index.js";

runAgentContractTests("echo", () => createEchoPlugin(), {
  createFailing: () => createEchoPlugin({ failNext: 1 }),
});

describe("echo specifics", () => {
  it("default instance exposes the frozen echo card", () => {
    expect(echoPlugin.card).toEqual({
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
    });
  });

  it("summary echoes goal and instructions", async () => {
    const spec = makeContractTaskSpec({
      goal: "say hello",
      instructions: "reply with the goal verbatim",
    });
    const result = await echoPlugin.execute(spec, createContractRunHarness().ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("say hello");
    expect(result.summary).toContain("reply with the goal verbatim");
  });

  it("reports start/echo/done events in order", async () => {
    const harness = createContractRunHarness();
    await createEchoPlugin().execute(makeContractTaskSpec(), harness.ctx);
    expect(harness.events.map((e) => e.kind)).toEqual(["start", "echo", "done"]);
  });

  it("abort via ctx.signal resolves ok:false (echo's chosen abort semantics)", async () => {
    const plugin = createEchoPlugin({ delayMs: 50 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    harness.controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(harness.events.some((e) => e.kind === "aborted")).toBe(true);
  });

  it("cancel(runId) aborts the in-flight run and stays idempotent", async () => {
    const plugin = createEchoPlugin({ delayMs: 50 });
    const harness = createContractRunHarness();
    const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
    await plugin.cancel(harness.ctx.runId);
    await plugin.cancel(harness.ctx.runId);
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it("failNext fails exactly the first N executes", async () => {
    const plugin = createEchoPlugin({ failNext: 2 });
    const spec = makeContractTaskSpec();
    const first = await plugin.execute(spec, createContractRunHarness().ctx);
    const second = await plugin.execute(spec, createContractRunHarness().ctx);
    const third = await plugin.execute(spec, createContractRunHarness().ctx);
    expect(first).toEqual({ ok: false, summary: "injected failure" });
    expect(second).toEqual({ ok: false, summary: "injected failure" });
    expect(third.ok).toBe(true);
  });

  it("instances do not share failure counters or run state", async () => {
    const failing = createEchoPlugin({ failNext: 1 });
    const healthy = createEchoPlugin();
    const spec = makeContractTaskSpec();
    expect((await failing.execute(spec, createContractRunHarness().ctx)).ok).toBe(false);
    expect((await healthy.execute(spec, createContractRunHarness().ctx)).ok).toBe(true);
  });
});