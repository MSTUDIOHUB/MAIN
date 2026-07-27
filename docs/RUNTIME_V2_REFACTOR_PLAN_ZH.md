# MAIN Runtime v2 重构计划与实施记录

> 状态：结构重构与合并前验收已完成
>
> 分支：`codex/runtime-v2`
>
> 基线：`e52561b`
>
> 实施原则：单一事实源、有限恢复、稳定能力面、投影分层、减法优先

## 1. 重构目标

Runtime v2 不以“让某一个模型在某一条指令上必然输出固定答案”为目标。它解决的是更底层的问题：

1. 无论本地模型能力强弱或输出如何变化，运行时都提供可继续的阶段、工具和证据。
2. 生命周期只由结构化事件和持久化事实推进，不从模型自然语言猜测“完成、暂停或失败”。
3. Plan、审批、Execute、恢复和终局只有一条所有权链。
4. 超时、重复、跑偏或工具失败必须在有限预算内收敛到一个真实终局，不能把永久暂停留给用户。
5. Capsule、ChatArea、Timeline 和 PlanPanel 各自拥有不同信息，不互相复制。
6. 删除旧执行所有者和重复恢复路径，避免新旧引擎并存。

## 2. v1 的根本问题

v1 的问题不是缺少某一个条件分支，而是责任被拆散在多个可写所有者中：

- orchestrator loop、workflow engine、Plan 恢复器和 Store 都可能推进生命周期；
- 模型说明、工具前言、UI 状态和持久化状态之间存在反向推断；
- 同一个动作可以被多个恢复入口再次调度；
- Plan 面板、`plan.md`、ChatArea 文本和执行任务可能来自不同版本；
- Capsule、ChatArea 和本地步骤可能消费同一段内容；
- 模型重复或超时后，恢复次数与恢复语义不一定落在同一账本；
- 子智能体“被建议使用”不等于实际并发执行。

继续在这些路径上添加特殊判断，只会增加状态组合，并不能形成稳定 loop。

## 3. Runtime v2 的目标架构

### 3.1 唯一运行事实源

Runtime v2 以 `TurnAggregateV1`、有序事件账本和 checkpoint 为唯一运行事实源：

```text
Composer admission
  -> Run lease
  -> preparing
  -> observing
  -> planning/reviewing 或 acting
  -> validating
  -> finalizing
  -> exactly one terminal outcome
  -> exactly one final projection
```

Controller 只负责提交命令和事件；Reducer 是唯一状态转移函数；Store 通过 ports 连接 provider、tool、checkpoint 和 UI，不再拥有另一套执行状态机。

关键实现：

- `src/lib/runtime-v2/contracts.ts`：稳定的 phase、command、result、projection 和 recovery 合同；
- `src/lib/runtime-v2/reducer.ts`：允许的状态转移与终局不变量；
- `src/lib/runtime-v2/controller.ts`：命令调度、幂等键和终局编排；
- `src/store/runtimeV2/checkpointPort.ts`：持久化边界；
- `src/store/runtimeV2/executeRunner.ts`：Execute 组合入口。

### 3.2 Plan 的单一来源

Plan 阶段只保留一次有界 discovery 和一次 synthesis。模型提交结构化 WorkPlan 后，运行时完成校验、封存和审批绑定。

封存后的 WorkPlan 是以下内容的共同来源：

- `plan.md`；
- PlanPanel；
- ChatArea 的计划里程碑；
- 审批请求的 revision、digest 和 artifact hash；
- Execute 的任务、修改范围和验证义务。

审批不会直接授予副作用权限。批准后的 child run 必须重新经过 Harness admission，并从 `preparing` 开始建立执行期证据，不能把 Plan 阶段的旧读取当成已完成的执行准备。

### 3.3 稳定工具能力面

provider 每轮看到的是稳定、阶段允许的工具集合。执行过一次读取不会导致读取工具从下一轮突然消失。

工具可用性与以下约束相互独立：

- 已批准的修改范围；
- 当前 source version；
- validation contract；
- 权限与风险审批；
- 有限恢复预算。

