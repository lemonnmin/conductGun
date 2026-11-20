export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TaskSpec {
  taskId: string;
  goal: string;
  context: string;
  instructions: string;
  constraints: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  requiredCapabilities: string[];
  preferredAgent?: string;
  artifacts: ("diff" | "report" | "files")[];
}

export interface CapabilityCard {
  id: string;
  displayName: string;
  strengths: {
    instructionFollowing: 1 | 2 | 3 | 4 | 5;
    reasoning: 1 | 2 | 3 | 4 | 5;
    speed: 1 | 2 | 3 | 4 | 5;
    costTier: "cheap" | "standard" | "premium";
    domains: string[];
  };
  maxConcurrency: number;
  transports: ("headless-cli" | "acp" | "a2a")[];
}

export interface RunContext {
  runId: string;
  taskId: string;
  workdir: string;
  signal: AbortSignal;
  reportEvent(kind: string, message: string): void;
  heartbeat(): void;
}

export interface RunResult {
  ok: boolean;
  summary: string;
  artifacts?: { kind: "diff" | "report" | "files"; path?: string; content?: string }[];
}

export interface AgentPlugin {
  readonly card: CapabilityCard;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
}

export interface TaskRecord {
  id: string;
  spec: TaskSpec;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  taskId: string;
  runId?: string;
  ts: number;
  kind: string;
  message: string;
}