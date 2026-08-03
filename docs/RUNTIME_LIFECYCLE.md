# MAIN 运行时生命周期

> 状态：现行规范
> 事实源：`src/lib/turnRuntimeContract.ts`、`src/lib/turnRuntimeCheckpoint.ts`、`src/lib/turnEvents.ts`（兼容事件 schema v2）及其生产调用方。
>
> Workspace Turn 的当前执行策略入口是 `src/store/submitRuntimeRunner.ts` 与
> `src/store/runtimeV2/`。本文件描述 canonical Session/Turn/Run 与 UI 投影；
> Runtime 内部循环的修改边界见 [最小运行内核与能力边界](RUNTIME_KERNEL_INVARIANTS.md)。

## 一条提交就是一个 Turn

在工作区会话中，用户每次提交都会先获得稳定的提交身份、接纳凭证和 `turnId`，然后才进入意图与执行策略。`Chat` 只是 Turn 的一种策略，不能绕过 Turn 接纳、持久化、取消或结论投影。

接纳同时创建用户块与非空回合标题；标题可以随后语义优化，但第一轮日志、侧栏和执行投影不能因为尚未取得模型标题而退化成无 Turn 的聊天消息。

重试同一客户端提交时，`clientSubmissionId`、receipt 与 `turnId` 用于幂等识别；它不是第二个 Turn。真正的新用户提交才创建新 Turn。

## 执行中的 Queue 与 Guide

active Run 存在时，Composer 输入有两条不同的 ingress，不能用一个模糊“发送”动作同时承担：

| ingress | 是否创建 Turn | 身份与持久化 | 约束 |
| --- | --- | --- | --- |
| Queue | 是 | 按普通 Workspace instruction 创建 receipt、`turnId`、用户块和标题，进入 durable FIFO；当前 Run 结束或释放队头后再执行 | 可携带附件、图片和显式 Plan/Goal 等新意图；active Run 中回车默认选择 Queue |
| Guide | 否 | 创建绑定当前 `turnId` 的一次性 `activeGuidance`，在当前 Run 下一次模型迭代前消费 | 仅文本；必须有 running Run；不能承载附件、图片或需要独立生命周期的显式意图 |

`src/lib/turnRuntimeContract.ts` 的 `decideTurnIngress()` 定义 canonical 决策：普通 `submit` 遇到 open Turn 时必须拒绝为 `active_run_requires_explicit_ingress`；`queue` 始终接纳新 Turn；`guidance` 只可附着于 exact running Run。UI 的两个按钮和 Store 的 FIFO/`activeGuidance` 是该语义的产品适配，不能把 Guide 伪装成历史 user Turn，也不能让 Queue 修改当前 Run 的上下文。

Guide 在 `iterationStreamPreparation.ts` 中被消费后以明确的 runtime-guidance user message 注入，语义是“高优先级下一步方向，不重启任务”。它不改变原 Turn 的 objective、identity 或 terminal contract。Guide 的接纳与当前 Run 终态提交使用同一个 exact-owner fence：若 guidance 在当前 provider 请求期间被接纳，runtime 必须执行一次有界的额外模型迭代再尝试收口；若终态 CAS 已先获胜，Guide 接纳必须失败并保留输入，让用户可改为 Queue，不能静默清除迟到 guidance。

## Canonical Turn/Run 状态

`turnRuntimeContract.ts` 是不依赖 React、Store、provider 或 executor 的纯 reducer。canonical checkpoint 从有序事件回放，事件的 application sequence 是权威；时间戳相同也不能重排。

核心身份 fence 包括：

- Turn：`workspaceKey + sessionKey + sessionEpoch + clientSubmissionId + turnId`；
- Run：`sessionKey + sessionEpoch + turnId + runId + parentRunId + attemptId`。

