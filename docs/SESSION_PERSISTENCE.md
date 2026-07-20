# MAIN Session 持久化与 Workspace Turn 接纳

> 状态：现行规范
> 事实源：`src/store/workspaceTurnQueue.ts`、`src/store/useAppStore.ts`、`src/store/submitRunLease.ts`、`src/lib/projectSessionMutationCoordinator.ts`、`src/lib/ipc.ts`、`src-tauri/src/session_store.rs` 与 `src-tauri/src/lib.rs` 的 project-session commands。

## 唯一所有权

Session 的“业务含义”和“存储机制”必须分开：

| 内容 | 唯一所有者 | 职责 |
| --- | --- | --- |
| `WorkspaceInstruction`、receipt ledger、`WorkspaceTurnQueueState`、FIFO、claim/ack/remove 与恢复协调 | TypeScript | 验证身份、推进队列、决定能否分发或重放 |
| Run 尝试身份与 Harness marker | TypeScript | 以精确 Session/Turn/Run 身份取得执行槽、建立 lineage，并防止旧尝试覆盖新 owner |
| partial transcript 补基线、按 ID 合并、`taskFlow` 同步与 message/turn count | TypeScript | 在同一 Session 保存队头完成 transcript 投影，再把完整快照交给 Rust CAS |
| Session 快照、revision CAS、存储 envelope、schema migration 与旧数据导入 | Rust | 不透明保存 TypeScript 生成的 JSON，维护 storage metadata，并在读路径提供 transcript 分页投影；不裁决生命周期语义 |
| Trace、Replay、Golden 与 Eval | Rust Harness | 验证确定性执行契约，不取得生产 Session 或模型循环所有权 |

Rust Session Store 不解析 `runtimeSnapshot.workspaceTurnQueue` 或 Harness marker，也没有生产语义的 outbox 或 Run lease。Rust `save_project_session` 不读取或合并 `messages`、`runtimeSnapshot.conversationTurns`、`transcriptPartial`，也不重算 transcript count；它只验证 snapshot 对象/id/revision，派生 `updatedAtMs`，投影顶层 storage envelope 并执行 opaque snapshot CAS。`load_project_session_page` 可以在读路径从已保存快照做 transcript 分页投影，legacy import 也可以转换旧形状，但两者都不能据此决定 Turn 是否接纳、分发、恢复或完成。队列或尝试规则只能在 TypeScript 实现一次，不能在 SQLite 中复制第二套状态机。

## 权威存储

启用 Session recording 时，桌面应用的 Session 权威存储位于应用数据目录：

```text
sessions/session-store.sqlite3
```

旧 JSON / JSONL Session 目录仅用于一次性导入。`legacy_workspace_imports` 记录工作区已经完成导入；导入后 SQLite 快照是该工作区的权威持久化副本，旧文件不参与双写或冲突裁决。

SQLite 连接启用 foreign keys、WAL、完整同步和 busy timeout。Schema 通过 `PRAGMA user_version` 与 migration 记录显式版本化；比当前程序更新的 schema 必须被拒绝，不能猜测兼容。

当前 SQLite schema version 是 2；Session JSON envelope 的 `storageVersion` 当前是 3。两者是独立版本，不能混用：前者控制数据库迁移，后者控制快照形状。

| 表 | 作用 |
| --- | --- |
| `session_snapshots` | 保存 `(workspace, session_id)` 的完整 JSON、单调 revision 与更新时间 |
| `legacy_workspace_imports` | 保存每个 workspace 的一次性旧数据导入标记 |
| `session_store_schema_migrations` | 记录存储 schema 迁移，不承载产品生命周期语义 |

schema v1 曾短暂创建 `workspace_turn_outbox` 和 `run_leases`。升级到 v2 时，这两张重复 TypeScript 语义所有权的表会被删除，同时保留 `session_snapshots`；新数据库不会创建它们。

因此 SQLite 只需要保存两类产品数据：

- `(workspace, session_id)` 对应的完整 Session JSON 快照及单调 revision；
- 每个 workspace 的一次性 legacy import 标记。

Workspace Turn 队列、receipt ledger、Conversation Turn、事件和 Harness marker 都是 Session JSON 内的 TypeScript 投影，不是 Rust 可独立修改的关系表。

关闭 Session recording 或 Session 被明确标为 temporary 时，接纳可以只保留在内存中；此模式不承诺进程重启恢复，UI 必须把 durability 区分为 `memory`，不能伪称已经落盘。瞬时保存超时也只能把本次投影降级为 `temporary`，不得永久改写用户的 `recordingDisabled` 策略；后续保存或新接纳可以修复持久化状态。

## 快照 CAS

TypeScript Session 对象携带 `storageRevision`。保存流程为：

