import type { TaskEvent, TaskRecord } from "@conductgun/core";

const GOAL_MAX = 60;

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export function formatTaskLine(task: TaskRecord): string {
  return `${task.id}  ${task.status.padEnd(9)}  ${truncate(task.spec.goal, GOAL_MAX)}`;
}

export function formatEventLine(event: TaskEvent): string {
  const time = new Date(event.ts).toISOString().replace("T", " ").slice(0, 19);
  return `${time}  [${event.kind}]  ${event.message}`;
}

export function formatRunOutcome(task: TaskRecord, events: TaskEvent[]): string {
  const lastMessage = events[events.length - 1]?.message;
  switch (task.status) {
    case "done":
      return `完成 ${task.id}：${lastMessage ?? task.spec.goal}`;
    case "failed":
      return `失败 ${task.id}：${lastMessage ?? "未知错误，可用 cg logs 查看详情"}`;
    case "cancelled":
      return `已取消 ${task.id}`;
    default:
      return `任务 ${task.id} 状态异常（${task.status}），可用 cg logs ${task.id} 查看详情`;
  }
}