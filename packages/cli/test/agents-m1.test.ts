import { describe, expect, it } from "vitest";
import type { AgentPlugin, CapabilityCard } from "@conductgun/core";
import { agentsCommand } from "../src/agents.js";
import type { CommandIo } from "../src/commands.js";

function collector(): { io: CommandIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { print: (line) => lines.push(line) }, lines };
}

function stubPlugin(id: string, health: "ok" | "unavailable" | "throw"): AgentPlugin {
  const card: CapabilityCard = {
    id,
    displayName: `Stub ${id}`,
    strengths: { instructionFollowing: 3, reasoning: 3, speed: 3, costTier: "cheap", domains: ["coding"] },
    maxConcurrency: 1,
    transports: ["headless-cli"],
  };
  return {
    card,
    async healthCheck() {
      if (health === "throw") throw new Error("探测炸了");
      if (health === "unavailable") return { ok: false, detail: `${id} CLI 未安装` };
      return { ok: true };
    },
    async execute() {
      return { ok: true, summary: "noop" };
    },
    async cancel() {},
  };
}

describe("cg agents（stub，零真实 CLI）", () => {
  it("一行一个：id + 健康状态 + 不可用原因", async () => {
    const { io, lines } = collector();
    const exit = await agentsCommand(io, [
      stubPlugin("codex", "ok"),
      stubPlugin("claude", "unavailable"),
    ]);
    expect(exit).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("codex");
    expect(lines[0]).toContain("ok");
    expect(lines[1]).toContain("不可用");
    expect(lines[1]).toContain("claude CLI 未安装");
  });

  it("healthCheck 抛错不中断列表，降级为不可用", async () => {
    const { io, lines } = collector();
    const exit = await agentsCommand(io, [stubPlugin("gemini", "throw"), stubPlugin("codex", "ok")]);
    expect(exit).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("不可用");
    expect(lines[0]).toContain("探测炸了");
    expect(lines[1]).toContain("ok");
  });
});