import { describe, expect, it } from "vitest";
import { buildTaskSpec, M0_SCAFFOLD_ASSUMPTION } from "../src/spec.js";

describe("buildTaskSpec", () => {
  const spec = buildTaskSpec("t-test01", "帮我打个招呼");

  it("用户原文进入 goal 与 instructions（M0 脚手架例外）", () => {
    expect(spec.goal).toBe("帮我打个招呼");
    expect(spec.instructions).toBe("帮我打个招呼");
  });

  it("assumptions 注明 Router 未实现", () => {
    expect(spec.assumptions).toEqual([M0_SCAFFOLD_ASSUMPTION]);
    expect(spec.assumptions[0]).toContain("Router 未实现");
  });

  it("M0 固定路由到 echo，产物为 report", () => {
    expect(spec.taskId).toBe("t-test01");
    expect(spec.requiredCapabilities).toEqual(["echo"]);
    expect(spec.preferredAgent).toBe("echo");
    expect(spec.artifacts).toEqual(["report"]);
  });

  it("其余字段为空默认值", () => {
    expect(spec.context).toBe("");
    expect(spec.constraints).toEqual([]);
    expect(spec.acceptanceCriteria).toEqual([]);
  });
});