因此，运行时不会为了某个模型常见的调用顺序而动态删工具，也不会把模型文本当成能力协商协议。

### 3.4 有限恢复

恢复键只来自结构化事实：

- `transport`：provider 传输失败；
- `action`：相同动作重复；
- `context`：证据版本需要刷新；
- `diagnostic`：可修复的协议诊断。

每次恢复都有 fingerprint、epoch、次数和持久化 receipt。预算耗尽后必须生成 `partial`、`blocked` 或 `error` 终局，不再形成无限“继续尝试”或永久 paused。

### 3.5 子智能体协作

第一阶段协作只允许有明确 `allowedPaths` 的只读任务：

- 主体一次提交两个互不重叠的 child jobs；
- scheduler 必须真实并发启动，而不是串行模拟；
- 每个 child 有 request/open、first token、close 时间；
- join 只接收带 run/task/lease 身份的 evidence receipt；
- child 不能获得 mutation 能力；
- child 失败不会夺取主体终局所有权。

真实验收要求 `peakInFlight >= 2`、请求窗口重叠且只出现一次 join。

### 3.6 UI 信息分层

四个展示面消费不同 audience：

| 展示面 | 内容 | 不应出现 |
| --- | --- | --- |
| Capsule | 当前用户可见 live Markdown，或由结构化 tool/target 生成的一条实时动作 | 原始工具协议、任务跟踪摘要、旧动作、隐藏推理 |
| ChatArea | 已确认、去重、可保留的阶段里程碑和最终回复 | 每次读取前言、心跳、同一动作的重复说明 |
| Timeline / Run Status | 工具、目标、状态、证据、重复次数和健康信号 | 代替模型与用户沟通的长篇结论 |
| PlanPanel | 封存 WorkPlan 的任务、验证与证据状态 | 从 Chat 文案重新推导的任务 |

显式 Capsule `action` 会作为完整 Markdown 展示，不截断；兼容事件没有 `action` 时，只从结构化 tool/target 生成一句话。`summary` 留在 Run Status/Timeline，避免与 Capsule 重复。

### 3.7 会话边界

有工作区的新提交进入工作区 Session/Turn，不会因为“新会话”而降级成全局 Chat。只有没有工作区的普通对话才创建 Chat 会话。

## 4. 减法实施

本轮没有把旧 loop 包进兼容层，而是删除旧所有者：

- 删除 `src/lib/orchestrator.ts`；
- 删除 `src/lib/orchestrator/loop/*`；
- 删除 legacy `workflowEngine`；
- 删除只验证旧 loop 内部实现的大量测试和辅助脚本；
- 拆分 Plan 与 Execute 的 provider、authorization、evidence、scheduler、tool 和 settlement ports；
- `executionPorts.ts` 保持为小型组合入口，不重新承载策略。

相对基线，在加入本实施记录前共有 332 个文件变化，新增 26,703 行、删除 107,697 行，净减少约 8.1 万行。变化量主要来自删除旧 loop 和只服务旧内部实现的测试，而不是把相同逻辑搬到另一个超级文件。

架构守卫要求：

- Runtime v2 core/store 任一生产模块不得超过 800 行；
- Execute 和 Plan 的关键适配器不得超过 550 行；
- facade 不得重新包含运行策略；
- core 不得导入 React、Zustand、Tauri、Store 或 legacy orchestrator；
- Runtime v2 本地模块不得形成依赖环；
- Execute 适配器不得包含 provider/model 名称或事故专用文案；
- provider prose 不得选择生命周期。

## 5. 真实验收标准

### 5.1 结构验收

真实模型文本不是固定断言。一次执行满足以下条件即可证明 loop 结构成立：

1. Plan 经过封存和精确审批；
2. 批准后从 `preparing` 开始，而不是直接跳到副作用；
3. observation、child schedule、并发执行、join 和 acting 顺序成立；
4. provider 工具调用只能使用该轮实际提供的能力；
5. 重复或失败在预算内收敛；
6. 只有一个 terminal outcome；
7. 只有一个 final projection；
8. Capsule、ChatArea 和 Timeline 投影 audience 不混用。

