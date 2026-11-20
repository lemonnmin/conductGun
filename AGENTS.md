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
| 阶段 | **M0 进行中**（三任务已派发，实现基本完成，验收合并阶段，见 §2.1） |
| 已完成 | 需求定位、技术选型、调研、设计草案；pnpm monorepo 脚手架（core/router/cli/agent-echo 四包，build/test/typecheck 全绿）；git 已提交并推送 origin/main |
| 进行中 | t-m0-core 实现完成待验收（8841f40，29/29 绿）· **t-m0-echo 验收通过**（9bce5ca，PM 独立复核 14/14 绿）· t-m0-cli 命令+单测完成（24 绿），已合并 core/echo 依赖分支（3d1d750），集成/恢复验收在途 |
| 下一步 | core 验收 + cli 最终回报 → PM 按 core→echo→cli 顺序合并 main（lockfile 冲突按纪律 6 重生成）→ M0 验收（`cg run` 入队→echo 消费→重启恢复） |
| 已知阻塞 | 无（派发已由父会话完成） |

### 2.1 协作拓扑与模块所有权（2026-11-21 起生效）

**星型拓扑**：PM hub（Qoder 主会话）是唯一指挥节点，负责拆解、派发、验收、仲裁接口争议、维护同步文档。三个研发会话是执行侧，只向 PM 汇报，不互相直接改对方代码。

| 角色 | 模块所有权 | 当前任务 / 分支 |
|------|-----------|----------------|
| PM hub | AGENTS.md / README / docs（研发按协议追加日志，合并冲突由 PM 解决） | 派发与验收 |
| 研发A | `packages/core`（任务模型、SQLite 队列、调度、契约类型落码） | t-m0-core / `cg/core/t-m0-core` |
| 研发B | `plugins/*`（echo 插件、契约测试套件） | t-m0-echo / `cg/echo/t-m0-echo` |
| 前端研发 | `packages/cli`（cg 命令）及未来 Web | t-m0-cli / `cg/cli/t-m0-cli` |
| （冻结） | `packages/router` M2 前不动 | — |

**协作纪律（派发任务时随消息下达）：**
1. 开工前读本文件「当前状态」+ 最近 3 条同步日志；收工后追加日志、更新状态。
2. 每个研发在独立 git worktree + 分支干活（`.cg/worktrees/<task-id>`，分支 `cg/<角色>/<task-id>`）；禁止 push、禁止动主工作区他人模块；合并 main 由 PM 协调。
3. 任务消息自包含：任务 id、目标、允许碰的文件、约束、验收标准、汇报格式。
4. 同一模块同一时间只有一个会话在改；跨模块接口变更先经 PM。
5. M0 冻结契约 v1 由 PM 在任务消息中下达，落码位置 `packages/core/src/types.ts`（研发A）；任何偏离须报 PM 仲裁，不得自行改契约。
6. **lockfile 与共享根文件策略（PM 仲裁，2026-11-21）**：`pnpm-lock.yaml` 是生成物——各分支加依赖时可随提交入库（追认前端研发 00582f3、研发B 的 lockfile 提交合规），禁止手工编辑。合并（含研发合并依赖分支到自己分支）遇 lockfile 冲突时不手工解冲突：先解完 package.json 等源码冲突，再 `pnpm install` 重新生成 lockfile 作为合并 resolution。`pnpm-workspace.yaml` 的 allowBuilds 等依赖批准落盘同属必然产物，允许提交（追认研发A 的改动），合并冲突取并集。合并 main 由 PM 按 core→echo→cli 顺序执行，每次合并后重生成 lockfile 并跑全量 build/test/typecheck 验证。AGENTS.md 同步日志合并冲突取各分支条目并集（按时间排序，不改写历史）。

