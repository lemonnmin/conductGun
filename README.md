# ConductGun（指挥枪）

> 一个 Agent 指挥一群 Agent 干活。本地优先的异构 CLI Agent 编排器。

ConductGun 是一个类似 A2A（Agent2Agent）思路的多智能体编排系统：你只对一个 **Router Agent** 下命令，它负责理解意图、拆解任务、评估每个执行 Agent 的长处，把任务派发进一个**持久化任务队列**，由插件化的 Agent 适配器（Claude Code、Codex、Gemini CLI、Grok CLI 等）并行执行，最后汇总结果供你审查。

## 为什么做这个项目

不同的 coding agent 各有所长：

| 特长维度 | 说明 |
|---------|------|
| 指令遵循 | 有的 agent 严格按指令办事，适合边界清晰的机械性任务 |
| 逻辑推理 | 有的 agent 推理能力强，适合架构设计、复杂调试 |
| 速度 / 成本 | 有的快而便宜，适合批量小任务；有的慢而贵，留给硬骨头 |
| 上下文 / 生态 | 有的长于大上下文阅读，有的长于特定语言或工具链 |

现有工具要么只编排单一 agent 的多个实例，要么让用户手动指定"谁干什么"。ConductGun 的核心主张是：**把"谁擅长什么"建模成能力档案（Capability Card），让 Router 按需自动匹配**，取每个 agent 的长处加以利用。

### 另一个同等重要的目的：Router 是人机沟通的翻译层

大多数现有编排器把用户的原始 prompt 直接透传给执行 agent——这要求用户自己会写清晰、约束完备的指令。但现实中：

- 很多人（包括本项目作者）不擅长给 agent 下命令：意图模糊、约束缺失、上下文隐含。
- 面向机器的高信息密度指令，反过来会压垮人：用户为了"喂好" agent 被迫学习 prompt 技巧，理解成本和沟通压力剧增，效率不升反降。

ConductGun 的解法是**把"对齐人类说话方式"和"对齐机器执行方式"解耦到两端**：

```
用户 ──低密度/模糊/口语化──► Router ──高密度/结构化/约束完备──► 执行 agent
        （人怎么舒服怎么说）    │澄清 · 规划 · 搜索加工 · 思考      （机器要什么给什么）
                              │
                              └─ 理解成本由 Router 吸收，用户无需学 prompt 工程
```

- **对用户**：Router 是一个对齐人类沟通方式的 AI——听得懂模糊表达，必要时才追问，默认假设透明化，大幅减轻沟通压力。
- **对下游**：Router 先做 plan / 搜索 / 思考加工，把原始输入提炼成目标明确、边界清晰、带验收标准的结构化指令再下达。执行 agent 收到的永远是"好 prompt"，与用户会不会写 prompt 无关。

## 核心架构

```
 用户 (CLI，未来 Web)
   │  自然语言命令 / 结构化任务
   ▼
┌────────────────┐
│  Router Agent  │  澄清意图 → 规划/搜索加工 → 拆解任务(DAG) → 生成清晰指令 → 按能力档案选择 agent
└───────┬────────┘
        ▼
┌────────────────┐
│   Task Queue   │  持久化(SQLite) · 优先级 · 依赖 · 重试 · 并发控制
└───────┬────────┘
        ▼
┌────────────────┐
│   Dispatcher   │  租约/心跳 · 按 agent 并发上限出队 · 失败重排
└───────┬────────┘
        ▼
┌──────────────────────────────────────────────┐
│              Plugin Host（插件宿主）           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────┐ │
│  │ claude  │ │  codex  │ │ gemini  │ │grok │ │  … 每个 agent 一个插件
│  └────┬────┘ └────┬────┘ └────┬────┘ └──┬──┘ │
└───────┼───────────┼───────────┼─────────┼────┘
        ▼           ▼           ▼         ▼
   独立 git worktree 中执行，互不干扰，产出 diff/artifact
        │
        ▼
   结果回收 → 审查(review) → 合并(merge) / 打回重做
```

三条设计主线：

