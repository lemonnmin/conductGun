export const CORE_PACKAGE = "@conductgun/core";

export type {
  TaskStatus,
  TaskSpec,
  CapabilityCard,
  RunContext,
  RunResult,
  AgentPlugin,
  TaskRecord,
  TaskEvent,
} from "./types.js";
export { newTaskId } from "./ids.js";
export { TaskQueue } from "./queue.js";
export { WorkerHost } from "./worker-host.js";
export { WorktreeManager, type WorktreeHandle } from "./worktree.js";