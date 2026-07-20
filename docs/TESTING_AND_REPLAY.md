# MAIN 测试、Trace 与 Replay

> 状态：现行规范
> 事实源：`src-tauri/src/harness/tracing.rs`、`src-tauri/src/runtime/`、`src-tauri/src/mcp/`、`src-tauri/src/eval/` 与 `benchmark/`。

## Rust Harness 的职责

Rust Harness 提供确定性执行、Trace、Replay、Golden 比较与 Eval，并复用生产 Rust 边界的 `PermissionGuard`。它不选择生产用户意图，也不取代 TypeScript Agent 循环；最终命令权限校验的生产职责不能被归给测试 Harness。

一次回归应先固化“第一处因果偏差”的最小结构化证据，再修 owning layer。不要用最终错误文案、空 stderr 或模型措辞判断成功。

## Trace schema v3

Workspace Trace 默认写入：

```text
.MAIN/traces/
```

文件名包含 task、全局递增 sequence、step 和 attempt；使用 `create_new`，同一 step 的重试不会覆盖先前记录。

`TraceRecord` 记录：

- `schemaVersion`、`runId`、`sequence`、`attempt`、task/step/event 身份；
- tool call 及 input/output SHA-256 digest；
- stdout、stderr、原始 `structuredOutput`、exit code、timeout；
- stdout/stderr 独立 truncation；
- 显式 `success` 与 `resultKind`；
- verification、latency、events 和结构化 metadata。

schema v3 新记录必须带执行级 `runId`；缺少 `runId` 只是旧 Trace 的读取兼容形态。MCP `inputDigest` 是 canonical JSON `{tool, arguments}` 的 SHA-256，`outputDigest` 是 canonical JSON `{content, stdout, stderr}` 的 SHA-256；canonical JSON 递归排序 object key，因此键插入顺序不会制造假差异，而结构化 content 的改变不会被文本流掩盖。

schema v1 只能从结构化 metadata 或明确 verification 标签恢复 success / `resultKind`；空 stderr 永远不能推断成功。显式结构化 `resultKind` 优先于与它矛盾的布尔 success，不能把 `success=true, resultKind=error` 读成任务成功。v1/v2 仍可读，但只有 v3 structured MCP Trace 具备完整的 content/digest 完整性校验。

## Run 结论记录

`RuntimeLoop` 的每条语义退出路径都必须先持久化且只持久化一条结论记录，再发布对应 Runtime event：

- `stepId = "__run_conclusion__"`；
- `eventName = "task_completed"`；
- `runId` 与该次执行的所有 tool Trace 相同；
- `resultKind = success | partial | blocked | error | canceled`；
- 结论记录的 `success=true` 表示“结论已成功发布”，任务结果由 `resultKind` 表示。

每次 RuntimeLoop 执行生成新的高熵 `runId`，该次所有 Runtime event payload 也必须带同一 `runId`。成功终端 step、planner 无步骤、planner 在非终端步骤后耗尽、task 身份错配和 retry 耗尽都必须经过这个唯一收口。Harness 基础设施本身无法写 Trace 等 I/O 错误是接口错误，不得伪造一条已持久化的任务结论。

## Replay

`TraceRecorder::replay(taskId)` 按 `(sequence, attempt, stepId)` 排序恢复该逻辑 task 的全部历史；它可能包含多个 Run。任意单次执行的 Replay 和比较必须用 `replay_run(taskId, runId)` 隔离，不能把同 task 的旧执行混入。`load_exact()` 用 task-global sequence 定位唯一记录，`load()` 只用于取某 step 的最新尝试。

### MCP 精确回放

新 MCP Trace 必须通过下列一种身份精确回放：

- `sequence`：在 `taskId` 内用 `load_exact()` 选择唯一不可变记录；
- `runId`：在该 Run 内选择指定 `stepId` 的最新 attempt。

`sequence` 和 `runId` 都缺失时，只允许查找 `runId=null` 的 legacy unscoped Trace；不得对新 Trace 使用跨 Run 的“最新 step”查询。新 MCP 执行用 `record_with_sequence()` 原子获得实际分配的 sequence，调用方不得在写入后再用 latest 查询“猜”刚才的记录。

Task Graph 的 run identity 必须是 graph 级，不是 node 级：`McpTaskGraphRunner::new()` 生成一个稳定 `graph_run_id`，`with_run_id()` 可接收调用方身份，所有 node Trace 共用该值。`TaskGraphExecution.runId` 把它返回给调用方，因此整张 graph 可用一个 `(taskId, runId)` 做 run-scoped Replay 和 Golden；不得为每个 node 随机生成不相关的 Run。

回放前必须同时验证 call / replay reference / record 的 task、step、tool、`eventName=tool_called`、可选 sequence/runId，以及 v3 的 input/output digest 和 `tool_result` 事件。任一身份或 digest 不匹配都必须拒绝，不能降级为宽松回放。

