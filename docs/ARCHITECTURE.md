# MAIN 架构与唯一所有权

> 状态：现行规范
> 最后按代码核验：2026-07-19
> 若历史发布说明、旧截图或注释与本文冲突，以本文和当前测试为准。

MAIN 采用一个产品运行时、一个受信任执行边界和一个确定性验证边界。任何生命周期规则只能有一个所有者，不能在 TypeScript 与 Rust 中各实现一套策略。

## 唯一所有权

| 边界 | 唯一所有者 | 当前代码入口 | 不负责 |
| --- | --- | --- | --- |
| 用户意图、计划、模型循环、恢复策略 | TypeScript | `src/store/submitAsyncWorkflowRun.ts`、`src/store/submitWorkflowEngineRunner.ts`、`src/lib/orchestrator/workflowEngine.ts`、`src/lib/orchestrator.ts`、`src/lib/orchestrator/loop/AgentOrchestrator.ts` | 最终文件系统、Shell、网络与进程安全 |
| 审批请求、Context、Session 语义、Workspace Turn 接纳/FIFO、执行尝试所有权、续跑和 UI 可见状态 | TypeScript | `src/store/useAppStore.ts`、`src/store/workspaceTurnQueue.ts`、`src/store/submitRunLease.ts`、`src/lib/turnEvents.ts`、`src/lib/runTransitionReducer.ts` | 执行未经 Rust 复核的命令；把业务状态裁决委托给 SQLite |
| 文件、Shell、PTY、应用管理的网络请求和 Session 快照存储机制 | Rust | `src-tauri/src/lib.rs`、`src-tauri/src/trusted_execution.rs`、`src-tauri/src/network_guard.rs`、`src-tauri/src/harness/permissions.rs`、`src-tauri/src/session_store.rs` | 重新判断用户意图、计划、队列状态、Run 所有权、transcript 合并或模型恢复策略 |
| Trace、Replay、Golden、Eval 和回归夹具 | Rust Harness | `src-tauri/src/harness/`、`src-tauri/src/runtime/`、`src-tauri/src/eval/`、`benchmark/` | 推进生产会话的模型循环 |

Rust `RuntimeLoop` 与 `runRuntimeHarness()` 当前是验证基础设施，不是生产 Agent 循环。除非先证明生产调用方已经迁移，否则不得把其中的策略描述成产品运行时行为。

`src-tauri/src/harness/permissions.rs` 当前是一个路径命名例外：生产 Shell 执行和 Harness 都复用其中的 `PermissionGuard`。它的生产权限校验职责属于 Rust 受信任执行边界，不能因为目录名含 `harness` 就把用户审批后的最终命令校验降为测试专用逻辑。

## 生产调用链

工作区提交进入 TypeScript 后，生产执行链为：

1. `startSubmitAsyncWorkflowRun()` / `runSubmitAsyncWorkflowRun()` 接管已持久化的提交。
2. `runSubmitWorkflowEngine()` 建立工作流执行环境。
3. `workflowEngine.ts` 维护 Run、审批、计划续跑与最终投影。
4. `AgentOrchestrator` 执行 provider-neutral 模型循环并选择工具。
5. 工具通过 TypeScript IPC 进入 Rust；已经迁移到统一边界的入口再做路径、Shell、网络、超时与进程回收校验。
6. 结构化事件回到 Session 投影；ChatArea、进度胶囊和时间线从同一事实源渲染。

“Chat / Plan / Fast”只改变策略和工具暴露，不改变工作区提交的身份：工作区会话中每次用户提交都是一个 Turn。

## 核心实体

- **Workspace**：文件与命令的安全根目录，也是 Session 的持久化分区。
- **Session**：同一工作区内的上下文、Turn、运行时投影与恢复状态。
- **Turn**：一次已接纳的用户提交；拥有稳定 `turnId`，最终必须产生一个 `turn.completed`。
- **Run**：为推进同一 Turn 发起的一次执行尝试；审批后续跑、计划执行或恢复可以形成带 `parentRunId` 的后续 Run。
- **Item / Tool result**：Run 内的操作证据。工具可以失败，但工具失败不是应用级失败终态。

详细状态机见 [运行时生命周期](RUNTIME_LIFECYCLE.md)，持久化见 [Session 持久化](SESSION_PERSISTENCE.md)。

## 不可破坏的架构规则

1. TypeScript 决定做什么；Rust 对已经接入受信任执行边界的具体本机或网络操作做最终 fail-closed 校验。该边界不是 OS 级进程沙箱。
2. UI 不从助手措辞、异常字符串或工具 stderr 推断完成状态。
3. 应用层没有 `run.failed` 或 `turn.failed`；错误是 `completed` 的一种 `resultKind`。
4. `run.paused` 与 `run.aborted` 都不是终态。只有 `run.completed` 和 `turn.completed` 是各自层级的结论事件。
5. TypeScript 是 Workspace Turn 队列、接纳凭证、恢复协调、执行尝试所有权和 partial transcript 合并的唯一语义所有者；Rust SQLite 负责 opaque snapshot revision CAS、存储 envelope、读时 transcript 分页投影与 legacy import，但 `save_project_session` 不得解析或改写 `messages`、`runtimeSnapshot`、Harness marker 或生命周期状态。
6. Rust Harness 用同一结构化结果契约验证执行语义，但不得复制生产模型循环的策略所有权。

## 修改路由

- 意图误判、计划续跑、重复读取、无响应恢复：修改 TypeScript 编排层。
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