1. **队列为核心**：一切任务先进队列再执行。队列持久化、可恢复、可观测，Router 和 Worker 都只通过队列交互，天然解耦。
2. **插件式 Agent 接入**：每个 agent 是一个实现统一 `AgentPlugin` 接口的插件，附带能力档案。新增一个 agent = 新增一个插件，核心零改动。
3. **Router 预处理，下游不透传**：用户原始输入永远不直接到达执行 agent；Router 负责澄清、规划、加工，下游只接收结构化任务指令（TaskSpec）。
4. **能力感知路由**：Router 依据能力档案 + 路由策略（规则兜底、LLM 决策）分配任务，而不是轮询或随机。

## 技术选型

- **语言/运行时**：TypeScript + Node.js (≥ 22)，pnpm monorepo
- **队列存储**：SQLite（本地单文件，崩溃可恢复）
- **交互形态**：CLI 优先；核心做成 headless daemon，Web 看板后期直接挂上，不动核心
- **Agent 接入方式**：headless CLI（`claude -p` / `codex exec` / `gemini -p` …）起步，后续支持 ACP（Agent Client Protocol）与远程 A2A agent
- **工作区隔离**：每任务独立 git worktree + 分支，worker 禁止 push

## 计划中的目录结构

```
conduct_gun/
├── AGENTS.md              # Agent 同步文档（任何 agent 开工前必读）
├── README.md
├── docs/
│   ├── RESEARCH.md        # 已有工作调研
│   ├── DESIGN.md          # 核心设计：任务生命周期/队列/插件接口/路由
│   └── decisions/         # 架构决策记录 (ADR)
├── packages/
│   ├── core/              # 队列、调度器、插件宿主、任务模型（不含任何 LLM 调用）
│   ├── router/            # Router Agent：意图理解、任务拆解、路由策略
│   └── cli/               # cg 命令行入口
└── plugins/
    ├── agent-claude/
    ├── agent-codex/
    ├── agent-gemini/
    ├── agent-grok/
    └── agent-echo/        # 测试用 mock 插件
```

## CLI 一瞥（目标形态）

```bash
cg run "重构 auth 模块，同时给 utils 补测试"   # 交给 Router 拆解派发
cg status                                    # 队列 + 各 agent 运行状态
cg agents                                    # 已注册插件及能力档案
cg logs <task-id>                            # 跟踪某个任务的输出
cg cancel <task-id>                          # 取消任务
cg review <task-id>                          # 审查 diff，决定合并/打回
```

## 路线图

| 里程碑 | 内容 | 验收标准 |
|-------|------|---------|
| M0 | monorepo 脚手架、任务模型、SQLite 队列、echo 插件 | `cg run` 能入队并被 echo 插件消费，重启后队列可恢复 |
| M1 | claude/codex/gemini headless 适配器、worktree 隔离 | 两个真实 agent 并行完成互不冲突的任务，产出可审查 diff |
| M2 | Router Agent（意图澄清 + 规划加工 + LLM 拆解 + 能力路由）、任务依赖 DAG | 一句模糊命令被澄清/加工成清晰 TaskSpec，拆成多任务并按能力档案正确分派 |
| M3 | 重试/超时/租约、review→merge 流程、grok 等更多插件 | 杀掉 worker 进程任务能自动重排；合并流程闭环 |
| M4 | Web 看板、ACP 传输、远程 A2A agent 接入 | 核心不改动的情况下挂上 Web UI 与远程 agent |

## 当前状态

**M0 进行中**。已完成：需求定位、已有工作调研（见 [docs/RESEARCH.md](docs/RESEARCH.md)）、核心设计草案（见 [docs/DESIGN.md](docs/DESIGN.md)）、技术选型、pnpm monorepo 脚手架（core/router/cli/agent-echo 四包，构建与测试通过）。下一步：任务模型 + SQLite 队列 + echo 插件消费闭环。

开发命令：`pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck`

任何参与本项目的 AI agent 请先阅读 [AGENTS.md](AGENTS.md)。

## 相关协议与生态

- [A2A (Agent2Agent)](https://a2a-protocol.org)：agent 间互操作协议，本项目借鉴其 AgentCard / Task 生命周期 / Artifact 概念
- [ACP (Agent Client Protocol)](https://agentclientprotocol.com)：agent ↔ 客户端协议（Zed 发起），是插件传输层的候选标准
- MCP：agent ↔ 工具协议，与本项目正交（worker 内部可自行使用）