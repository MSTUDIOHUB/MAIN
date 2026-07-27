# MAIN 架构与唯一所有权

> 状态：现行规范
> 最后按代码核验：2026-07-23
> 若历史发布说明、旧截图或注释与本文冲突，以本文和当前测试为准。

MAIN 采用一个产品运行时、一个受信任执行边界和一个确定性验证边界。任何生命周期规则只能有一个所有者，不能在 TypeScript 与 Rust 中各实现一套策略。

## 唯一所有权

| 边界 | 唯一所有者 | 当前代码入口 | 不负责 |
| --- | --- | --- | --- |
| 用户意图、Plan Authoring Contract、typed Plan graph、模型循环与恢复策略 | TypeScript | `src/store/submitAsyncWorkflowRun.ts`、`src/store/submitWorkflowEngineRunner.ts`、`src/lib/orchestrator/workflowEngine.ts`、`src/lib/orchestrator.ts`、`src/lib/orchestrator/loop/AgentOrchestrator.ts`、`src/lib/planAuthoringContract.ts`、`src/lib/planContract.ts` | 最终文件系统、Shell、网络与进程安全；让模型文本直接决定生命周期或完成状态 |
| 审批请求、Context、Session 语义、Workspace Turn 接纳/FIFO、canonical Turn checkpoint、执行尝试所有权、续跑和 UI 可见状态 | TypeScript | `src/store/useAppStore.ts`、`src/store/workspaceTurnQueue.ts`、`src/store/submitRunLease.ts`、`src/lib/turnRuntimeContract.ts`、`src/lib/turnRuntimeCheckpoint.ts`、`src/lib/turnEvents.ts`、`src/lib/runTransitionReducer.ts` | 执行未经 Rust 复核的命令；把业务状态裁决委托给 SQLite |
| 文件、Shell、PTY、应用管理的网络请求和 Session 快照存储机制 | Rust | `src-tauri/src/lib.rs`、`src-tauri/src/trusted_execution.rs`、`src-tauri/src/network_guard.rs`、`src-tauri/src/harness/permissions.rs`、`src-tauri/src/session_store.rs` | 重新判断用户意图、计划、队列状态、Run 所有权、transcript 合并或模型恢复策略 |
| Trace、Replay、Golden、Eval 和回归夹具 | Rust Harness | `src-tauri/src/harness/`、`src-tauri/src/runtime/`、`src-tauri/src/eval/`、`benchmark/` | 推进生产会话的模型循环 |

Rust `RuntimeLoop` 与 `runRuntimeHarness()` 当前是验证基础设施，不是生产 Agent 循环。除非先证明生产调用方已经迁移，否则不得把其中的策略描述成产品运行时行为。

`src-tauri/src/harness/permissions.rs` 当前是一个路径命名例外：生产 Shell 执行和 Harness 都复用其中的 `PermissionGuard`。它的生产权限校验职责属于 Rust 受信任执行边界，不能因为目录名含 `harness` 就把用户审批后的最终命令校验降为测试专用逻辑。

## 生产调用链

工作区提交进入 TypeScript 后，生产执行链为：

1. Workspace 接纳先创建稳定的 `clientSubmissionId`、receipt、`turnId`、用户块和回合标题，并把新 Turn 写入 Session/FIFO。
2. `startSubmitAsyncWorkflowRun()` / `runSubmitAsyncWorkflowRun()` 接管已持久化的提交，`runSubmitWorkflowEngine()` 建立工作流执行环境。
3. `workflowEngine.ts` 建立或恢复 exact-owner canonical Turn checkpoint，维护 Run、审批、计划续跑与最终投影。
4. `AgentOrchestrator` 执行 provider-neutral 模型循环并选择工具；Plan 策略先冻结 authoring contract 与证据义务，再允许起草。
5. Plan 候选通过共享 typed ingress 校验、seal、单向渲染 Markdown 并原子提交；批准后执行任务从 typed graph 派生，不从 Markdown 反向猜测。
6. 工具通过 TypeScript IPC 进入 Rust；已经迁移到统一边界的入口再做路径、Shell、网络、超时与进程回收校验。工具结果进入结构化证据账本。
7. canonical Turn 状态、审批、Plan artifact、证据与兼容事件回到 Session 投影；ChatArea、进度胶囊和时间线只从这些结构化事实渲染。

