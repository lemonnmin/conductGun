import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { newRunId } from "./ids.js";
import type {
  CapabilityCard,
  RunResult,
  TaskEvent,
  TaskRecord,
  TaskSpec,
  TaskStatus,
} from "./types.js";

interface TaskRow {
  id: string;
  spec: string;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  task_id: string;
  agent_id: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  result: string | null;
  error: string | null;
}

interface EventRow {
  seq: number;
  task_id: string;
  run_id: string | null;
  ts: number;
  kind: string;
  message: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  result TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_id TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  card TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
`;

// WorkerHost 需要向 events 表写插件上报事件，但冻结契约的 TaskQueue 公开面
// 没有事件写入方法；用模块内 WeakMap 提供包内通道，保持公开签名与契约一致。
const queueDbs = new WeakMap<TaskQueue, Database.Database>();

function insertEvent(db: Database.Database, event: TaskEvent): void {
  db.prepare(
    "INSERT INTO events (task_id, run_id, ts, kind, message) VALUES (?, ?, ?, ?, ?)",
  ).run(event.taskId, event.runId ?? null, event.ts, event.kind, event.message);
}

/** @internal 包内使用，不从 index.ts 导出 */
export function appendEventInternal(queue: TaskQueue, event: TaskEvent): void {
  const db = queueDbs.get(queue);
  if (!db) throw new Error("TaskQueue is closed");
  insertEvent(db, event);
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as TaskSpec,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: EventRow): TaskEvent {
  return {
    taskId: row.task_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ts: row.ts,
    kind: row.kind,
    message: row.message,
  };
}

function matches(spec: TaskSpec, agentId: string, card: CapabilityCard): boolean {
  if (spec.preferredAgent !== undefined) return spec.preferredAgent === agentId;
  return spec.requiredCapabilities.every((cap) => card.strengths.domains.includes(cap));
}

export class TaskQueue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    queueDbs.set(this, this.db);
  }

  registerAgent(card: CapabilityCard): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, card, registered_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET card = excluded.card, registered_at = excluded.registered_at`,
      )
      .run(card.id, JSON.stringify(card), Date.now());
  }

  enqueue(spec: TaskSpec): TaskRecord {
    const now = Date.now();
    const record: TaskRecord = {
      id: spec.taskId,
      spec,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO tasks (id, spec, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(record.id, JSON.stringify(spec), record.status, now, now);
      insertEvent(this.db, {
        taskId: record.id,
        ts: now,
        kind: "enqueued",
        message: spec.goal,
      });
    })();
    return record;
  }

  claimNext(agentId: string): { task: TaskRecord; runId: string } | null {
    return this.db.transaction((): { task: TaskRecord; runId: string } | null => {
      const agentRow = this.db
        .prepare("SELECT card FROM agents WHERE id = ?")
        .get(agentId) as { card: string } | undefined;
      if (!agentRow) return null;
      const card = JSON.parse(agentRow.card) as CapabilityCard;

      const rows = this.db
        .prepare(
          "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC",
        )
        .all() as TaskRow[];
      for (const row of rows) {
        const spec = JSON.parse(row.spec) as TaskSpec;
        if (!matches(spec, agentId, card)) continue;

        const now = Date.now();
        const runId = newRunId();
        this.db
          .prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.db
          .prepare(
            "INSERT INTO runs (id, task_id, agent_id, status, started_at) VALUES (?, ?, ?, 'running', ?)",
          )
          .run(runId, row.id, agentId, now);
        insertEvent(this.db, {
          taskId: row.id,
          runId,
          ts: now,
          kind: "claimed",
          message: `claimed by ${agentId}`,
        });
        return { task: { ...rowToTask(row), status: "running", updatedAt: now }, runId };
      }
      return null;
    })();
  }

  completeRun(runId: string, result: RunResult): void {
    this.db.transaction(() => {
      const run = this.requireRunningRun(runId);
      const now = Date.now();
      const status: TaskStatus = result.ok ? "done" : "failed";
      this.db
        .prepare("UPDATE runs SET status = ?, ended_at = ?, result = ? WHERE id = ?")
        .run(status, now, JSON.stringify(result), runId);
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, run.task_id);
      insertEvent(this.db, {
        taskId: run.task_id,
        runId,
        ts: now,
        kind: status,
        message: result.summary,
      });
    })();
  }

  failRun(runId: string, error: string): void {
    this.db.transaction(() => {
      const run = this.requireRunningRun(runId);
      const now = Date.now();
      this.db
        .prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?")
        .run(now, error, runId);
      this.db
        .prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(now, run.task_id);
      insertEvent(this.db, {
        taskId: run.task_id,
        runId,
        ts: now,
        kind: "failed",
        message: error,
      });
    })();
  }

  cancelRun(runId: string): void {
    this.db.transaction(() => {
      const run = this.requireRunningRun(runId);
      const now = Date.now();
      this.db
        .prepare("UPDATE runs SET status = 'cancelled', ended_at = ? WHERE id = ?")
        .run(now, runId);
      this.db
        .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now, run.task_id);
      insertEvent(this.db, {
        taskId: run.task_id,
        runId,
        ts: now,
        kind: "cancelled",
        message: "run cancelled",
      });
    })();
  }

  recover(): number {
    return this.db.transaction((): number => {
      const rows = this.db
        .prepare("SELECT id FROM tasks WHERE status = 'running'")
        .all() as { id: string }[];
      const now = Date.now();
      for (const row of rows) {
        this.db
          .prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.db
          .prepare(
            "UPDATE runs SET status = 'cancelled', ended_at = ?, error = 'interrupted: recovered after restart' WHERE task_id = ? AND status = 'running'",
          )
          .run(now, row.id);
        insertEvent(this.db, {
          taskId: row.id,
          ts: now,
          kind: "recovered",
          message: "running task reset to queued after restart",
        });
      }
      return rows.length;
    })();
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC")
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC")
      .all(taskId) as EventRow[];
    return rows.map(rowToEvent);
  }

  close(): void {
    queueDbs.delete(this);
    this.db.close();
  }

  private requireRunningRun(runId: string): RunRow {
    const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.status !== "running") {
      throw new Error(`run ${runId} is not running (status: ${run.status})`);
    }
    return run;
  }
}