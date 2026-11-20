import { describe, expect, it } from "vitest";
import type { TaskEvent, TaskRecord } from "@conductgun/core";
import { formatEventLine, formatRunOutcome, formatTaskLine, truncate } from "../src/format.js";
import { buildTaskSpec } from "../src/spec.js";

function makeRecord(status: TaskRecord["status"], goal = "hello"): TaskRecord {
  return { id: "t-abc123", spec: buildTaskSpec("t-abc123", goal), status, createdAt: 0, updatedAt: 0 };
}

function makeEvent(kind: string, message: string): TaskEvent {
  return { taskId: "t-abc123", ts: Date.UTC(2026, 10, 21, 8, 30, 5), kind, message };
}

describe("truncate", () => {
  it("短文本原样保留", () => {
    expect(truncate("hello", 60)).toBe("hello");
  });

  it("长文本截断并加省略号", () => {
    const result = truncate("x".repeat(100), 60);
    expect(result.length).toBe(60);
    expect(result.endsWith("…")).toBe(true);
  });

  it("多行折叠为单行", () => {
    expect(truncate("a\n  b\t c", 60)).toBe("a b c");
  });
});

describe("formatTaskLine", () => {
  it("包含 id、status、goal", () => {
    const line = formatTaskLine(makeRecord("done"));
    expect(line).toContain("t-abc123");
    expect(line).toContain("done");
    expect(line).toContain("hello");
  });

  it("goal 过长时截断", () => {
    const line = formatTaskLine(makeRecord("queued", "长".repeat(100)));
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(100);
  });
});

describe("formatEventLine", () => {
  it("包含时间、kind、message", () => {
    const line = formatEventLine(makeEvent("echo", "回显内容"));
    expect(line).toContain("2026-11-21 08:30:05");
    expect(line).toContain("[echo]");
    expect(line).toContain("回显内容");
  });
});

describe("formatRunOutcome", () => {
  it("成功：一行摘要，取最后一条事件消息", () => {
    const line = formatRunOutcome(makeRecord("done"), [
      makeEvent("start", "开始"),
      makeEvent("done", "echo: hello"),
    ]);
    expect(line).toBe("完成 t-abc123：echo: hello");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("失败：提示失败并带原因", () => {
    const line = formatRunOutcome(makeRecord("failed"), [makeEvent("failed", "injected failure")]);
    expect(line).toContain("失败");
    expect(line).toContain("injected failure");
  });

  it("无事件时有兜底文案", () => {
    expect(formatRunOutcome(makeRecord("done"), [])).toContain("hello");
    expect(formatRunOutcome(makeRecord("failed"), [])).toContain("失败");
  });

  it("取消状态如实展示", () => {
    expect(formatRunOutcome(makeRecord("cancelled"), [])).toContain("已取消");
  });
});