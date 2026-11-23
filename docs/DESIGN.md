# ConductGun 核心设计草案 v0.1

> 状态：草案（pre-development）。本文档与 AGENTS.md「架构不变量」保持一致；修改本文档的接口/语义属于架构级变更，需走 ADR。

## 1. 概念模型

| 概念 | 定义 |
|------|------|
| **Command** | 用户的一条自然语言命令或结构化任务请求，Router 的输入；允许模糊/口语化，原文完整保留 |
| **Task** | 队列中的一等公民。由 Command 经 Router 预处理（澄清/规划/加工）拆解而来，含目标描述、验收标准、依赖、能力需求 |
| **TaskSpec** | Task 的执行指令形态：高密度、结构化、约束完备（见 5.2）。下游 agent 收到的唯一指令，不透传用户原文 |
| **CapabilityCard** | 插件的能力档案（借鉴 A2A AgentCard）：擅长领域、指令遵循/推理评级、成本档、并发上限、支持的传输方式 |
| **AgentPlugin** | 一个 CLI agent 的适配器插件，实现统一接口，注册 CapabilityCard |
| **Run** | Task 的一次执行实例（重试会产生多个 Run），含日志、事件流、产出 |
| **Artifact** | Run 的产出：diff/分支、文件、报告文本（借鉴 A2A artifact 概念） |
| **Router** | 唯一的指挥 agent：Command → Task DAG → 按能力档案指派 |

## 2. 任务生命周期

```
pending ──(依赖满足)──► queued ──(dispatcher 出队)──► assigned ──► running
                                                                    │
              ┌──────────────┬───────────────┬──────────────────────┤
              ▼              ▼               ▼                      ▼
          needs_review    failed          cancelled              (超时/心跳丢失)
              │              │                                        │
     (用户/审查agent)   (重试次数未耗尽 ──► queued)                      ▼
        ┌─────┴─────┐        │                                   requeue(租约回收)
        ▼           ▼        ▼
      done       rejected  exhausted(终态)
```

- 状态迁移全部落库（SQLite），任何进程崩溃后可从库恢复。
- `running` 的 Run 持有**租约（lease）**，worker 定期心跳续租；租约过期由 dispatcher 回收重排。
- `needs_review → done` 必须经过审查（MVP 由用户在 CLI 确认 diff；后期可加审查 agent）。
- **M0 已实现子集**（冻结契约 v1，落码 `packages/core/src/types.ts`）：状态仅 queued/running/done/failed/cancelled；无租约/心跳续租（heartbeat 为 no-op）、无重试/优先级/DAG，出队按 createdAt FIFO；`completeRun(ok:false)` → task failed；`recover()` 启动时把 running 重置 queued、旧 run 标 cancelled（幂等）。租约/重试/review 属 M3。

## 3. 队列与调度（packages/core）

- **存储**：SQLite（better-sqlite3），表：`tasks`、`runs`、`events`、`agents`（注册的卡片快照）。
- **出队规则**：依赖 DAG 就绪 → 优先级降序 → FIFO；受 per-agent 并发上限与全局并发上限约束。
- **指派**：Task 携带 `requiredCapabilities` 与可选 `preferredAgent`；dispatcher 只在能力匹配的插件中出队。Router 负责把"选谁"写进 Task，dispatcher 只做机械匹配（保证 core 无智能）。
- **重试**：指数退避，默认上限 2 次；`exhausted` 后上报 Router 决定改派其他 agent 或放弃。
- **事件**：所有状态迁移与 worker 输出摘要写入 `events` 表，CLI/Web 通过订阅事件渲染。

## 4. 插件契约（plugins/agent-*）

```ts
interface CapabilityCard {
  id: string;                    // "claude" | "codex" | "gemini" | "grok" | ...
  displayName: string;
  strengths: {
    instructionFollowing: 1|2|3|4|5;   // 指令遵循
    reasoning: 1|2|3|4|5;              // 逻辑推理
    speed: 1|2|3|4|5;
    costTier: "cheap" | "standard" | "premium";
    domains: string[];                 // ["refactor", "tests", "docs", "debug", ...]
  };
  maxConcurrency: number;
  transports: ("headless-cli" | "acp" | "a2a")[];
}

interface AgentPlugin {
  readonly card: CapabilityCard;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;   // CLI 是否安装/登录/API 可用
  execute(spec: TaskSpec, ctx: RunContext): Promise<RunResult>; // ctx 提供 worktree 路径、事件上报、心跳、取消信号
  cancel(runId: string): Promise<void>;
}
```

