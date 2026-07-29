# MAIN 架构与唯一所有权

> 状态：现行规范
> 最后按代码核验：2026-07-29
> 若历史发布说明、旧截图或注释与本文冲突，以本文和当前测试为准。
>
> Runtime 修改必须同时遵守 [最小运行内核与能力边界](RUNTIME_KERNEL_INVARIANTS.md)。
> 该文档记录当前生产入口、已接线能力和 v1/v2 对照门；仅存在但没有生产调用方的导出函数不构成产品能力。

MAIN 采用一个产品运行时、一个受信任执行边界和一个确定性验证边界。任何生命周期规则只能有一个所有者，不能在 TypeScript 与 Rust 中各实现一套策略。

## 唯一所有权

| 边界 | 唯一所有者 | 当前代码入口 | 不负责 |
| --- | --- | --- | --- |
| 用户意图、Runtime v2 runner、模型循环与恢复策略 | TypeScript | `src/store/submitAsyncWorkflowRun.ts`、`src/store/submitRuntimeRunner.ts`、`src/store/runtimeV2/`、`src/lib/runtime-v2/` | 最终文件系统、Shell、网络与进程安全；让模型文本直接决定生命周期或完成状态 |
| 审批请求、Context、Session 语义、Workspace Turn 接纳/FIFO、canonical Turn checkpoint、执行尝试所有权、续跑和 UI 可见状态 | TypeScript | `src/store/useAppStore.ts`、`src/store/workspaceTurnQueue.ts`、`src/store/submitRunLease.ts`、`src/lib/turnRuntimeContract.ts`、`src/lib/turnRuntimeCheckpoint.ts`、`src/lib/turnEvents.ts`、`src/lib/runTransitionReducer.ts` | 执行未经 Rust 复核的命令；把业务状态裁决委托给 SQLite |
| 文件、Shell、PTY、应用管理的网络请求和 Session 快照存储机制 | Rust | `src-tauri/src/lib.rs`、`src-tauri/src/trusted_execution.rs`、`src-tauri/src/network_guard.rs`、`src-tauri/src/harness/permissions.rs`、`src-tauri/src/session_store.rs` | 重新判断用户意图、计划、队列状态、Run 所有权、transcript 合并或模型恢复策略 |
| Trace、Replay、Golden、Eval 和回归夹具 | Rust Harness | `src-tauri/src/harness/`、`src-tauri/src/runtime/`、`src-tauri/src/eval/`、`benchmark/` | 推进生产会话的模型循环 |

旧 `AgentOrchestrator`、Rust `RuntimeLoop` 与 `runRuntimeHarness()` 当前不是 Workspace Turn 的生产 Agent 循环。它们只可作为历史对照或验证基础设施；除非先证明新的生产调用方，否则不得把其中的策略描述成当前产品行为。

`src-tauri/src/harness/permissions.rs` 当前是一个路径命名例外：生产 Shell 执行和 Harness 都复用其中的 `PermissionGuard`。它的生产权限校验职责属于 Rust 受信任执行边界，不能因为目录名含 `harness` 就把用户审批后的最终命令校验降为测试专用逻辑。

## 生产调用链

工作区提交进入 TypeScript 后，生产执行链为：

1. Workspace 接纳先创建稳定的 `clientSubmissionId`、receipt、`turnId`、用户块和回合标题，并把新 Turn 写入 Session/FIFO。
2. `startSubmitAsyncWorkflowRun()` / `runSubmitAsyncWorkflowRun()` 接管已持久化的提交，`submitRuntimeRunner.ts` 按 admission intent 选择 Runtime v2 runner。
3. Runtime v2 runner 建立或恢复 exact-owner checkpoint，`RuntimeV2Controller` 与 ports 维护 Run、审批、计划续跑、工具执行和最终投影。
4. provider adapter 执行 provider-neutral 请求和标准 tool-call 协议；Execute 使用可重复的 inspect-edit-verify 工具面，Plan 只产生待审核 artifact。
5. Plan artifact 经共享 typed ingress/commit 后暂停待审；批准后的执行仍由 Runtime v2 Execute 消费批准 authority，不从 UI Markdown 猜测权限。
6. 工具通过 TypeScript IPC 进入 Rust；已经迁移到统一边界的入口再做路径、Shell、网络、超时与进程回收校验。工具结果进入结构化证据账本。
7. canonical Turn 状态、审批、Plan artifact、证据与兼容事件回到 Session 投影；ChatArea、进度胶囊和时间线只从这些结构化事实渲染。

