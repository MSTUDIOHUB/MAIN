# MAIN 运行时生命周期

> 状态：现行规范
> 事实源：`src/lib/turnEvents.ts`（事件 schema v2）及其生产调用方。

## 一条提交就是一个 Turn

在工作区会话中，用户每次提交都会先获得稳定的提交身份、接纳凭证和 `turnId`，然后才进入意图与执行策略。`Chat` 只是 Turn 的一种策略，不能绕过 Turn 接纳、持久化、取消或结论投影。

重试同一客户端提交时，`clientSubmissionId`、receipt 与 `turnId` 用于幂等识别；它不是第二个 Turn。真正的新用户提交才创建新 Turn。

## 结论契约

应用层没有 `run.failed` 或 `turn.failed`。唯一的 Run 结论事件是 `run.completed`，唯一的 Turn 结论事件是 `turn.completed`；两者用相同的 `resultKind` 表达结果：

| `resultKind` | 含义 |
| --- | --- |
| `success` | 目标与必要验证均已完成。缺省 `resultKind` 仅为旧数据兼容，按 `success` 读取。 |
| `partial` | 已交付可确认结果，但仍有明确未完成部分。 |
| `blocked` | 当前 Turn 已给出受阻结论；阻塞条件与继续方式必须对用户可见。 |
| `error` | 发生错误并已给出错误结论。错误是结论种类，不是 `failed` 终态。 |
| `canceled` | 用户取消或取消屏障收口后的结论。 |

工具、Slash command、MCP 连接或进度项仍可使用操作级 `failed` 状态记录局部失败证据；这些状态不能代替 Run 或 Turn 结论。

## 合法事件序列

### 普通完成

```text
turn.started
  run.started
  item.* / progress.updated / approval.requested ...
  run.completed(resultKind)
turn.completed(resultKind)
```

一个 Turn 可以有多个有父子关系的 Run，但只能有一个被接受的 `turn.completed`。例如计划审阅 Run 暂停后，批准操作可以启动带 `parentRunId` 的执行 Run；这仍属于原 Turn 的连续执行。

### 暂停与续跑

```text
run.paused(reason, message)
...等待审批、外部状态或显式续跑...
run.started(parentRunId = pausedRunId) 或恢复当前执行链
...
run.completed(resultKind)
turn.completed(resultKind)
```

`run.paused` 是可恢复检查点，不是结论。它必须保留目标、已有证据、剩余工作、暂停原因和恢复条件。仅出现 `run.paused` 时，不得生成 `turn.failed`，也不得伪造成功结论。

### 取消

取消采用固定顺序：

```text
run.started
...执行、等待或审批...
run.aborted(reason)                 # 取消诊断/边界事件，非终态
run.completed(resultKind=canceled) # Run 结论
turn.completed(resultKind=canceled)# Turn 结论
```

`run.aborted` 用于停止控制、清理审批和记录取消原因；消费者不得把它当成 Run 结论。取消投影必须幂等，并且 UI 只能显示一个最终结论。

### 错误收口

```text
error / item.completed(status=failed) # 可选的局部证据
run.completed(resultKind=error)
turn.completed(resultKind=error)
```

捕获到异常、模型空响应、工具失败或重试耗尽后，运行时仍必须形成用户可读结论并完成 Turn，不能把异常留成永久“执行中”。

## 事件接受与幂等

`appendRuntimeEventWithResult()` 对生命周期候选返回：

- `committed`：首次接受；
- `idempotent`：同一身份和同一语义的重复事件；
- `conflict`：同一 Run 或 Turn 已有不同结论。

冲突事件不能再触发 UI、审批或 Session 副作用。刷新、恢复和重复 IPC 回调都必须经过同一幂等边界。

## 历史数据兼容

持久化的旧版 `run.failed` / `turn.failed` 只允许在读取边界出现。`normalizePersistedMainThreadEvent()` 将其转换为 `completed(resultKind=error)`；`withEventSchema()` 会拒绝在实时状态中创建旧失败事件。

