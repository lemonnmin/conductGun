import type { TaskSpec } from "@conductgun/core";

export const M0_SCAFFOLD_ASSUMPTION =
  "M0: Router 未实现，用户原文直接作为 goal/instructions";

export const M1_SCAFFOLD_ASSUMPTION =
  "M1: Router 未实现，用户原文直接作为 goal/instructions";

// 任务书 §3.4：禁 push 的约束文本注入（codex 另有 workspace-write 沙箱兜底）
export const M1_CONSTRAINTS = [
  "禁止 git push / 任何远端写操作",
  "禁止触碰主工作区",
  "只在当前工作目录内改动",
];

export function buildTaskSpec(taskId: string, text: string, agent?: string): TaskSpec {
  if (agent === undefined) {
    return {
      taskId,
      goal: text,
      context: "",
      instructions: text,
      constraints: [],
      acceptanceCriteria: [],
      assumptions: [M0_SCAFFOLD_ASSUMPTION],
      requiredCapabilities: ["echo"],
      preferredAgent: "echo",
      artifacts: ["report"],
    };
  }
  return {
    taskId,
    goal: text,
    context: "",
    instructions: text,
    constraints: [...M1_CONSTRAINTS],
    acceptanceCriteria: [],
    assumptions: [M1_SCAFFOLD_ASSUMPTION],
    requiredCapabilities: [],
    preferredAgent: agent,
    artifacts: ["report", "diff"],
  };
}