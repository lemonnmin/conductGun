import { describe, expect, it } from "vitest";
import { buildTaskSpec, M1_CONSTRAINTS, M1_SCAFFOLD_ASSUMPTION } from "../src/spec.js";

describe("buildTaskSpec M1（--agent 路径）", () => {
  const spec = buildTaskSpec("t-m1x01", "创建一份文档", "codex");

  it("preferredAgent 路由到指定 agent，requiredCapabilities 为空", () => {
    expect(spec.preferredAgent).toBe("codex");
    expect(spec.requiredCapabilities).toEqual([]);
  });

  it("artifacts 含 diff", () => {
    expect(spec.artifacts).toContain("diff");
  });

  it("constraints 固定注入 §3.4 三条禁令", () => {
    expect(spec.constraints).toEqual(M1_CONSTRAINTS);
    expect(spec.constraints).toHaveLength(3);
    expect(spec.constraints[0]).toContain("push");
    expect(spec.constraints[1]).toContain("主工作区");
    expect(spec.constraints[2]).toContain("当前工作目录");
  });

  it("assumptions 注明 M1 直填例外", () => {
    expect(spec.assumptions).toEqual([M1_SCAFFOLD_ASSUMPTION]);
    expect(spec.assumptions[0]).toContain("M1");
    expect(spec.assumptions[0]).toContain("Router 未实现");
  });

  it("goal/instructions 仍为用户原文（直填例外）", () => {
    expect(spec.goal).toBe("创建一份文档");
    expect(spec.instructions).toBe("创建一份文档");
  });

  it("constraints 数组不共享引用（注入不可被外部篡改）", () => {
    const a = buildTaskSpec("t-a", "x", "codex");
    a.constraints.push("evil");
    expect(buildTaskSpec("t-b", "y", "gemini").constraints).toHaveLength(3);
  });
});