import { describe, expect, it } from "vitest";
import type { CapabilityCard, TaskRecord } from "@conductgun/core";
import { formatAgentLine, formatDrainSummary } from "../src/format.js";
import { buildTaskSpec } from "../src/spec.js";

function card(id: string, displayName: string): CapabilityCard {
  return {
    id,
    displayName,
    strengths: { instructionFollowing: 4, reasoning: 4, speed: 4, costTier: "standard", domains: ["coding"] },
    maxConcurrency: 2,
    transports: ["headless-cli"],
  };
}

function record(status: TaskRecord["status"]): TaskRecord {
  return { id: "t-x", spec: buildTaskSpec("t-x", "g"), status, createdAt: 0, updatedAt: 0 };
}

describe("formatAgentLine", () => {
  it("健康：一行 id + ok + displayName", () => {
    const line = formatAgentLine(card("codex", "Codex CLI"), { ok: true });
    expect(line).toContain("codex");
    expect(line).toContain("ok");
    expect(line).toContain("Codex CLI");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("不可用：带说人话的原因", () => {
    const line = formatAgentLine(card("claude", "Claude Code"), { ok: false, detail: "claude CLI 未安装" });
    expect(line).toContain("不可用");
    expect(line).toContain("claude CLI 未安装");
  });
});

describe("formatDrainSummary", () => {
  it("N done / M failed 一行总结", () => {
    const line = formatDrainSummary([record("done"), record("done"), record("failed")]);
    expect(line).toBe("drain 结束：2 done / 1 failed");
  });

  it("全成功", () => {
    expect(formatDrainSummary([record("done")])).toBe("drain 结束：1 done / 0 failed");
  });

  it("含 cancelled/未完成时如实追加", () => {
    const line = formatDrainSummary([record("done"), record("cancelled"), record("queued")]);
    expect(line).toContain("1 cancelled");
    expect(line).toContain("1 未完成");
  });
});