“Chat / Plan / Fast”只改变策略和工具暴露，不改变工作区提交的身份：工作区会话中每次用户提交都是一个 Turn。

## Provider-neutral Plan 边界

Plan 模式采用单向权威链，避免“先自由写 Markdown，再由多套正则猜状态”：

```text
Turn intake
  -> Plan Authoring Contract（冻结目标、G 分面、上下文目标、诊断要求、验收条款）
  -> typed evidence bundle / obligations
  -> typed Plan draft
  -> shared ingress + seal + contract validation
  -> Markdown review projection + atomic artifact commit
  -> plan.artifact_accepted
  -> pending_review
```

- `src/lib/planAuthoringContract.ts` 在起草前声明 `understand -> gather -> draft -> revise -> review` 阶段和固定验收条款。质量门只能报告这些预先声明条款的违约，不能在候选生成后改写目标。
- `src/lib/planContract.ts` 的 `PlanCandidateV5` 是审批和执行权威。它显式连接目标 `G`、runtime 派生的独立证据组件 `B`、证据 `E`、诊断 `R`、改动 `C`、保留/设计决策 `D` 与验证 `V`；Markdown 只是带 hash 的 `projection`。模型负责提交 `G -> B` 的语义映射，runtime 负责验证每个 `B` 的 owner/evidence/relation 集合、独立性和闭包要求，不能由 runtime 猜测某段证据属于哪个用户目标。
- 支持 native tool 的 provider 使用 `submit_plan_candidate`；不支持 native tools 时，adapter 原子替换同一 frozen contract 的提交说明，并使用 `<plan_candidate>` 文本 envelope。两种传输都进入 `src/lib/planDraftIngress.ts` 的同一语义校验，不给隐藏 reasoning、普通正文、provider 名称或模型名称状态权威。
- 首次候选不合格时，runtime 生成绑定原 draft hash、证据 receipt 和失败节点的局部 repair checkpoint；后续仍使用同名 `submit_plan_candidate`，但 tool schema 只允许有界替换被拒绝的 `R/C/D/V` 节点。已接受图和证据权威保持不变。修复次数、累计字符和操作数耗尽后进入可见 `action_required` pause，不能回落为 done/idle，也不能让隐藏 reasoning 充当修正版。
- `src/lib/planArtifactCommit.ts` 是 Plan artifact 的统一 commit policy。新运行只能提交绑定 candidate hash、authoring contract、evidence bundle 与 Markdown projection 的 typed Plan；legacy Markdown 只允许显式 hydration/import，不能与 typed authority 混用。
- 批准后的任务由 graph 中的 changes 与 validations 派生。`src/lib/validationContract.ts` 定义有限命令、长驻服务观察、浏览器交互、桌面交互、typed assertion 与 advisory；只有 `required` 且具备可判定 producer/result 的 primitive 能关闭验收，服务已启动或人工建议不能单独证明完成。没有既有 browser/desktop 验收能力时，候选必须把 `plannedValidationHarness` 作为真实 `create/modify` change，并由 validation 的 `harnessChangeRef` 和有限命令结构化绑定；runtime 不得凭测试措辞猜出一个不存在的 harness。

Provider adapter 的职责到“能力检测、请求/响应形状、stream、图片、native tool 与文本 fallback”截止。它不能决定 Plan 是否合格、是否进入审核、任务是否完成或 Turn 的终态；这些决定由共享 typed contract、证据账本和 canonical Turn reducer 统一处理。