1. 新 Session 使用 expected revision `0`；已有 Session 必须提交自己读取到的 revision。
2. Rust 在写事务中比较当前 revision。
3. 不匹配时返回结构化 `revision_conflict`；不允许静默覆盖。
4. 匹配时不透明保留 Session 业务字段，只投影 `projectId`、`workspaceRoot`、`storageVersion`、`storageRevision`、`storageStatus`、`updatedAtMs` 等 storage envelope，并把 revision 加一。
5. Rust 返回包含新 `storageRevision` 的 Session 对象。

`src/lib/ipc.ts` 串行化同一 `(workspace, sessionId)` 的进程内保存，并让后续排队保存使用前一次已确认的新 revision。调用者入队时已经落后于缓存的显式 revision 时，IPC 仍必须把陈旧值送给 Rust 拒绝；不能把陈旧内容自动“升级”为当前 revision。

同一 owner 的保存队列不能被永不返回的 IPC 永久占住。每次保存由 TypeScript mutation coordinator 分配有界 lease，并把略早于队列释放时间的 `mutationDeadlineMs` 交给 Rust。Rust Session Store 在取得连接、开始事务以及 commit 前检查该截止时间；过期返回 `deadline_exceeded` 并回滚，迟到写因此不能越过后续 save/delete/clear。若前一响应不确定，下一次保存先读 Rust 的权威 revision，再选择 expected CAS revision；权威代际只可单调前进，旧请求的迟到成功或失败都不能回滚或重新污染新 owner。

在该保存队头内，`projectSessionSaveNeedsTranscriptBase()` 遇到 partial transcript，或 incoming `messages` / `conversationTurns` 任一为空时，会先用 raw `load_project_session` 取完整 durable snapshot 和最新 revision。`prepareProjectSessionSnapshotForSave()` 再负责：

- partial transcript 按 row id 合并 root `messages` 和 `runtimeSnapshot.conversationTurns`；
- full 且非空的数组直接 replace；空 incoming 数组保留 durable history；
- 同步 `runtimeSnapshot.taskFlow`、`messageCount` 和 `turnCount`；
- 把完整快照和队头当时的 expected revision 交给 Rust CAS。

Rust CAS 只裁决“这是不是基于当前快照的写入”；TypeScript transcript 合并也不能据此裁决 JSON 中哪条 Turn 应该排队、分发或完成。

## Workspace Turn 的持久化接纳

工作区用户提交在执行前由 TypeScript 建立稳定身份：

- `clientSubmissionId`：同一客户端提交的幂等键；
- `receiptId`：接纳凭证；
- `turnId`：产品生命周期身份；
- `userBlockId`：UI 中对应的用户块；
- `sessionKey` 与 `sessionEpoch`：精确 Session owner。

接纳顺序如下：

1. `acceptWorkspaceInstruction()` 验证提交身份，创建 instruction、receipt、Conversation Turn、用户块与 ledger 条目。
2. `reduceWorkspaceTurnQueue(... append ...)` 把精确条目追加为 `persisting`。同一 Session 的接纳写入被串行化，后续条目不能越过队头。
3. `isProjectSessionAdmissionProjectionOwned()` 只允许 admission save 序列化与 `allowPersistingWorkspaceReceiptId` 精确匹配的唯一 `persisting` 条目；普通 autosave、错误 receipt 或多个 `persisting` 条目会在 TypeScript 队列头被 fence。通过后，TypeScript 才把完整 `runtimeSnapshot` 交给 Rust 做 Session revision CAS 保存；Rust 不提取或解释队列字段。
4. 保存成功就是持久化接纳点。TypeScript 随后执行 `commit`，把条目推进为 `queued` 并触发分发。
5. 如果保存已经成功、但 UI owner 在内存 `commit` 前切换，持久化的 `persisting` 条目仍算已接纳；下次精确 Session 恢复会把它协调为 `queued`，调用方不得重发并制造第二个 Turn。
6. 保存失败时只回滚身份完全匹配且仍为 `persisting` 的条目。只要精确内存 owner 仍存在，就用 `run.completed(error)`、`turn.completed(error)` 和可见最终说明收口；不能生成应用级 `failed` 终态。

Chat、Plan、Fast、Slash command 或模型是否需要工具都不能绕过这条接纳路径。工作区中每次用户提交都是 Turn。

## TypeScript FIFO 状态机

队列只使用以下持久化状态：

```text
persisting -> queued -> dispatching
                ^           |
                +-----------+  release
                            |
                            +-> removed  ack 或精确终态清理
```

- `claim` 只能取得 FIFO 队头，不接受用于跳过队头的 submission id。
- 队头是 `persisting` 或已被其他 claim 标为 `dispatching` 时，后续 Turn 不能越过它。
- claim token 包含 `claimId`、`sessionKey`、`sessionEpoch` 与 `claimedAt`；release、ack 和 remove 必须匹配精确 owner。
- `ack` 表示精确 Turn/Run adapter 已取得该 instruction；`remove` 只用于精确终态 owner 的清理。两者都只能移除当前已 claim 的队头。
- reducer 使用显式 `expectedVersion` 与事件时间，返回 `applied`、`idempotent` 或 `rejected`，从而可做确定性测试和回放。

