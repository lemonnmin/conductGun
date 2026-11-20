# AGENTS.md — ConductGun Agent 同步文档

> **任何 AI agent（Claude Code / Codex / Gemini / Grok / 其他）在本仓库工作前必须先读完本文件，工作结束后必须更新本文件的「当前状态」与「同步日志」。**
> 本文件是所有 agent 之间的唯一同步契约（single source of truth）。文档之间如有冲突，以本文件的「架构不变量」为准；发现本文件过时，先修正再开工。

## 1. 项目一句话

ConductGun：一个 Router Agent 通过持久化任务队列，把用户命令拆解并派发给插件化的异构 CLI agent（claude/codex/gemini/grok…）执行，按各 agent 能力档案路由，取其所长。Router 同时是人机沟通翻译层：预处理模糊的用户输入（澄清/规划/搜索加工），生成清晰的结构化指令再下达——用户不需要会写 prompt，理解成本由 Router 吸收。

必读上下文（按序）：
1. 本文件
2. [README.md](README.md) — 愿景、架构图、路线图
3. [docs/DESIGN.md](docs/DESIGN.md) — 任务模型、队列语义、插件接口、路由策略
4. [docs/RESEARCH.md](docs/RESEARCH.md) — 已有工作调研（仅在需要选型/对比时读）

## 2. 当前状态

| 项 | 状态 |
|----|------|
| 阶段 | **M0 进行中**（脚手架已完成） |
| 已完成 | 需求定位、技术选型、调研、设计草案；pnpm monorepo 脚手架（core/router/cli/agent-echo 四包，build/test/typecheck 全绿，git 已 init 未提交） |
| 进行中 | 无 |
| 下一步 | M0 剩余：任务模型 + SQLite 队列 + echo 插件消费闭环（`cg run` 入队→消费→重启恢复） |
| 已知阻塞 | 无 |

## 3. 架构不变量（不得违反）

1. **队列为核心**：Router 与 Worker 之间只通过任务队列交互，禁止直接函数调用/直接进程耦合。
2. **core 无 LLM**：`packages/core` 不得包含任何 LLM API 调用；智能只存在于 `packages/router` 和插件内。
3. **插件即 agent**：接入新 agent 只能新增 `plugins/agent-*` 插件并实现 `AgentPlugin` 接口 + 能力档案，禁止在 core/router 里写 if-else 特判某个 agent。
4. **任务先入队**：任何执行必须先落库（SQLite）再派发；进程崩溃后队列必须可恢复。
5. **worktree 隔离**：每个改代码的任务在独立 git worktree + 独立分支执行；worker 禁止 push、禁止触碰主工作区。
6. **CLI 优先、headless 核心**：核心是 daemon，CLI/Web 都只是客户端；不得把交互逻辑写进 core。
7. **能力档案驱动路由**：路由决策必须可解释（记录为什么选这个 agent），规则兜底必须存在，LLM 路由失败时降级为规则路由。
8. **下游不透传原文**：执行 agent 只接收 Router 加工后的结构化 TaskSpec（目标/上下文/约束/验收标准），永远不接收用户原始 prompt；用户原文保留在 Command 记录中可追溯。
9. **信息密度解耦**：面向用户的输出保持低密度、说人话（摘要 + 透明假设）；高密度细节只进 TaskSpec 给机器。澄清追问有预算，默认最多 1 轮。

## 4. 工程约定

- TypeScript strict 模式，ESM，Node ≥ 22，包管理 pnpm workspace
- 目录结构遵循 README「计划中的目录结构」；新增顶层目录需先在本文件登记
- 命名：任务 id 用 `t-` 前缀 + 短 uuid；分支名 `cg/<agent>/<task-id>`；插件包名 `@conductgun/agent-<name>`
- 测试：core 的队列/调度逻辑必须有单测（vitest）；插件用 echo/mock 方式测契约
- 不引入重型依赖前先查 docs/RESEARCH.md 是否已有可借鉴方案，并在 ADR 记录理由
- 架构级决策写入 `docs/decisions/NNNN-标题.md`（ADR 格式：背景/决策/后果），并在下方同步日志引用