### 5.2 任务质量验收

业务修复质量单独由语义 oracle 判断，例如 MD Viewer 的打开、初始 tab、dirty 状态、保存路径和 Save As 行为。该 oracle 不反向定义 runtime 是否合规：

- loop 合规但模型没有完成修改：Runtime 结构通过，业务任务未通过；
- 模型声称完成但没有修改或验证证据：业务任务失败；
- 不能因为模型换了一种说明文案而判定 Runtime 失败。

## 6. 验收记录

### 6.1 自动测试

- Node：`npm run test:workflow-assets`，2067 项通过；
- TypeScript：`npm run lint` 通过；
- 前端：`npm run build` 通过；
- Rust：`cargo fmt --check`、`cargo check`、`cargo test` 通过，159 项测试通过；
- Playwright：`capsule-process-folding.spec.ts` 与 `execution-capsule-progress.spec.ts` 共 40 项通过，覆盖 Capsule/ChatArea 分工、完整 Markdown、窄屏、light/dark/black、多种权限与 Plan 审批身份。

### 6.2 真实 OMLX

使用 OMLX 当前唯一已加载模型 `Qwen3.6-35B-A3B-6bit`，在每次新复制的 MD Viewer fixture 上执行同一真实问题。

两次运行均验证：

- Plan 审批后进入 `preparing -> observing -> acting`；
- 两个只读 child jobs 分别覆盖前端与 Tauri 范围；
- `peakInFlight = 2` 且请求窗口真实重叠；
- 只发生一次 join；
- 只有一个真实终局和一个 final；
- fixture 项目源码没有被错误测试逻辑预先修改。

第一轮暴露出“读取成功后移除读取工具”的能力面错误，已修复。第二轮不再出现 provider tool-surface 拒绝，但模型重复了相同读取，最终由 action repeat budget 生成一个真实 error 终局。

这说明结构化 loop、并发、恢复和终局已经跑通；它不等于该模型已经完成 MD Viewer 业务修复。当前语义 oracle 仍报告初始 tab、dirty 事件和保存路径相关缺口，因此不把这两次运行描述为业务修复成功。

### 6.3 临时记录清理

已从 `/private/tmp` 移出 28 个明确属于 MAIN Runtime v2、真实 OMLX 和 MD Viewer 验收的旧目录/记录，合计约 190 MB。保留唯一注册的 Runtime v2 worktree `/private/tmp/MAIN-runtime-v2`，没有触碰其他临时内容。

清理通过 macOS 废纸篓完成；这些项目已不再占用 `/private/tmp`，在废纸篓清空前仍可恢复。

## 7. Git 检查点

主要回退锚点：

- `a7513d6`：建立 Runtime v2 checkpoint；
- `e818342`：拆分 Execute adapter；
- `d710057`：拆分 Plan/Execute 协议；
- `1cbca20`：分离 live 与 milestone 投影；
- `19a9750`：审批后先准备再执行；
- `e3c7222`：真实协作验收；
- `f9d5f4b`：稳定 Execute 工具能力面；
- `078a664`：模块化验收边界；
- `84b8380`：Capsule live 投影去重。

原工作树中的用户修改没有被覆盖；实施在独立 worktree 与分支中完成，便于逐检查点对比或回退。

## 8. 完成定义

Runtime v2 的完成定义是：

- 旧执行所有者已删除；
- Plan、审批、Execute、恢复和终局只有一条结构化链；
- 所有恢复有限且可重放；
- 真实只读子智能体并发可观测；
- UI audience 边界有 Node 与 Playwright 双重守卫；
- 全量 Node/Rust/TypeScript/build 通过；
- 真实 OMLX loop 结构通过；
- 文档明确区分 Runtime 合规与模型业务修复质量。

后续若提升具体模型的任务完成率，应通过更清晰的通用工具合同、证据质量和评测集演进，而不是重新引入模型名称、事故语句或某条指令专用补丁。