- 插件发现：MVP 用 workspace 内静态注册（`plugins/` 目录约定），后期支持外部 npm 包 / 配置声明。
- `execute` 内部自选传输：M1 用 headless CLI（`claude -p --output-format stream-json`、`codex exec --json`、`gemini -p` 等），M4 增加 ACP 通用适配器。
- **契约测试**：`agent-echo` mock 插件 + 一套插件契约测试套件，任何新插件必须通过。
- **M0 已实现**：契约套件经 `@conductgun/agent-echo/contract` 子路径导出——`runAgentContractTests(name, factory, opts?)`（失败注入经 `opts.createFailing` 工厂提供，未提供则 skip），另导出 `createContractRunHarness` / `makeContractTaskSpec` 供复用。abort 语义接受「返回 ok:false」或「抛出」两种实现；插件必须至少异步检查一次 ctx.signal（瞬时同步完成的实现需保留异步检查点）。
- **M1 已实现**：claude/codex/gemini 三个 headless 适配器（`plugins/agent-claude|codex|gemini`）+ 共享工具包 `plugins/agent-cli-utils`（可注入 Spawner、runHeadless：abort→SIGTERM→5s→SIGKILL、buildAgentPrompt 仅从 TaskSpec 结构化字段拼装、createRunRegistry 幂等 cancel）。最终命令行：codex `exec -C <workdir> -s workspace-write --skip-git-repo-check --json`；gemini `-p … --approval-mode yolo -o json --skip-trust`（worktree 未信任目录所需，PM 追认）；claude `-p … --output-format stream-json`（未安装，stub 验收，真实 flag 待校准）。healthCheck 只读零付费、不输出凭据内容。单测全部 stub spawn，零真实 CLI/网络/付费。

## 5. Router（packages/router）

Router 承担两个职责：**人机沟通翻译层**（把模糊的用户输入加工成清晰指令）与**指挥调度**（拆解、选人、监督）。前者是本项目的核心产品价值之一：用户不需要会写 prompt，理解成本由 Router 吸收。

### 5.1 预处理流水线（用户输入 → 清晰指令）

```
Command（低密度、模糊、口语化）
  │
  P0 理解：识别真实意图、隐含上下文、约束与验收期望
  │
  P1 澄清（按需，有预算）：仅当歧义会导致高代价错误时向用户追问；
  │   其余歧义用"透明默认假设"解决——假设写进 TaskSpec 并告知用户，可随时纠正
  │
  P2 加工：plan（拆解步骤/依赖）、搜索（查代码库/文档/网络补齐事实）、思考（方案权衡）
  │
  P3 生成 TaskSpec：每个任务一份高密度、结构化、约束完备的执行指令（见 5.2）
  │
  P4 路由：按能力档案选 agent，附选择理由，入队
```

**沟通原则（对用户端）：**
- Router 对齐人类说话方式：接受口语化、不完整、带情绪的表达；回复简洁、说人话，不向用户倾倒技术细节。
- 澄清预算：一条 Command 默认最多 1 轮追问（可配置）；能合理假设的不问，问的必须是"答错代价高"的分叉点。
- 信息密度解耦：高密度细节（文件路径、约束清单、验收标准）只存在于 TaskSpec 中给机器看；给用户的是低密度摘要（"我打算让 codex 做 X、gemini 做 Y，因为…，有两个假设：…"）。
- 用户原始输入完整保留在 Command 记录中，可追溯"从哪句话加工出了哪些任务"。

### 5.2 TaskSpec（下游 agent 收到的唯一指令形态）

```ts
interface TaskSpec {
  taskId: string;
  goal: string;                  // 一句话目标
  context: string;               // 加工后的必要背景（相关代码位置、事实、决策）
  instructions: string;          // 高密度执行指令：步骤、边界、禁止事项
  constraints: string[];         // 硬约束（不许改公共 API、不许加依赖…）
  acceptanceCriteria: string[];  // 可验证的验收标准（测试通过、行为断言…）
  assumptions: string[];         // P1 产生的透明默认假设
  requiredCapabilities: string[];
  preferredAgent?: string;
  artifacts: ("diff" | "report" | "files")[];
}
```

**不变量：执行 agent 永远不接收用户原始 prompt，只接收 TaskSpec。** 这保证下游指令质量与用户表达能力解耦。

### 5.3 指挥与监督