**M0 范围决策（PM 仲裁，2026-11-21）：**
- M0 不做独立 daemon：CLI 进程内组合 TaskQueue + WorkerHost；daemon RPC 选型（DESIGN 开放问题 5）留 M1+。
- M0 CLI 直填 TaskSpec（用户原文进 goal/instructions）是脚手架例外——echo 为 mock、无真实下游 agent；M2 Router 落地后严格执行不变量 8。
- 插件契约测试套件暂放 `plugins/agent-echo` 导出，供未来插件复用；如需迁移由 PM 决定。

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

### 2026-11-20 · Qoder (主会话) · 关联远程仓库并首次推送
- 改动：git remote origin = https://github.com/lemonnmin/conductGun.git；首次提交 f1e0d67（脚手架+文档 23 文件）；合并远程 LICENSE（--allow-unrelated-histories）；已推送，main 跟踪 origin/main
- 决策：无
- 遗留：① 本机 HTTPS git 凭据缺失，推送需借 gh 凭据：`git -c credential.helper= -c credential.helper='!/opt/homebrew/bin/gh auth git-credential' push`（gh 已登录 lemonnmin；SSH 22 端口被断、key 未注册）；② git 提交身份是自动生成的 ljb <ljb@liulemon.local>，用户如需规范署名应自行设置 git config user.name/email

### 2026-11-21 · Qoder (PM hub) · 星型协作拓扑生效 + M0 剩余目标拆解（派发受阻）
- 改动：AGENTS.md（§2 状态更新、新增 §2.1 拓扑/所有权/纪律/M0 范围决策）；三份任务书落盘 docs/dispatch/2026-11-21-m0-tasks.md（t-m0-core / t-m0-echo / t-m0-cli，含冻结契约与验收标准）
- 决策：① M0 冻结契约 v1：TaskSpec/CapabilityCard/AgentPlugin 按 DESIGN §5.2/§4，RunContext/RunResult/TaskQueue/WorkerHost 最小签名由 PM 冻结并写入任务书，研发A 落码 `packages/core/src/types.ts`；② M0 无独立 daemon，CLI 进程内组合（开放问题 5 留 M1+）；③ M0 CLI 直填 TaskSpec 为脚手架例外，M2 起严格执行不变量 8；④ 契约测试套件暂放 plugins/agent-echo 导出
- 遗留：**派发未完成**——本 PM 会话是委派会话，平台拒绝其 send_message_to_chat_session（禁止委派会话向其他会话转发），三条消息均未送达；需父会话或用户主会话按任务书向研发A/B/前端研发派发（supervise）。其余：依赖顺序 core→echo→cli，B/C 可先行开发、按需合并依赖分支取类型（只读，不改对方模块）；DESIGN.md 的 M0 细化由 PM 在合并阶段统一回写；better-sqlite3 首次安装需 `pnpm approve-builds better-sqlite3 -y`；跨包类型解析需先 build core（exports 指向 dist）

### 2026-11-21 · Qoder (PM hub) · lockfile 合并策略仲裁 + 三任务进展登记
- 改动：AGENTS.md（§2 状态更新、§2.1 新增纪律 6 lockfile/共享根文件策略）
- 决策：① pnpm-lock.yaml 为生成物，各分支可随加依赖提交（追认前端研发 00582f3、研发B lockfile 提交合规），禁手编；合并冲突一律先解源码冲突再 `pnpm install` 重生成，不手工解 lockfile；② pnpm-workspace.yaml allowBuilds 落盘同属必然产物，追认研发A 改动，冲突取并集；③ 合并 main 顺序 core→echo→cli，每次合并后重生成 lockfile + 全量 build/test/typecheck；④ AGENTS.md 日志合并冲突取条目并集
- 遗留：① 派发已由父会话完成；core（8841f40，29/29 绿）与 echo（9bce5ca，14/14 绿）完成待 PM 验收，cli（3d1d750）已合并两依赖分支、集成/恢复验收在途；② cli 分支的 AGENTS.md 缺研发A 完成日志条目（合并时序所致），PM 合并 main 时按并集规则补齐；③ 研发A 报告 completeRun(ok:false)→failed、recover 旧 run 标 cancelled 等实现语义，PM 验收时对照契约核验；④ DESIGN.md M0 细化仍由 PM 合并阶段统一回写

