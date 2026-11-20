import { describe, expect, it } from "vitest";
import { DEFAULT_DB_PATH, parseArgs } from "../src/args.js";

function ok(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.args;
}

function err(argv: string[]) {
  const result = parseArgs(argv);
  if (result.ok) throw new Error("expected error, got ok");
  return result.error;
}

describe("parseArgs", () => {
  it("解析 run 及默认 db 路径", () => {
    expect(ok(["run", "hello world"])).toEqual({
      command: "run",
      positional: "hello world",
      dbPath: DEFAULT_DB_PATH,
    });
  });

  it("解析 --db 覆盖（在命令前后均可）", () => {
    expect(ok(["run", "hi", "--db", "/tmp/q.sqlite"]).dbPath).toBe("/tmp/q.sqlite");
    expect(ok(["--db", "/tmp/q.sqlite", "status"]).dbPath).toBe("/tmp/q.sqlite");
  });

  it("解析 status 与 logs", () => {
    expect(ok(["status"])).toEqual({ command: "status", positional: null, dbPath: DEFAULT_DB_PATH });
    expect(ok(["logs", "t-abc123"]).positional).toBe("t-abc123");
  });

  it("无参数或 --help 进入 help", () => {
    expect(ok([]).command).toBe("help");
    expect(ok(["--help"]).command).toBe("help");
    expect(ok(["help"]).command).toBe("help");
  });

  it("run 缺少文本报错", () => {
    expect(err(["run"])).toContain("任务内容");
    expect(err(["run", "   "])).toContain("任务内容");
  });

  it("logs 缺少任务 id 报错", () => {
    expect(err(["logs"])).toContain("任务 id");
  });

  it("未知命令报错", () => {
    expect(err(["frobnicate"])).toContain("未知命令");
  });

  it("未知选项报错", () => {
    expect(err(["status", "--wat"])).toContain("未知选项");
  });

  it("--db 缺少值报错", () => {
    expect(err(["status", "--db"])).toContain("--db");
    expect(err(["status", "--db", "--help"])).toContain("--db");
  });

  it("多余位置参数报错", () => {
    expect(err(["run", "a", "b"])).toContain("只接受一个参数");
    expect(err(["status", "extra"])).toContain("额外参数");
  });
});