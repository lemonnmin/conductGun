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

describe("parseArgs M1 增量", () => {
  it("run --agent 解析", () => {
    const args = ok(["run", "--agent", "codex", "做点事"]);
    expect(args.command).toBe("run");
    expect(args.agent).toBe("codex");
    expect(args.positional).toBe("做点事");
  });

  it("run --no-wait 解析", () => {
    expect(ok(["run", "hi", "--no-wait"]).noWait).toBe(true);
  });

  it("run --timeout 解析（正整数秒）", () => {
    expect(ok(["run", "hi", "--timeout", "900"]).timeoutSec).toBe(900);
    expect(err(["run", "hi", "--timeout", "abc"])).toContain("--timeout");
    expect(err(["run", "hi", "--timeout", "0"])).toContain("--timeout");
    expect(err(["run", "hi", "--timeout"])).toContain("--timeout");
  });

  it("--agent 缺值报错", () => {
    expect(err(["run", "hi", "--agent"])).toContain("--agent");
    expect(err(["run", "hi", "--agent", "--no-wait"])).toContain("--agent");
  });

  it("drain 命令与 --timeout", () => {
    expect(ok(["drain"])).toEqual({ command: "drain", positional: null, dbPath: DEFAULT_DB_PATH });
    expect(ok(["drain", "--timeout", "900"]).timeoutSec).toBe(900);
    expect(ok(["--db", "/tmp/q.sqlite", "drain"]).dbPath).toBe("/tmp/q.sqlite");
  });

  it("agents 命令", () => {
    expect(ok(["agents"])).toEqual({ command: "agents", positional: null, dbPath: DEFAULT_DB_PATH });
  });

  it("flag 与命令的合法性约束", () => {
    expect(err(["status", "--no-wait"])).toContain("不支持");
    expect(err(["agents", "--agent", "codex"])).toContain("不支持");
    expect(err(["logs", "t-x", "--timeout", "5"])).toContain("不支持");
    expect(err(["drain", "--no-wait"])).toContain("不支持");
    expect(err(["drain", "extra"])).toContain("额外参数");
  });

  it("M0 形态不带新字段（向后兼容）", () => {
    expect(ok(["run", "hello"])).toEqual({ command: "run", positional: "hello", dbPath: DEFAULT_DB_PATH });
    expect(ok(["status"])).toEqual({ command: "status", positional: null, dbPath: DEFAULT_DB_PATH });
  });
});