只有读取兼容层可以认识旧事件。新代码、测试夹具和文档不得继续写入它们。

## UI 投影

- ChatArea 显示过程中可见说明和唯一最终答复。
- 进度胶囊显示当前 Run、暂停或结论状态。
- 时间线显示工具、命令和验证证据。
- 三个表面都读取结构化事件；不得从自然语言中的“完成”“失败”“暂停”推断生命周期。

状态恢复时，先恢复事件与 Run/Turn 身份，再恢复可见投影。历史 `run.aborted` 若缺少 Run 取消结论，读取边界会补成 `run.completed(canceled)`；若对应 Turn 也尚未收口，则必须由精确拥有该 Turn 的取消投影补出 `turn.completed(canceled)`，不能把 `run.aborted` 本身当作结论。

对所有已加载且有权威 `turn.completed` 结论的 Turn，恢复投影都保证 exactly one 非流式、非空 `assistant_final`，不以 Harness marker 是否存在为前提：最后一条 final 是权威，较早的重复 final 降为 `assistant_update`；若 final 缺失，则生成恢复结论并把新块加入该 Turn 的 `blockIds`，同时投影 `done` 与 completed runtime outcome。不得从其他 Turn 的相似文本借用最终答复。

Game Studio `local_fast` slash 也遵守同一可见结论契约：成功、错误和取消都必须产生唯一 `assistant_final`。bridge 在开始时捕获不可变的 Turn、receipt 和 user-block 身份；只有它们仍精确匹配时才在原 Turn 原位收口。如果异步工作期间 adoption 已漂移，bridge 保留原 Turn，另建带父 Run 身份的隔离 presentation-recovery Turn/Run，在其中投影最终说明；不得为补最终块而重跑 slash 命令或其本地副作用。

普通 local-fast append 只在仍拥有 `currentTurnId` 或当前没有 owner 时才清理全局输入、待决策和 generating 等控制面，不得覆盖异步期间新启动的 Turn。bridge 会把唯一 final、runtime outcome、`run.completed` 与 `turn.completed` 组成同一个原子内存投影，再执行有界的 Session 持久化屏障；队头 receipt 在该屏障被验证前保持 `dispatching`。

持久化不会无限占住回合：local-fast 对持久化采用有限次数重试，并让副作用持久化、终态投影与可见修复共享一个整体执行期限；真实 Project Session owner queue 也有独立的五秒 mutation lease，Rust CAS 的写入截止时间早于 JavaScript 队列释放时间。若持久化仍不可用，运行时发布明确标记为 `temporary` 的内存结论并释放当前执行 lease/FIFO，不把局部存储故障提升为应用级 `failed`。停止发生在本地副作用提交前时可以形成 `canceled`；副作用已经提交后，迟到停止不能把已确认结果改写成取消。

同进程若丢失 local-fast lease，分发器只会验证已有结论或生成隔离结论，不会再次调用 handler。真正冷恢复时，当前版本没有副作用前的 durable execution fence，因而无法无损区分“尚未执行”和“已经执行但结论未落盘”；所有仍未解决的 local-fast `queued` / `dispatching` receipt 都按 at-most-once 原则隔离为可见 `error` 结论（身份冲突时使用 recovery child）并退队，绝不自动重放副作用。用户可以用一个新 Turn 明确重试。要实现无损自动重试，必须先增加副作用前的持久化 execution fence，不能从现有快照猜测。

## 相关代码

- `src/lib/turnEvents.ts`
- `src/lib/runTransitionReducer.ts`
- `src/lib/canceledTurnProjection.ts`
- `src/store/sessionCancellationBarrier.ts`
- `src/lib/orchestrator/workflowEngine.ts`
- `src/store/submitAsyncWorkflowRun.ts`

持久化与接纳细节见 [Session 持久化](SESSION_PERSISTENCE.md)。