### 2026-11-21 · Qoder (PM hub) · t-m0-echo 验收通过
- 改动：AGENTS.md（§2 状态更新）；无代码改动（验收在 echo worktree 独立复核）
- 决策：验收结论**通过**。复核证据：① worktree 内独立重跑 build/typecheck/test 全绿（14/14：契约 7 + echo 专属 7）；② card 与冻结任务书逐字段一致；③ 契约套件覆盖全部要求断言（card 合法性/healthCheck/RunResult+events/abort 中途与预先两种/cancel 幂等/失败注入经 createFailing 工厂解耦）；④ `./contract` 与主入口 dist 导出经 node import 实测可解析，主入口不含 vitest；⑤ abort 语义「ok:false」与失败计数实例隔离均有专属测试钉死。lockfile 变更按纪律 6 合规
- 遗留：① echo 分支含 core 类型提交 4ff1e89，合并 main 时先合 core 全量分支即自然去重；② 通用契约要求插件至少异步检查一次 signal（瞬时同步完成的插件需保留异步检查点），未来插件接入须注意；③ 合并 main 仍按 core→echo→cli 顺序，待 core 验收与 cli 最终回报

### 2026-11-21 · 研发A (Qoder 委派会话) · t-m0-core：冻结契约落码 + SQLite 队列 + WorkerHost
- 改动：packages/core/src/{types,ids,queue,worker-host,index}.ts；packages/core/test/{helpers,queue,worker-host}.test.ts（29 用例含崩溃恢复）；core package.json（better-sqlite3 ^12.11.1 / @types/better-sqlite3 / vitest devDep + test script）+ 包内 vitest.config.ts；pnpm-lock.yaml 与 pnpm-workspace.yaml（allowBuilds: better-sqlite3，任务书指令 approve-builds 的必然落盘，属根配置请 PM 知悉）
- 决策：公开契约签名与冻结版 v1 完全一致，无偏离。实现细节：① RunContext.reportEvent 需写 events 但冻结面无事件写入方法——用包内 WeakMap 通道 appendEventInternal（queue.ts 导出、index.ts 不导出），公开面零扩展；② completeRun(ok:false) → task failed（execute 抛错走 failRun）；③ recover() 把 running 重置 queued，旧 run 标 cancelled（error=interrupted），幂等；④ claimNext 单事务原子，FIFO 按 created_at+rowid，未注册 agent 返回 null；⑤ WorkerHost.start 自动 registerAgent（幂等 upsert），stop() abort 在途 run 并等待落定
- 遗留：分支 cg/core/t-m0-core（4ff1e89 types 先行 → 8841f40 实现 → 本条日志 commit），未 push，待 PM 验收合并 main。依赖方（echo/cli）现在可 merge 本分支取类型，先 `pnpm --filter @conductgun/core build`。M0 简化项留给 M1+：无租约/心跳续租（heartbeat no-op）、workdir=process.cwd()（worktree 隔离）、无重试/优先级/DAG。build/test/typecheck 全绿（29/29）

