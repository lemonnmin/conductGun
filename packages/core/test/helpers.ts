import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTaskId } from "../src/index";
import type { AgentPlugin, CapabilityCard, RunResult, TaskSpec } from "../src/index";

export function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId: newTaskId(),
    goal: "test goal",
    context: "",
    instructions: "do the thing",
    constraints: [],
    acceptanceCriteria: [],
    assumptions: [],
    requiredCapabilities: [],
    artifacts: ["report"],
    ...overrides,
  };
}

export function makeCard(id: string, overrides: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    id,
    displayName: `Stub ${id}`,
    strengths: {
      instructionFollowing: 3,
      reasoning: 3,
      speed: 5,
      costTier: "cheap",
      domains: ["tests", "mock"],
    },
    maxConcurrency: 1,
    transports: ["headless-cli"],
    ...overrides,
  };
}

export function makeTempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cg-core-test-"));
  return { dir, dbPath: join(dir, "nested", "queue.sqlite") };
}

export function stubPlugin(
  card: CapabilityCard,
  execute: AgentPlugin["execute"],
): AgentPlugin {
  return {
    card,
    healthCheck: async () => ({ ok: true }),
    execute,
    cancel: async () => {},
  };
}

export function okResult(summary = "ok"): RunResult {
  return { ok: true, summary };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}