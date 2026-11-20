import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentPlugin, RunContext, TaskSpec } from "@conductgun/core";

export interface ContractRunHarness {
  ctx: RunContext;
  events: { kind: string; message: string }[];
  controller: AbortController;
  readonly heartbeats: number;
}

export function createContractRunHarness(): ContractRunHarness {
  const controller = new AbortController();
  const events: { kind: string; message: string }[] = [];
  let heartbeats = 0;
  const ctx: RunContext = {
    runId: `run-${randomUUID().slice(0, 8)}`,
    taskId: `t-contract-${randomUUID().slice(0, 8)}`,
    workdir: process.cwd(),
    signal: controller.signal,
    reportEvent(kind, message) {
      events.push({ kind, message });
    },
    heartbeat() {
      heartbeats += 1;
    },
  };
  return {
    ctx,
    events,
    controller,
    get heartbeats() {
      return heartbeats;
    },
  };
}

export function makeContractTaskSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId: `t-contract-${randomUUID().slice(0, 8)}`,
    goal: "contract probe",
    context: "",
    instructions: "echo this task back",
    constraints: [],
    acceptanceCriteria: [],
    assumptions: [],
    requiredCapabilities: [],
    artifacts: ["report"],
    ...overrides,
  };
}

export interface AgentContractOptions {
  /** Factory for a plugin instance whose next execute fails; omit if the plugin cannot inject failures. */
  createFailing?: () => AgentPlugin;
}

type Settled =
  | { threw: false; result: { ok: boolean; summary: string } }
  | { threw: true; error: unknown };

function settle(pending: Promise<{ ok: boolean; summary: string }>): Promise<Settled> {
  return pending.then(
    (result) => ({ threw: false as const, result }),
    (error: unknown) => ({ threw: true as const, error }),
  );
}

const RATINGS = [1, 2, 3, 4, 5];
const COST_TIERS = ["cheap", "standard", "premium"];
const TRANSPORTS = ["headless-cli", "acp", "a2a"];
const ARTIFACT_KINDS = ["diff", "report", "files"];

export function runAgentContractTests(
  name: string,
  factory: () => AgentPlugin,
  opts: AgentContractOptions = {},
): void {
  describe(`AgentPlugin contract: ${name}`, () => {
    it("exposes a valid CapabilityCard", () => {
      const { card } = factory();
      expect(typeof card.id).toBe("string");
      expect(card.id.length).toBeGreaterThan(0);
      expect(typeof card.displayName).toBe("string");
      expect(card.displayName.length).toBeGreaterThan(0);
      expect(RATINGS).toContain(card.strengths.instructionFollowing);
      expect(RATINGS).toContain(card.strengths.reasoning);
      expect(RATINGS).toContain(card.strengths.speed);
      expect(COST_TIERS).toContain(card.strengths.costTier);
      expect(Array.isArray(card.strengths.domains)).toBe(true);
      for (const domain of card.strengths.domains) {
        expect(typeof domain).toBe("string");
      }
      expect(Number.isInteger(card.maxConcurrency)).toBe(true);
      expect(card.maxConcurrency).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(card.transports)).toBe(true);
      expect(card.transports.length).toBeGreaterThan(0);
      for (const transport of card.transports) {
        expect(TRANSPORTS).toContain(transport);
      }
    });

    it("healthCheck resolves to { ok }", async () => {
      const health = await factory().healthCheck();
      expect(typeof health.ok).toBe("boolean");
      if (health.detail !== undefined) {
        expect(typeof health.detail).toBe("string");
      }
    });

    it("execute resolves to a valid RunResult and reports events", async () => {
      const plugin = factory();
      const harness = createContractRunHarness();
      const result = await plugin.execute(makeContractTaskSpec(), harness.ctx);
      expect(typeof result.ok).toBe("boolean");
      expect(typeof result.summary).toBe("string");
      expect(result.summary.length).toBeGreaterThan(0);
      if (result.artifacts !== undefined) {
        expect(Array.isArray(result.artifacts)).toBe(true);
        for (const artifact of result.artifacts) {
          expect(ARTIFACT_KINDS).toContain(artifact.kind);
        }
      }
      expect(harness.events.length).toBeGreaterThan(0);
      for (const event of harness.events) {
        expect(typeof event.kind).toBe("string");
        expect(typeof event.message).toBe("string");
      }
    });

    // Contract: after abort the run must settle promptly with ok:false or a rejection;
    // plugins must observe ctx.signal at least once asynchronously.
    it("responds to ctx.signal abort", async () => {
      const plugin = factory();
      const harness = createContractRunHarness();
      const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
      harness.controller.abort();
      const outcome = await settle(pending);
      if (!outcome.threw) {
        expect(outcome.result.ok).toBe(false);
      }
    });

    it("execute handles an already-aborted signal", async () => {
      const plugin = factory();
      const harness = createContractRunHarness();
      harness.controller.abort();
      const outcome = await settle(plugin.execute(makeContractTaskSpec(), harness.ctx));
      if (!outcome.threw) {
        expect(outcome.result.ok).toBe(false);
      }
    });

    it("cancel is idempotent and tolerates unknown runIds", async () => {
      const plugin = factory();
      await plugin.cancel("contract-unknown-run");
      await plugin.cancel("contract-unknown-run");

      const harness = createContractRunHarness();
      const pending = plugin.execute(makeContractTaskSpec(), harness.ctx);
      await plugin.cancel(harness.ctx.runId);
      await plugin.cancel(harness.ctx.runId);
      await settle(pending);
    });

    if (opts.createFailing) {
      const createFailing = opts.createFailing;
      it("failure injection yields ok:false", async () => {
        const plugin = createFailing();
        const result = await plugin.execute(
          makeContractTaskSpec(),
          createContractRunHarness().ctx,
        );
        expect(result.ok).toBe(false);
        expect(typeof result.summary).toBe("string");
      });
    } else {
      it.skip("failure injection yields ok:false (no createFailing factory provided)");
    }
  });
}