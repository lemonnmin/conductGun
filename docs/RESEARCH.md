# 已有工作调研（2026-11）

结论先行：**"编排多个 CLI coding agent" 已是热门赛道，但没有一个现成项目同时做到「队列为核心 + 插件式异构接入 + 能力感知自动路由」这三点。** 多数工具是"并行会话管理器"（用户手动指定谁干什么），少数有 Router 但绑定单一生态。ConductGun 的差异化空间真实存在，且大量工程经验（worktree 隔离、ACP 传输、AgentCard）可以直接借鉴，不必重造。

## 1. 协议层（可借鉴的标准）

| 协议 | 发起方 | 定位 | 对 ConductGun 的意义 |
|------|-------|------|---------------------|
| **A2A (Agent2Agent)** | Google，现捐 Linux Foundation | agent ↔ agent 互操作：AgentCard 能力发现、Task 生命周期（submitted/working/completed…）、Artifact 产出、SSE 流式更新、不透明执行 | 借鉴其 **AgentCard → 我们的能力档案**、**Task 状态机 → 队列任务生命周期**；M4 可作为远程 agent 接入协议 |
| **ACP (Agent Client Protocol)** | Zed + JetBrains | agent ↔ 编辑器/客户端，JSON-RPC over stdio；Claude Code、Codex、Gemini、OpenCode 均有官方/社区适配 | 插件传输层的**首选标准化路径**：一个 ACP 适配器可覆盖多家 agent，替代逐家写 headless CLI 解析 |
| **MCP** | Anthropic | agent ↔ 工具/数据 | 与本项目正交；worker 内部自用。也可把 ConductGun 自身暴露为 MCP server，让任意 agent 反过来给我们派任务 |