迟到 callback、被替换 attempt、其他 Session/epoch 或相似文本都不能推进当前状态。兼容的 `turnEvents.ts` envelope 仍用于现有时间线与持久化消费者，但只能从 canonical transition 投影，不能反向覆盖 canonical state。

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
turn.admitted
  run.started
  item.* / progress.updated / approval.requested ...
  run.completed(resultKind)
turn.completed(resultKind)
```

一个 Turn 可以有多个有父子关系的 Run，但只能有一个被接受的 `turn.completed`。例如计划审阅 Run 暂停后，批准操作可以启动带 `parentRunId` 的执行 Run；这仍属于原 Turn 的连续执行。

`turn.admitted` 是 canonical contract 名称；兼容事件层可以继续保留既有 `turn.started` 展示/存储形状，但两者表示同一个已接纳 Turn，不能形成两次接纳。

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

## Plan authoring 与审核态

Plan Run 保留原始 objective，先用只读工具形成带版本的
`WorkPlanRuntimeEvidence`，再让模型提交 `WorkPlanDraftV1`。后续校验只能指出
同一 draft 的结构、证据引用、目标、依赖或验证问题；修正版必须重新进入同一个
WorkPlan compiler，不能只留在 hidden reasoning 或过程文本中。

Plan 的 canonical 顺序为：

```text
turn.admitted(strategy=plan)
  run.started(phase=planning)
  bounded read-only gather
  submit_runtime_v2_work_plan
  WorkPlan compiler -> seal -> Markdown/PlanPanel projection -> review commit
  plan.artifact_accepted(path, digest, revision)
    run.status = paused
    run.phase = reviewing
    planReviewStatus = pending
    pause = approval / subject=plan
