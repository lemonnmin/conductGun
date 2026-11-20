import { randomUUID } from "node:crypto";

export function newTaskId(): string {
  return `t-${randomUUID().slice(0, 8)}`;
}

export function newRunId(): string {
  return `r-${randomUUID().slice(0, 8)}`;
}