### 2026-11-21 · Qoder (研发B) · t-m0-echo：echo mock 插件 + 可复用契约测试套件（已完成待验收）
- 改动：plugins/agent-echo（新增 src/echo.ts、src/contract.ts、test/echo.test.ts、vitest.config.ts；src/index.ts 改为插件导出；package.json 加 `./contract` exports 子路径、test 脚本、vitest devDep）；pnpm-lock.yaml（仅 agent-echo 的 vitest 条目——package.json 允许范围内改动的必然产物，按协议登记的范围外必要改动）；合并 cg/core/t-m0-core @ 4ff1e89 取冻结契约类型（只读引用，未改 core 任何文件）；AGENTS.md 状态行更新
- 决策：① abort 语义二选一选定「返回 { ok:false, summary:"aborted" }」，echo 专属测试钉死；通用契约断言按冻结契约接受 ok:false 或抛出两种实现；② 契约套件签名 `runAgentContractTests(name, factory, opts?)`，失败注入经 `opts.createFailing` 工厂提供（不绑定 echo 私有 failNext），未提供则 skip 该项；③ cancel(runId) 用插件内部 AbortController 与宿主 ctx.signal 合并实现（signal 归宿主所有，插件无法直接 abort），幂等、未知 runId 无操作；④ 套件同时导出 createContractRunHarness / makeContractTaskSpec 供未来插件测试复用；⑤ 主入口不 re-export 契约套件，避免消费方被迫引入 vitest
- 遗留：① 验收结果：build / typecheck / test 全绿（14 tests：契约 7 + echo 专属 7），`./contract` 子路径 dist 导出已验证可解析；② 未来插件接入方式：import { runAgentContractTests } from "@conductgun/agent-echo/contract"，传 factory 与可选 createFailing；③ 通用 abort/cancel 断言要求插件至少异步检查一次 signal（瞬时同步完成的插件需在实现中保留异步检查点）；④ 套件如需迁出 agent-echo 由 PM 决定，迁移仅涉及 src/contract.ts 与 exports 子路径；⑤ 分支 cg/echo/t-m0-echo @ 17fa365（实现）+ 本条日志提交，未 push，合并 main 由 PM 协调
### 2026-11-21 · 前端研发 (Qoder 委派会话) · t-m0-cli：cg run/status/logs 接线 + 重启恢复集成测试（已完成待验收）
- 改动：packages/cli（新增 src/args.ts 命令解析、src/spec.ts TaskSpec 构造、src/format.ts 低密度输出、src/commands.ts 进程内 Queue+WorkerHost 组合；src/index.ts 改为 shebang 入口；package.json 加 @conductgun/agent-echo 依赖与 vitest devDep/test 脚本、移除 M0 未用的 @conductgun/router 依赖）；packages/cli/test/{args,spec,format,cli}.test.ts（31 用例）；pnpm-lock.yaml（cli 依赖变更的必然产物）；合并 cg/core/t-m0-core（4ff1e89→8841f40→a056be4）与 cg/echo/t-m0-echo（只读引用，未改对方模块文件）；AGENTS.md（解决与研发A/B 日志的合并冲突：双方条目全保留，状态行合并）
- 决策：无契约偏离。实现选择：① run 的结果摘要取该任务最后一条 event 的 message（冻结契约 getTask 不暴露 RunResult，completeRun 已把 summary 写入 events）；② run 等待终态轮询 50ms、30s 超时兜底（防匹配失败时挂死）；③ 每次打开队列先 recover()（M0 单进程简化，任务书规定）；④ commands 层注入 CommandIo 与 plugins 参数，stub 闭环测试不依赖真实 echo；⑤ 时间显示用 UTC ISO（logs），M1 可换本地时区
- 遗留：① 验收结果：build / typecheck / test 全绿（31 tests：单测 24 + 集成 7，含真实 echoPlugin 闭环、失败注入退出码、崩溃恢复两条路径）；bin 冒烟通过（run/status/logs/错误路径退出码均符合任务书）；② 分支 cg/cli/t-m0-cli，未 push，合并 main 由 PM 协调——本分支已含 core/echo 全部提交，PM 合并本分支即可带齐三方（AGENTS.md 冲突已在本分支解决）；③ M1+ 提示：daemon RPC 落地后 commands.ts 的进程内组合改为客户端调用；cg logs 时间可转本地时区；④ DESIGN.md §7 仍描述 daemon RPC 形态，与 M0 进程内实现的差异由 PM 在合并阶段统一回写（任务书禁改 docs）