成功回放复用记录中的显式 success、`resultKind`、stdout/stderr 和原始 structured `content`，不用 replay metadata 覆盖工具结果；返回值同时标注 `runId`、`traceSequence` 和 `replayed=true`。一个 stdout/stderr 都为空的失败记录仍必须 replay 为失败，不能因为“没有错误文本”变成成功。

unknown tool、参数/执行错误和权限拒绝都是 `success=false` 的结构化操作结果，仍必须持久化 Trace；权限拒绝的操作 `resultKind=blocked`。只有 Trace 持久化/读取错误或回放身份完整性失败才从 MCP 接口返回 `Err`。这些都是 Harness / operation 边界，不会创建应用级 `run.failed`。

`runRuntimeHarness()` / `run_runtime_harness` 接收固定 steps、验证命令、重试和超时设置，返回 Run 结论、Context、Trace 与 Runtime events。该接口用于 conformance，不是生产模型流量入口。

## Golden Trace

Golden schema v2 只比较稳定语义字段：顺序、尝试、step/event/tool、digests、success、`resultKind`、exit/timeout/truncation、verification 与 events。延迟和原始路径等易变字段不进入 Golden record。`runId` 是选择执行的键，本身具有易变性，因此不进入 Golden 比较字段。

- `golden_run()` 先按 `(taskId, runId)` 过滤，再把 task-global sequence 归一化为从 1 开始的 run-local 顺序。
- 新回归优先使用 `write_golden_run()` 和 `compare_golden_run()`；task 级 `write_golden()` / `compare_golden()` 保留用于全历史或兼容场景。
- 只有产品契约明确变化时才更新 Golden；不能为让失败测试变绿而覆盖期望。

## Eval 夹具

Eval 夹具位于：

```text
benchmark/bugfix/
benchmark/refactor/
benchmark/planning/
benchmark/long_horizon/
```

schema v1 夹具包含原始 trace 和 expectations，而不是调用方预先算好的指标。Eval 从 trace 派生：最终 `resultKind`、严格 event order、required tools、retry budget、tool-call budget、latency 和 case failures。其中：

- 每条 `tool_called` 都必须有非空 `stepId` 和 `toolCall`；
- `allowedTools` 是必填的精确白名单，无工具 case 也必须显式写 `[]`；
- attempt 属于 `stepId` 而不是工具名，同一 step 必须从 1 连续递增，且不能在重试中换 `toolCall`；
- retry 指标按各 step 最终 attempt 的 `attempt - 1` 求和；
- 每个 fixture 必须恰有一条位于末尾的 `task_completed`，它的 `success=true` 只确认结论已发布。

CLI：

```bash
cd src-tauri
cargo run --bin main -- eval
```

所有 case 通过时退出 0；任何语义失败、解析错误或报告序列化错误退出 1；用法错误退出 2。Tauri 侧也通过 `run_eval_harness` 暴露同一评估器。

这类静态 JSON trace + expectations 只能证明夹具的结构与 Eval 规则，不能证明当前 `RuntimeLoop` 真的会产生同样的事件和结论。运行时门禁必须使用固定 request 实际驱动 `runRuntimeHarness()` / `run_runtime_harness`，然后将该 `runId` 的 run-scoped Golden 与独立审核的期望值比较。当前的真实 conformance 门禁是 `src-tauri/src/runtime/harness_runner.rs` 中的 `workspace_harness_runs_traces_and_replays_steps`：它执行固定 `printf` request，并与独立手写的 expected Golden 比较。不能在测试里用当次 actual 现场生成 expected，那会把回归变成自比较。

## 回归夹具流程

1. 从 Debug Log、Session events 或工具结果建立有序时间线。
2. 定位第一处因果偏差，并标记 TypeScript、Rust trusted execution、persistence 或 Harness 中的唯一 owner。
3. 删除无关轮次和易变生成文本，保留身份、事件顺序、工具输入/结果和结论。
4. 在修复前确认夹具能失败（可行时）。
5. 修复 owning layer；不要增加 provider 名、模型名或中英文短语特判。
6. 先跑 focused test，再跑 Rust/TypeScript 全量门禁；高风险运行时改动再做真实 provider 或 Codex differential 验证。

## 建议门禁

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --all-targets --manifest-path src-tauri/Cargo.toml
cargo test --lib --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit
npm run test:workflow-assets
npm run build
```

与生命周期相邻的变更，还要覆盖工作区提交必成 Turn、暂停/续跑、合法取消序列、旧 failed 事件读取归一化、Session CAS/FIFO/recovery，以及 UI 只显示一个最终结论。

参见 [架构与唯一所有权](ARCHITECTURE.md)、[运行时生命周期](RUNTIME_LIFECYCLE.md) 和 [受信任执行](TRUSTED_EXECUTION.md)。