## 证据与协作边界

MAIN 使用同一套结构化证据规则贯穿规划和执行，但保留不同阶段的持久化形状：

- 规划阶段把只读工具观察规范化为 frozen `PlanEvidenceBundle`，并由 runtime 生成精确路径/符号 occurrence 义务。模型只能引用 bundle 中已有的 `E`；普通摘要、搜索词和未覆盖目录不成为事实。
- 批准后执行使用 append-only `PlanExecutionEvidenceEntry[]`。每项可绑定 transaction、Run、Plan task、operation 与 validation obligation；typed validation adapter 只消费匹配 exact obligation 的结构化 producer result。
- 完成由 review 后的 task graph、transaction-scoped ledger、可用验证边界和 recovery 状态共同投影。模型声称“已完成”、任务状态缓存、泛化工具成功或只启动服务都不能越过证据缺口。
- Execute 的普通工作区恢复使用稳定的读／改／验核心工具面；阶段状态只表达优先动作，不再把安全的相邻工具调用判成协议错误。软 no-progress 计数不改变工具权限，只能决定继续提示或诚实暂停。路径/权限、源码新鲜度、批准 scope、进程生命周期和证据闭包仍是硬门。
- 工具结果的具体因果 handler 先于通用 no-progress policy：真实修改和失败验证必须先推进或重开对应事务，重复／迭代预算只能处理没有更具体状态迁移的批次。工作区级验证不得把多文件 objective 重新绑定到最近一次改动文件；无唯一诊断归因时，普通读取只记为证据，不能取得单文件事务所有权。
- 子智能体偏好只有在 runtime 已获得至少两个不重叠、可安全并行的只读 scope 后才形成 `PreferredDelegationScopeContract`。在 parent 第一次模型请求前，runtime 可从 trusted project skeleton 的稳定顶层目录直接派发这些 scope，避免把协作成败交给模型是否主动调用协调工具。每个 scope 仍必须经过 `spawn -> join -> consume`；只有带 child/tool/observation 身份、位于冻结 allowed paths 内且 closure 为 `satisfied` 的实质观察可进入 runtime-issued closure receipt。需要父级复读的 adopted observation 只用于发现，不能关闭 parent read obligation 或抑制精确复读。Turn checkpoint 只引用 receipt，canonical payload 位于独立 Session ledger；child summary、未 join 输出、partial/blocked closure 与 coordination tool 本身都不算完成证据。

这不是把所有阶段压进一个未经区分的数组：Plan bundle、subagent closure receipt ledger 与执行 ledger 各保留自己的 schema，但共享精确身份、provenance、scope、obligation 和确定性评估规则。closure receipt 是 TypeScript runtime 的语义所有权边界，并非用于抵抗任意本地 Session snapshot 重写的密码学签名；Rust 仍只负责 opaque snapshot CAS。

## 核心实体

- **Workspace**：文件与命令的安全根目录，也是 Session 的持久化分区。
- **Session**：同一工作区内的上下文、Turn、运行时投影与恢复状态。
- **Turn**：一次已接纳的用户提交；拥有稳定 `turnId`，最终必须产生一个 `turn.completed`。
- **Run**：为推进同一 Turn 发起的一次执行尝试；审批后续跑、计划执行或恢复可以形成带 `parentRunId` 的后续 Run。
- **Item / Tool result**：Run 内的操作证据。工具可以失败，但工具失败不是应用级失败终态。
- **Plan Authoring Contract**：起草前冻结的目标、分面、上下文目标、诊断要求与验收标准；provider transport 变化不得改变它。
- **Typed Plan graph**：Plan 审批与执行权威；Markdown 只是用户可读投影。
- **Evidence ledger**：runtime 拥有的结构化观察与结果；完成投影只接受与当前 transaction/task/obligation 对齐的证据。
- **Canonical Turn checkpoint**：绑定 workspace、Session/epoch、client submission、Turn 和 Run attempt 的可回放状态；保存 Plan review、协作 scope 状态与 closure receipt refs，不内嵌自证式子智能体证据。