```

此时唯一合法 UI 兼容投影是：

```text
agentStatus = pending_review
conversationTurnStatus = awaiting_approval
isTerminal = false
```

`plan.artifact_accepted` 不生成 `run.completed` 或 `turn.completed`，也不能被通用 done/idle 收尾覆盖。它只有在 `.MAIN/plans/plan.md`、sealed WorkPlan/digest、ActionRequest、Plan lifecycle、Run 与 checkpoint identity 全部一致时才具有可批准权威。

- `changes_requested`：同一 Run 回到 `planning`，保留原始用户目标和已有版本化证据；新的 WorkPlan 通过同一 compiler 后替换 review artifact/revision。
- `approved`：review Run 转为 `recoverable` 暂停，随后启动 `parentRunId = reviewedRunId` 的执行 child Run；批准不等于执行成功。
- 取消审核：依照 canonical 取消顺序收口，不把 `pending_review` 留成 done/idle。

Markdown 只负责审核显示。批准后任务和验证从 sealed typed graph 的 `C/D/V` 节点派生，禁止重新解析 Markdown 生成另一套执行真相。

## Execute 的稳定工具面

普通工作区 Execute 使用一个稳定且有界的读／改／验核心工具面。阶段只表示当前证据重点，不通过切换互斥 schema 撤掉安全读取或强制某一个修改工具；模型可以按当前源码事实自然地在精确读取、结构化修改和有限验证之间循环。路径授权、修改前源码版本绑定、批准 WorkPlan scope、命令权限和完成证据仍由 runtime 硬门控制。

浏览器、桌面和长驻进程生命周期保留各自的结构化启动、观察、交互和清理边界，因为 `launch -> observe -> interact/assert` 的顺序是真实安全与因果约束。它们不能被普通文件阶段用来重新引入 `read-only -> mutation-only -> validation-only` 振荡。child evidence 是只读参考；父线程修改目标前仍以自己的当前版本读取作为写入依据，不需要另造 `context_restore` lease。

每批工具结果先形成真实 source、mutation、validation、browser/desktop 或 Goal evidence，再考虑重复和协议软信号。软信号可以要求换动作、刷新事实或压缩上下文，但不得暂停、锁死目标或生成终态。修改目标的排他依据只有 exact path 的当前版本读取和 mutation preflight；不存在从模糊诊断猜出的 transaction lock。

普通 Execute 没有从 Turn 接纳时刻开始计算的总耗时上限。持续流式输出、有效模型决策、工具动作、证据、修改或验证都允许任务继续，无论本地硬件使单步或整轮耗时多久。10 分钟只表示“连续没有形成可执行进展”的恢复停滞窗口；它不取消正在运行的慢请求，并会在下一条有效动作或证据处清零。模型流的无响应头、无首 chunk 或 chunk 间长期静默仍由单请求 watchdog 处理，该请求失败后回到共享恢复循环，不能直接把 Turn 判为超时。

Root objective closure audit 只恢复可选的稳定工作区能力面（有界读／搜／编辑／有限命令），不重新开放长驻进程、PTY、浏览器或桌面能力。后四类能力必须由各自的结构化生命周期 checkpoint 重新开启，避免已经成功的有限验证在最终核对阶段漂移成无关的交互终端循环。

## Evidence ledger、typed validation 与完成门

Plan 取证形成带 path/version 的 `WorkPlanRuntimeEvidence`；只有成功的真实只读结果可成为 `E`，模型摘要或未验证假设不能替代它。引用 evidence 的 WorkPlan 与 source observation 是同一个 provenance 链，裁剪或迁移时禁止生成悬空 ID。

批准后的真实操作进入当前 Runtime v2 Turn aggregate。source、mutation 和 validation 保留有序因果关系；相同毫秒时间戳不能重排“修改后验证”。直接 Execute 不借用 Plan 权威，但仍必须保留原始用户目标，并且只有最终修改之后的匹配验证可以形成成功。

typed validation primitive 的完成语义如下：

| primitive | 是否可关闭 required acceptance | 必要证据 |
| --- | --- | --- |
| `finite_command` | 是 | exact command/cwd obligation 的 `run_command` 完成，有限结束、未超时且 exit code 0 |
| `service_observation` | 否 | exact owner 的 PTY/服务状态；ready/running 只是前置观察 |
| `browser_interaction` | 是 | 受支持 action 成功、post-action assertion 通过，要求时还需 causal link，且无相关 page/console error |
| `desktop_interaction` | 是 | 与 browser 分离的 desktop adapter action/assertion 结果 |
| `assertion` | 是 | exact target/matcher 和声明 producer 的 typed `assertion_result` |
| `advisory` | 否 | 仅提示用户、外部或 runtime 后续复核 |

批准计划的 success 要求所有声明修改目标和 required validation 均有匹配 evidence；直接 Execute 的 success 要求至少有真实 mutation、最终 mutation boundary 后的行为验收以及 provider 的事实说明。模型正文、无关成功命令、泛化文件读取或长驻服务已启动都不能宣告完成；存在缺口时必须继续循环或以 `partial/blocked/error` 诚实收口。

## 子智能体协作状态

用户允许或偏好子智能体时，runtime 在父 Run 仍活动且有剩余 provider 容量时向模型暴露 `spawn_subagent`。`preferred` 只表示鼓励独立工作，不强制开场派生。模型为具体 `explore`、`review` 或 `validate` 任务提供名称、目标、成功条件和只读路径；同时活动数量由实际 provider lane 容量决定，完成后立即释放容量。普通 Execute 不因总耗时关闭父 Run 或 child；只有用户取消、显式调用方预算或真实停滞/资源边界可以收口。

每个已派生任务的状态机是：

```text
spawn_subagent
  -> queued / running
  -> read/search/finite validation
  -> ordinary final text
  -> parent wait 或终态 join
  -> completed / failed / canceled