“Chat / Plan / Fast”只改变策略和工具暴露，不改变工作区提交的身份：工作区会话中每次用户提交都是一个 Turn。

## Provider-neutral Plan 边界

Runtime v2 Plan 使用一条较小的单向权威链：

```text
Turn intake
  -> 有界只读取证
  -> submit_runtime_v2_work_plan
  -> WorkPlanDraftV1 校验与 seal
  -> RuntimeV2PlanReviewCommit
  -> Markdown / PlanPanel 投影
  -> pending_review
```

- `src/lib/runtime-v2/workPlan.ts` 的 `SealedWorkPlanV1` 与 `RuntimeV2PlanReviewCommit` 是当前审批权威。Markdown 只从 sealed plan 单向生成，不反向解析为权限。
- native tool、结构化 response 和文本 transport 最终必须进入同一个 WorkPlan 校验器。provider 名称、隐藏 reasoning 和普通正文没有审批状态权威。
- Plan runner 只读取和提交待审计划；批准后由 Runtime v2 Execute 使用 exact plan identity、scope 和 validations。Plan 本身不写项目文件。
- Plan 候选结构无效时可以带着明确 issue 修订；固定轮数或字符数只能保护单次资源，不能把未提交计划伪装成成功。

Provider adapter 的职责到“能力检测、请求/响应形状、stream、图片、native tool 与文本 fallback”截止。它不能决定 Plan 是否合格、是否进入审核、任务是否完成或 Turn 的终态。

## 证据与协作边界

MAIN 使用同一套结构化证据规则贯穿规划和执行，但保留不同阶段的持久化形状：

- 规划阶段把成功的只读结果规范化为带 path/version 的 `WorkPlanRuntimeEvidence`。模型只能引用 runtime 已签发的 evidence ID；普通摘要和未覆盖路径不成为事实。
- Execute 把 source、mutation 与 validation 记录进当前 Turn aggregate。批准计划的 scope/validation 仍是 authority；直接 Execute 至少保留不可变用户目标和最终修改后的行为验收要求。
- 完成由实际 mutation、最终 mutation boundary 后的匹配 validation 和 provider conclusion 共同投影。模型声称“已完成”、泛化工具成功或只启动服务都不能越过证据缺口。
- Execute 的普通工作区恢复使用稳定的读／改／验核心工具面；阶段状态只表达优先动作，不再把安全的相邻工具调用判成协议错误。软 no-progress 计数不改变工具权限，只能决定继续提示或诚实暂停。路径/权限、源码新鲜度、批准 scope、进程生命周期和证据闭包仍是硬门。
- 工具结果的具体因果 handler 先于通用 no-progress policy：真实修改和失败验证必须先推进下一次读取／修正／验证；重复或协议异常只产生软信号。
- 子智能体偏好只控制 `spawn_subagent` 是否可见以及提示强度。模型可在观察、修改或验证阶段按需派生最多两个活动的只读 `explore/review/validate` 任务；不存在开场自动派生或必需 scope。
- child 用普通最终文本结束只读工作；runtime 只有在结果引用至少一条真实或合法继承 evidence 时才编译合法报告并记为 `completed`。已有 evidence 但未形成合法报告时记为 `degraded` 并交回主体；无 evidence 才是 `failed`。父线程显式 wait 或终态 join 后接收结果；任何非 completed child 都不能阻断父线程，child 结果不能授权修改或凭自身关闭不匹配的验收。

Plan evidence、child evidence 与 Execute evidence 可以有不同持久化形状，但共享 identity、path/version、provenance 和“不从摘要制造事实”的规则。Rust 仍只负责 opaque snapshot CAS。

## 核心实体

- **Workspace**：文件与命令的安全根目录，也是 Session 的持久化分区。
- **Session**：同一工作区内的上下文、Turn、运行时投影与恢复状态。
- **Turn**：一次已接纳的用户提交；拥有稳定 `turnId`，最终必须产生一个 `turn.completed`。
- **Run**：为推进同一 Turn 发起的一次执行尝试；审批后续跑、计划执行或恢复可以形成带 `parentRunId` 的后续 Run。
- **Item / Tool result**：Run 内的操作证据。工具可以失败，但工具失败不是应用级失败终态。
- **WorkPlan**：由原始目标、版本化只读证据和结构化 changes/validations 编译、密封的审批与执行权威；Markdown 只是用户可读投影。
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
