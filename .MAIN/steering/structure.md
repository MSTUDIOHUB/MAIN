---
inclusion: always
---

# Project Structure

## 当前生产调用链

```text
src/store/submitAsyncWorkflowRun.ts
  -> src/store/submitRuntimeRunner.ts
  -> src/store/runtimeV2/*Runner
  -> src/lib/runtime-v2/RuntimeV2Controller + ports
  -> src/lib/toolExecutor.ts / src/lib/streaming.ts
  -> src-tauri/src/lib.rs
```

- `src/store/useAppStore.ts` 负责接纳、Session/FIFO 状态与 UI 桥接，不拥有模型循环策略。
- `src/store/runtimeV2/` 是生产 runner 和 provider/tool/checkpoint/projection ports。
- `src/lib/runtime-v2/` 保存 provider-neutral contract、controller、reducer 与证据语义。
- `src/components/` 只从结构化投影展示状态，不从模型措辞猜测完成或失败。
- Rust 负责文件、Shell、网络、进程与快照 CAS 的最终受信任边界，不重新判断用户意图。
- 旧 `src/lib/orchestrator.ts` 和 Rust `RuntimeLoop` 不是 Workspace Turn 的生产 Agent 循环，只能作为历史对照或测试基础设施。

## 工作区文件

- `.MAIN/steering/`、`.MAIN/rules/` 和根目录 instruction 文件是用户可读、可版本控制的项目规则。
- `.MAIN/plans/plan.md` 是 sealed WorkPlan 的可读投影；审批权威是 typed identity，不是 Markdown 文本。
- `.MAIN/plans/tasks.md` 仅在长任务、跨会话恢复或用户要求审计时持久化，不是每轮必需的第二事实源。
- `docs/ARCHITECTURE.md` 与 `docs/RUNTIME_KERNEL_INVARIANTS.md` 记录现行所有权和能力边界；旧发布说明不能覆盖当前生产调用点。

## 修改边界

- React 组件使用 `PascalCase.tsx`；库和 store 模块使用语义明确的 `camelCase.ts`。
- UI、runtime policy、provider adapter、trusted execution 与 persistence 各自保持单一所有者。
- 修复运行时前先从生产入口追踪调用点；不要依据旧文件名、未调用的 helper 或历史文档补逻辑。
