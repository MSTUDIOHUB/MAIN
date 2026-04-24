---
inclusion: always
---

# Project Structure

## 目录组织
- `src/`
  - `components/`：前端 UI 组件。重点包括 `Composer.tsx`、`ChatArea.tsx`、`RightPanel.tsx`、`PlanPanel.tsx`、`ActionCard.tsx`。
  - `lib/`：Agent 核心逻辑。重点包括 `orchestrator.ts`、`systemPrompt.ts`、`toolExecutor.ts`、`streaming.ts`、`instructions.ts`、`hooks.ts`。
  - `store/`：全局状态管理，核心文件是 `useAppStore.ts`。
  - `utils/`：文件扫描、图片等辅助工具。
- `src-tauri/`
  - `src/lib.rs`：Tauri Rust 后端命令入口，负责文件系统、PTY、流式代理等能力。
  - `tauri.conf.json`：桌面应用配置。
- `.MAIN/`
  - `steering/`：项目级规则与上下文；
  - `plans/`：Plan 模式临时规格文件目录；
  - `templates/`：意图分析与 Plan 文档模板；
  - `rules/`：对特定路径生效的 scoped rules。
  - `hooks.json`：生命周期 Hook 配置。
- `scripts/`
  - `plan_completion_check.mjs`：Plan 完成检查 Hook 脚本。
- `docs/`：架构、组件、执行循环、IPC 等设计文档。

## 命名规范
- React 组件文件使用 `PascalCase.tsx`
- 工具/库文件使用 `camelCase.ts` 或语义清晰的模块名
- Zustand store 中的 action 使用动词短语命名，如 `approvePlan`、`rejectToolAction`
- Plan 产物文件固定为：`requirements.md`、`design.md`、`tasks.md`、`bugfix.md`

## 模块边界
- `components/` 负责展示与交互，不承担核心 Agent 决策；
- `store/useAppStore.ts` 负责 UI 状态与 orchestrator 回调桥接；
- `lib/orchestrator.ts` 是 Agent 多轮执行主循环，是 Plan / Fast / Chat 行为分流的核心；
- `src-tauri/src/lib.rs` 负责与本地文件系统、终端和网络代理交互；
- `.MAIN/templates/` 负责提供稳定的文档骨架，不应承担运行时状态；
- `.MAIN/hooks.json` 与 `scripts/plan_completion_check.mjs` 负责执行期护栏，不应替代 store 中的真实任务状态；
- Plan 面板相关逻辑应优先放在 `workflowModels.ts`、`PlanPanel.tsx`、`RightPanel.tsx` 与 `useAppStore.ts` 的配合层，不要把 UI 细节塞进 orchestrator。

## 关键入口文件
- `src/store/useAppStore.ts`：全局状态、消息发送入口、review gate、面板状态同步
- `src/lib/orchestrator.ts`：Agent 执行循环、Plan gate、工具执行分发
- `src/lib/systemPrompt.ts`：系统提示词拼装与三模式规则
- `src/lib/instructions.ts`：工作区指令、规则、模板解析入口
- `src/lib/hooks.ts`：Hook 配置加载与执行结果归一化
- `src/components/RightPanel.tsx`：计划/差异/终端/文件四类面板入口
- `src/components/PlanPanel.tsx`：Plan 文档与任务进度展示
- `src-tauri/src/lib.rs`：Rust 端 IPC 与文件/终端实现