详细状态机见 [运行时生命周期](RUNTIME_LIFECYCLE.md)，持久化见 [Session 持久化](SESSION_PERSISTENCE.md)。

## 不可破坏的架构规则

1. TypeScript 决定做什么；Rust 对已经接入受信任执行边界的具体本机或网络操作做最终 fail-closed 校验。该边界不是 OS 级进程沙箱。
2. UI 不从助手措辞、异常字符串或工具 stderr 推断完成状态。
3. 应用层没有 `run.failed` 或 `turn.failed`；错误是 `completed` 的一种 `resultKind`。
4. `run.paused` 与 `run.aborted` 都不是终态。只有 `run.completed` 和 `turn.completed` 是各自层级的结论事件。
5. TypeScript 是 Workspace Turn 队列、接纳凭证、恢复协调、执行尝试所有权和 partial transcript 合并的唯一语义所有者；Rust SQLite 负责 opaque snapshot revision CAS、存储 envelope、读时 transcript 分页投影与 legacy import，但 `save_project_session` 不得解析或改写 `messages`、`runtimeSnapshot`、Harness marker 或生命周期状态。
6. Rust Harness 用同一结构化结果契约验证执行语义，但不得复制生产模型循环的策略所有权。
7. Plan 的自然语言与 Markdown 不得成为执行或审核状态的第二事实源；typed graph 只可单向生成 review projection。
8. `plan.artifact_accepted` 必须投影为非终态 `pending_review / awaiting_approval`。它不能被通用的 done/idle 收尾覆盖，也不能在没有 exact artifact/action-request/lifecycle identity 时恢复审批。
9. provider、模型、语言和项目类型只能改变 adapter/内容，不得改变 typed Plan、validation、evidence、subagent 或 Turn 状态机语义。
10. active Run 输入必须明确区分 Queue 与 Guide：Queue 接纳一个新的 durable Turn；Guide 只向当前 running Run 注入一次文本引导，不创建 Turn，也不能携带附件或显式 Plan/Goal 意图。

## 修改路由

- 意图误判、Plan contract/typed ingress、计划续跑、证据义务、重复读取、无响应恢复：修改 TypeScript 编排层。
- provider 的 native tool/XML/文本/image/stream 兼容：修改 provider adapter；不得在 adapter 中复制 Plan 质量门或终态规则。
- Plan artifact hash、typed/legacy 权威混用、任务投影：修改 `planArtifactCommit.ts` / typed Plan contract，不从 UI 或 Markdown 加补丁。
- pending review、Queue/Guide、Run/Turn 终态和 cold restore owner 漂移：修改 canonical Turn contract/checkpoint 与 Session 投影。
- 路径逃逸、命令结构、超时回收、PTY、重定向、DNS 或网络跳转：修改 Rust 受信任执行层。
- 重启丢 Turn、提交乱序、重复分发、partial transcript 丢失、接纳或执行所有权冲突：修改 TypeScript Session/FIFO/IPC save queue/attempt owner；只有快照损坏、revision CAS、storage envelope、schema、读时分页投影或旧数据导入问题修改 Rust Session Store。
- 复现、语义漂移和回归门禁：修改 Rust Harness、Golden Trace 或 `benchmark/` 夹具。

不要依据文件名或旧架构计划猜测所有权；先用调用点证明生产路径。

## 关联规范

- [运行时生命周期](RUNTIME_LIFECYCLE.md)
- [Session 持久化](SESSION_PERSISTENCE.md)
- [受信任执行](TRUSTED_EXECUTION.md)
- [测试、Trace 与 Replay](TESTING_AND_REPLAY.md)
- [MAIN 用户手册](main-manual/overview.md)