## 5. Agent 工作协议（同步机制）

**开工前：**
1. 读本文件 + 相关设计文档，确认「当前状态」与实际仓库一致；不一致先修复文档。
2. 在「当前状态」表中登记你正在做什么（阶段/进行中）。
3. 检查同步日志最近 3 条，避免与其他 agent 的在途工作冲突（同一模块不要并行改）。

**工作中：**
4. 只做登记范围内的任务；发现范围外的必要改动，先在同步日志记录再动手。
5. 不违反第 3 节不变量；确需违反，必须先写 ADR 并征得用户同意。

**收工后：**
6. 更新「当前状态」（已完成/下一步）。
7. 在「同步日志」**追加**一条记录（格式见下），不删除、不改写历史条目。
8. 若改了接口/约定/路线图，同步更新 README.md 与 docs/DESIGN.md，保持三处一致。

**同步日志条目格式：**

```
### YYYY-MM-DD · <agent 名> · <任务简述>
- 改动：<文件/模块列表>
- 决策：<如有，链接 ADR>
- 遗留：<未完成事项、给下一个 agent 的提示>
```

## 6. 禁止事项

- 禁止 `git push`、 force-push、删除分支等影响远端/他人工作的操作（除非用户明确要求）
- 禁止提交密钥、token、`.env`
- 禁止绕过队列直接让一个 agent 拉起另一个 agent
- 禁止删除或改写同步日志历史条目
- 禁止在 core 中硬编码任何具体 agent 的名字

## 7. 同步日志

### 2026-11-18 · Qoder (主会话) · 开发前准备
- 改动：创建 README.md、AGENTS.md、docs/RESEARCH.md、docs/DESIGN.md
- 决策：技术栈定为 TypeScript/Node ≥22 + pnpm monorepo + SQLite 队列；MVP CLI 优先、核心 headless 预留 Web（用户确认）
- 遗留：M0 未开始；DESIGN.md 中「开放问题」一节需要在 M0/M1 期间敲定

### 2026-11-19 · Qoder (主会话) · 补充核心产品定位：Router 作为人机沟通翻译层
- 改动：README.md（新增「翻译层」动机、设计主线第 3 条、M2 验收更新）、docs/DESIGN.md（§5 重写为预处理流水线 P0–P4 + TaskSpec 结构 + 沟通原则，开放问题新增 6/7）、AGENTS.md（不变量新增 8/9）、docs/RESEARCH.md（差距分析补充意图澄清维度）
- 决策：用户明确项目第二目的——为不擅长下清晰指令的用户做 prompt 预处理（plan/搜索/思考加工），对齐人类沟通方式、解耦信息密度；落为不变量「下游不透传原文」「信息密度解耦」
- 遗留：TaskSpec 字段为草案，M2 前需结合真实 CLI agent 的输入习惯校准；澄清预算默认值（1 轮）待实测调整

### 2026-11-19 · Qoder (主会话) · M0 脚手架初始化
- 改动：根配置（package.json / pnpm-workspace.yaml / tsconfig.base.json / vitest.config.ts / .gitignore）；packages/core、packages/router、packages/cli、plugins/agent-echo 四包骨架；core 冒烟测试；git init（main，未提交）
- 决策：无架构级变更；工具链实际版本 pnpm 12.21.0 / TypeScript 7.0.2 / vitest 5.1.1 / @types/node 26
- 遗留：给下一个 agent 的坑位提示——① pnpm 12 拦截依赖构建脚本，需 `pnpm approve-builds <pkg> -y`（esbuild 已批准；后续 better-sqlite3 也要批准）；② TS7 不自动加载 @types，tsconfig.base.json 已显式 `"types": ["node"]`；③ pnpm 隔离布局下每个子包需自带 typescript + @types/node devDeps；④ SQLite 队列、任务模型、echo 插件逻辑均未实现，各包 index.ts 仅占位导出