## 重启恢复

`reconcileWorkspaceTurnQueueOnRestore()` 是队列恢复的唯一语义入口：

- 只接受与当前 `sessionKey` / `sessionEpoch` 精确匹配且 schema、身份、时间有效的快照；
- 保留原 FIFO 顺序；
- 把持久化的 `persisting` 或 `dispatching` 协调为无 claim 的 `queued`；
- 丢弃已经被精确 Run/Turn owner 接管或已经形成结论的条目；
- 不采用其他 Session、其他 epoch 或只凭相似文本推断的事件。

因此，进程退出不会把 Turn 变成“失败”。恢复方必须继续执行，或形成合法的 `turn.completed(resultKind=...)` 结论。

### local-fast 的 fail-closed 恢复

local-fast 命令可能产生不可逆的本地副作用。当前快照在 handler 前没有 durable execution fence，所以冷启动时即使磁盘仍显示 `queued`，也不能证明该命令从未执行。真实 Session hydration 因而在通用队列规范化之后执行一层 local-fast 隔离：

- 已有 exact canonical final、runtime outcome、唯一且有序的 `run.started -> run.completed` 与 `turn.completed` 时，只验证并退队；
- 只有部分可信终态时，在不改变 owner 的前提下补齐同一 Run 的缺失证据；
- Turn、receipt、payload 或 parent identity 冲突时，不改写 replacement，而是建立带 source lineage 的 recovery child；
- 没有可信执行结论的 `queued` 或 `dispatching` local-fast receipt 形成可见 `completed(resultKind=error)` 隔离结论并退队；handler 不会被自动重放。

这是显式的 at-most-once 选择：它可能把崩溃前确实尚未执行的命令也隔离为 error，但不会静默重复一个可能已经完成的副作用。用户重试必须是新的提交和新 Turn。未来若要同时实现无损恢复与自动重试，需要先持久化副作用前 execution fence；不能仅修改恢复启发式。

## Run 尝试所有权

`src/store/submitRunLease.ts` 中的 attempt lease 是进程内 TypeScript 协议，不是 Rust 数据库租约：

1. 根据当前 Session、Turn 和已有 Harness marker 建立 `runId` / `parentRunId` lineage。
2. 用调用者看到的 expected marker 做 identity CAS；如果更新的 owner 已经取得全局槽，旧 bootstrap 以 `HARNESS_RUN_LEASE_OWNER_LOST` 停止，不能覆盖新 owner。
3. marker、消息索引、意图和计划阶段随 Session runtime snapshot 持久化，用于精确恢复与诊断。
4. marker 只是尝试所有权和恢复证据，不是完成事实；结论仍只能来自结构化 `run.completed` / `turn.completed`。

不要把这里的 Harness marker 与 Rust Harness 混为一谈：前者属于生产 TypeScript Session，后者只负责确定性验证。

## Tauri Session 接口

Rust 暴露的产品 Session 接口只有快照/分页/删除边界：

- `list_project_sessions`
- `rebuild_project_sessions_index`
- `save_project_session`
- `load_project_session`
- `load_project_session_meta`
- `load_project_session_page`
- `delete_project_session`
- `clear_project_sessions`

存储错误必须以稳定 code 处理：`invalid_input`、`revision_conflict`、`deadline_exceeded`、`corrupt_data`、`unsupported_schema`、`database_busy`、`database`、`io` 与 `lock_poisoned`；调用方不能匹配本地化 message。最终字段名以 `SessionStoreError` 的序列化契约为准。

## 恢复验收

每次修改 Session 接纳或恢复时至少验证：

1. 两个从 revision N 构造的排队保存按 N、N+1 落盘；已知陈旧调用仍被 CAS 拒绝。
2. Rust 往返后 Session 业务字段不丢失；只有 storage envelope 可规范化，`messages`、`runtimeSnapshot`、队列、marker 和生命周期投影均不得被 Rust save 改写。
3. 保存前只有精确 `persisting` 条目可回滚；保存成功后的 owner 切换不会要求客户端重发。
4. 同一 Session 的 Turn 严格 FIFO，不能跨越 `persisting` 或 `dispatching` 队头。
5. 普通可恢复工作可把未完成 claim 重新排队；冷恢复中的 unresolved local-fast 一律隔离并退队，不重放 handler。
6. attempt marker CAS 会拒绝陈旧 owner；重启恢复不会重复用户块、Turn 或最终结论。
7. local-fast 结论快照必须已包含唯一 final、runtime outcome、`run.completed` 和 `turn.completed`；adoption 漂移时只能新建隔离的 presentation-recovery Turn/Run，不得关闭原 Turn 或重跑本地副作用。

生命周期语义见 [运行时生命周期](RUNTIME_LIFECYCLE.md)。
