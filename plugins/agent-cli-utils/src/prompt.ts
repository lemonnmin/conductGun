import type { TaskSpec } from "@conductgun/core";

export function buildAgentPrompt(spec: TaskSpec): string {
  const sections: string[] = [`# Task\nGoal: ${spec.goal}`];
  if (spec.context.length > 0) {
    sections.push(`## Context\n${spec.context}`);
  }
  sections.push(`## Instructions\n${spec.instructions}`);
  if (spec.constraints.length > 0) {
    sections.push(`## Constraints (must obey)\n${spec.constraints.map((c) => `- ${c}`).join("\n")}`);
  }
  if (spec.acceptanceCriteria.length > 0) {
    sections.push(
      `## Acceptance criteria\n${spec.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (spec.assumptions.length > 0) {
    sections.push(`## Assumptions\n${spec.assumptions.map((a) => `- ${a}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

export function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function parseJsonLines(stdout: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // non-JSON output lines are expected noise from CLIs
    }
  }
  return parsed;
}