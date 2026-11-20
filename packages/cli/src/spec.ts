import type { TaskSpec } from "@conductgun/core";

export const M0_SCAFFOLD_ASSUMPTION =
  "M0: Router 未实现，用户原文直接作为 goal/instructions";

export function buildTaskSpec(taskId: string, text: string): TaskSpec {
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