- Router 自身是一个 LLM agent，通过**受限工具集**操作核心：`enqueue_tasks`、`list_agents`（读能力档案）、`get_status`、`cancel_task`、`reassign`、`search`（P2 加工用）、`ask_user`（P1 澄清用）。它不能直接执行代码。
- 监督：失败/超时事件回流，Router 决定改派其他 agent、修订 TaskSpec 重做、或上报用户。
- **路由策略 = 规则兜底 + LLM 决策**：
  - 规则层：用户显式指定 > `preferredAgent` > 能力标签硬匹配 > 成本档约束。
  - LLM 层：在规则筛出的候选集内，结合任务语义与档案评级选择，并输出**选择理由**（落库，可解释）。
  - LLM 不可用时整体降级为纯规则路由（此时 P0–P3 加工能力受限，需明确告知用户），系统不瘫痪。
- 拆解粒度原则：一个 Task = 一个 agent 在一个 worktree 内可独立交付并审查的工作单元。
- Router 模型选型倾向"对齐人类沟通 + 规划能力强"的模型，与下游执行 agent 的选型标准（指令遵循/推理/成本）独立。

## 6. 工作区与 git 安全

- 每任务：`git worktree add .cg/worktrees/<task-id> -b cg/<agent>/<task-id>`。
- worker 环境拦截 push（git 协议层），只读主工作区。
- commit 署名带 agent 与 task 元信息（trailer：`CG-Agent: codex` / `CG-Task: t-xxxx`）。
- review 通过后由核心执行 merge（fast-forward 或 squash，可配置），随后清理 worktree。
- **M1 已实现子集**：core `WorktreeManager`（create 按 taskId 幂等——崩溃 recover 复用同一 worktree；分支 `cg/<agentId>/<taskId>`；baseCommit 记创建时 HEAD 作 diff 基线；handle 元数据存 worktree 目录外）。WorkerHost opts 可选 `worktrees`：启用时 ctx.workdir 为任务 worktree 绝对路径，ok 且 artifacts 含 diff 时宿主 `git add -A` + `git diff --cached <baseCommit>` 追加 diff artifact（已提交+未提交均覆盖）。**M1 不自动清理**（成功留审查/失败留排查），清理策略待定。禁 push 落地 = TaskSpec constraints 固定注入 + codex workspace-write 沙箱（gemini/claude 无同等沙箱，残留风险靠约束文本+验收核查）。已知发现：① codex 沙箱可写根不含 worktree 的 gitdir（在主仓库 .git/worktrees 下），agent 无法自行 commit——宿主 diff 捕获不受影响，M2/M3 评估增补可写根；② commit 署名 trailer 与协议层 push 拦截未实现（M3）；③ 下游 agent 可能越界改无关文件（冒烟曾现 codex 自改 AGENTS.md，约束文本「不要改动其他任何文件」验证有效）——显式文件范围约束属 M2 Router TaskSpec 议题。

## 7. CLI（packages/cli）

`cg` 命令与 headless daemon 通过本地 RPC（unix socket / localhost HTTP）通信；daemon 无头运行，队列状态全在 SQLite。命令集见 README「CLI 一瞥」。`cg daemon start|stop|status` 管理生命周期。

**M0 简化（已实现）**：无独立 daemon，CLI 进程内组合 TaskQueue + WorkerHost；已实现 `cg run / status / logs`（run 等待终态后退出，输出低密度摘要）。daemon RPC 选型（开放问题 5）留 M1+，届时 commands 层改为客户端调用，core 不动。

**M1 已实现**：`cg agents`（插件健康列表，不可用原因说人话）；`cg run --agent <id>`（preferredAgent 路由、constraints 注入禁 push 三禁令、artifacts 含 diff、真实 agent 默认 600s 超时）；`cg run --no-wait`（只入队）；`cg drain`（recover→全插件注册→WorkerHost 启用 worktree 隔离→等队列清空→逐任务摘要+worktree 路径+diff 指引，超时可再 drain 续消费）。默认无 --agent 的 run 保持 M0 行为（echo、不起 worktree）。daemon RPC 仍无（开放问题 5 继续留置）。

## 8. 开放问题（M0/M1 期间敲定，敲定后写 ADR 并更新本节）

1. Router 用哪家模型/CLI 实现？（候选：复用某个已接入 agent 的 headless 模式 vs 直接调 API）
2. 能力档案初始评级如何标定？是否需要一组基准任务做校准？
3. 非 git 目录的任务（纯问答/调研类）如何隔离与交付 artifact？
4. 任务间共享上下文（如架构决策）用什么机制：共享文件目录 vs 队列消息？
5. daemon RPC 选型：unix socket + JSON-RPC vs localhost HTTP + SSE？
6. 澄清策略的度：追问预算、"高代价歧义"的判定标准、默认假设的呈现方式（CLI 里如何低打扰地展示/纠正假设）？
7. TaskSpec 质量如何评估？是否需要一组"模糊输入 → 期望指令"的基准样例来回归测试 Router 的加工能力？