参考：[A2A 官方 Codelab](https://codelabs.developers.google.com/intro-a2a-purchasing-concierge)、[A2A 协议解读](https://new.qq.com/rain/a/LNK2025041200520200)、[ACP 文档](https://docs.langchain.org.cn/oss/javascript/deepagents/acp)、[多智能体编排综述](https://www.aminer.cn/pub/6a3d4f1f0a96f8c83c5dfe1d/llm-based-multi-agent-orchestration-a-survey-of-frameworks-communication-protocols-and)

## 2. 直接竞品 / 相近项目

### 2.1 并行会话管理类（用户手动分派，无智能路由）

- **claude-squad**：tmux + git worktree 的 TUI，管理多个 Claude Code/Codex/Aider 会话。隔离模型是业界事实标准，但无队列、无路由、无插件抽象。
- **Conductor / Superset / Zed(Agent Panel)**：Mac 应用或 IDE 形态，把 Claude/Codex/Gemini 派进 per-task worktree，人肉看板审查 diff。参考 [2026 coding agent 对比](https://paradev.com/compare/best-ai-coding-agents-2026)、[Superset 对比](https://superset.sh/fr/compare/best-ide-for-ai-agents)。
- **corral**：终端会话选择与跨运行时交接（只读扫描本地历史），侧重"会话迁移"而非编排。

### 2.2 编排器类（有任务分派，部分有 Router）

- **vibe-kanban**：看板式编排 Claude Code/Codex/Gemini/Aider，任务卡片 → agent 执行 → review。任务生命周期管理成熟，但 agent 选择靠用户指定，接入非插件化。
- **Gas Town**（Steve Yegge）：多 agent 编排器，Mayor/Polecat 角色分工 + git 集成，偏 Claude 生态。见 [awesome-software-factories](https://github.com/varun1505/awesome-software-factories)。
- **agent-orchestrator**（OrchestratorInc，~13.4k★）：Apache-2.0，编排 Claude Code/Codex 等 30+ agent，从任务到 merged PR，带桌面/移动端。体量最大、最接近完整产品，见 [GitHub topic: multi-agent](https://github.com/topics/multi-agent)。
- **ai-maestro**（23blocks，~847★）：多 Agent 编排 OS，支持 Claude Code/Codex/Aider 等，内置持久记忆、A2A 消息、多机协作。见 [awesome-cli-coding-agents](https://github.com/bradagi/awesome-cli-coding-agents)。
- **kodo**（~137★）：自治多 agent 编码编排器，指挥 Claude Code/Codex/Gemini 按工作循环干活，带独立 architect 角色。
- **codex-orchestrator**：Claude Code 当编排器，经 tmux 向 Codex 委派任务——"以 agent 指挥 agent"的最小验证，但硬编码两家。
- **Ruflo（原 claude-flow，rUv）**：Router → Swarm → Agents → Memory，hooks 自动路由并从成功经验学习，314 个 MCP 工具。路由+记忆反馈思路值得借鉴，但深度绑定 Claude Code 生态、体量大而杂。见 [Ruflo 介绍](https://mygit.top/repository/995029641)。
- **brgr**：Herdr 插件，让 Codex/Claude 会话向其他 CLI agent（含 Copilot CLI/OpenCode）委派任务。证明"任意 agent 都能当指挥"可行。

### 2.3 去中心化路线（对照参考）

- **Agensh**（微软开源）：**无中心编排器**，peer 自认领任务，实验规模到 1024 agent，论文以 Claude Code agent teams、Codex sub-agents、Copilot fleet、Kimi Agent Swarm 为对照。见 [报道](https://aihot.virxact.com/items/lkcrtorizxzne84c1r5yxtoej)。与 ConductGun 的中心化 Router 路线相反——中心化更适合"按能力精准分派 + 可解释审计"，去中心化更适合超大规模同构任务。
- **AgentTeams**（agentscope-ai）：manager/worker 通过 coding-request 消息互相委托执行 CLI 编码任务，见 [coding-cli-management skill](https://tool.lu/ko_KR/skill/s/ptr)。

### 2.4 库级多 agent 框架（不同层次，非直接竞品）

LangGraph、AutoGen / Microsoft Agent Framework、CrewAI、OpenAI Agents SDK、Google ADK（[原生支持 A2A](https://pypi.org/project/google-adk/1.8.0/)）：编排的是**进程内 LLM 调用图**，不是"指挥外部完整 CLI agent"。它们不解决 worktree 隔离、CLI 会话管理、异构 harness 适配问题。ConductGun 的 Router 内部未来可以用 LangGraph 之类实现，但核心队列/插件宿主自研。

另外，"先澄清/规格化再执行"的模式已被独立验证：各 CLI agent 的 plan mode、spec-driven development（如 [GitHub Spec Kit](https://github.com/github/spec-kit)）都在做"模糊意图 → 明确规格 → 执行"。但它们把写规格/确认规格的负担仍留给用户；ConductGun 把这一步整体收进 Router，用户端只保留低密度沟通。

## 3. 差距分析 → ConductGun 的差异化

| 维度 | 现有项目普遍状态 | ConductGun 主张 |
|------|----------------|----------------|
| 任务分派 | 用户手动指定 agent，或简单轮询 | **能力档案 + Router 自动匹配**（指令遵循型 vs 推理型 vs 速度成本型），决策可解释 |
| 用户输入处理 | 原始 prompt 基本直接透传给执行 agent，用户须自己会写清晰指令 | **Router 预处理翻译层**：澄清/规划/搜索加工 → 结构化 TaskSpec；人端低密度沟通、机端高密度指令，信息密度解耦 |
| 核心抽象 | 会话管理器 / 看板，队列是附属品 | **持久化队列为第一公民**：DAG 依赖、优先级、租约、崩溃恢复 |
| 异构接入 | 硬编码支持列表，加 agent 改核心 | **插件契约**：AgentPlugin + CapabilityCard，核心零改动接入 grok 等新 agent |
| 形态 | 桌面 App / IDE / TUI 绑定 | headless daemon + CLI，Web 后挂 |
| 协议 | 各家私有 tmux/CLI 解析 | 借鉴 A2A 概念模型，传输层优先走 ACP 标准 |

## 4. 直接采纳的工程经验（少走弯路）

1. **每任务独立 git worktree + 分支**，主工作区零接触——所有成熟项目的共识（claude-squad、vibe-kanban、AgentCraft 等）。
2. **worker 禁 push**：在 git 层面拦截而非命令过滤（AgentCraft 的做法），合并只能由用户批准的 review 流程触发。参考 [AgentCraft 实践](https://blog.csdn.net/gitblog_00552/article/details/170136335)。
3. **任务依赖 DAG**：被依赖任务未完成则下游不开工，避免并行改同一处代码。
4. **状态落盘 + 会话按 id 恢复**：编排器重启后团队自动接上进度。
5. **多 agent 并行 80% 的"卡住"问题出在 CLI 的 API/登录配置**：插件必须带 `healthCheck()`，先单 agent 冒烟再并行。参考 [worktree 并发实践](https://blog.csdn.net/weixin_35749786/article/details/168639563)。
6. **commit 署名到 agent + task**：每个 commit 可追溯是哪个 agent、为哪条指令改的（atlas 的思路），见 [报道](https://m.blog.csdn.net/Number241/article/details/167465473)。
7. **ACP 优先于逐家解析 CLI 输出**：Claude/Codex/Gemini/OpenCode 都有 ACP 适配，一条标准路径覆盖多家；headless CLI 作为无 ACP 时的 fallback。

## 5. 风险与开放问题

- **能力档案从哪来**：静态人工标注起步（M2），后期可依据历史任务成功率自动修正（借鉴 Ruflo 的记忆反馈）。"某 agent 指令遵循强/逻辑强"的量化评估本身是个小课题。
- **Router 用哪个模型**：Router 自身也是一个 agent，需避免"指挥者比执行者贵"的成本倒挂；支持配置廉价模型 + 规则兜底。
- **赛道拥挤**：agent-orchestrator/vibe-kanban 已很成熟。若目标偏个人使用，差异化押在"能力路由 + 插件契约"；若想做产品，需重新评估。