```

runtime 只在普通最终文本和至少一条真实或合法继承 evidence 同时存在时编译合法结构化报告并接受 `completed`。已有 evidence 但收口失败时写入 `degraded`，明确由主体接管；没有 evidence 才写入 `failed`，父任务取消则为 `canceled`。child summary、协调工具成功和未 join output 都不算验收；父智能体始终是唯一写入者，child 非 completed 后父线程继续原目标。

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

Plan 审核是 canonical state 的非终态投影：当 checkpoint 表明 `planReviewStatus=pending`、Run paused 且 `pause.subject=plan` 时，三个表面都必须保持 `pending_review / awaiting_approval`。任何表面显示 done/idle 都是投影缺陷，不能通过修改助手措辞解决。

状态恢复时，先恢复事件与 Run/Turn 身份，再恢复可见投影。历史 `run.aborted` 若缺少 Run 取消结论，读取边界会补成 `run.completed(canceled)`；若对应 Turn 也尚未收口，则必须由精确拥有该 Turn 的取消投影补出 `turn.completed(canceled)`，不能把 `run.aborted` 本身当作结论。

对所有已加载且有权威 `turn.completed` 结论的 Turn，恢复投影都保证 exactly one 非流式、非空 `assistant_final`，不以 Harness marker 是否存在为前提：最后一条 final 是权威，较早的重复 final 降为 `assistant_update`；若 final 缺失，则生成恢复结论并把新块加入该 Turn 的 `blockIds`，同时投影 `done` 与 completed runtime outcome。不得从其他 Turn 的相似文本借用最终答复。

Game Studio `local_fast` slash 也遵守同一可见结论契约：成功、错误和取消都必须产生唯一 `assistant_final`。bridge 在开始时捕获不可变的 Turn、receipt 和 user-block 身份；只有它们仍精确匹配时才在原 Turn 原位收口。如果异步工作期间 adoption 已漂移，bridge 保留原 Turn，另建带父 Run 身份的隔离 presentation-recovery Turn/Run，在其中投影最终说明；不得为补最终块而重跑 slash 命令或其本地副作用。

普通 local-fast append 只在仍拥有 `currentTurnId` 或当前没有 owner 时才清理全局输入、待决策和 generating 等控制面，不得覆盖异步期间新启动的 Turn。bridge 会把唯一 final、runtime outcome、`run.completed` 与 `turn.completed` 组成同一个原子内存投影，再执行有界的 Session 持久化屏障；队头 receipt 在该屏障被验证前保持 `dispatching`。

持久化不会无限占住回合：local-fast 对持久化采用有限次数重试，并让副作用持久化、终态投影与可见修复共享一个整体执行期限；真实 Project Session owner queue 也有独立的五秒 mutation lease，Rust CAS 的写入截止时间早于 JavaScript 队列释放时间。若持久化仍不可用，运行时发布明确标记为 `temporary` 的内存结论并释放当前执行 lease/FIFO，不把局部存储故障提升为应用级 `failed`。停止发生在本地副作用提交前时可以形成 `canceled`；副作用已经提交后，迟到停止不能把已确认结果改写成取消。

同进程若丢失 local-fast lease，分发器只会验证已有结论或生成隔离结论，不会再次调用 handler。真正冷恢复时，当前版本没有副作用前的 durable execution fence，因而无法无损区分“尚未执行”和“已经执行但结论未落盘”；所有仍未解决的 local-fast `queued` / `dispatching` receipt 都按 at-most-once 原则隔离为可见 `error` 结论（身份冲突时使用 recovery child）并退队，绝不自动重放副作用。用户可以用一个新 Turn 明确重试。要实现无损自动重试，必须先增加副作用前的持久化 execution fence，不能从现有快照猜测。

## 相关代码

- `src/lib/turnEvents.ts`
- `src/lib/turnRuntimeContract.ts`
- `src/lib/turnRuntimeCheckpoint.ts`
- `src/lib/runTransitionReducer.ts`
- `src/lib/runtime-v2/`
- `src/store/runtimeV2/`
- `src/lib/canceledTurnProjection.ts`
- `src/store/sessionCancellationBarrier.ts`
- `src/store/submitRuntimeRunner.ts`
- `src/store/submitAsyncWorkflowRun.ts`

持久化与接纳细节见 [Session 持久化](SESSION_PERSISTENCE.md)。
