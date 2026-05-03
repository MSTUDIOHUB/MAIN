# PLAN: 修复删除最后一个 Workspace 后 ChatArea 残留历史消息

## 问题描述

当用户删除 Sidebar 中的最后一个 Workspace 时，`handleOpenGlobalChat()` 会切换到全局聊天视图。但如果全局聊天没有已有 session，函数只将 `currentSessionId` 置空，没有重置聊天运行态（`taskFlow`、`conversationTurns`、`agentMessages`、`currentTurnId` 等）。这导致 `ChatArea` 继续渲染用户最后看过的会话历史，而不是显示全局空状态。

## 根因分析

`handleOpenGlobalChat()` 在 `refreshSessionsForScope(GLOBAL_CHAT_KEY)` 返回空数组时，只执行了 `setCurrentSessionId(null)` 并 return，遗漏了：
1. 清空聊天运行态（taskFlow、agentMessages、conversationTurns、currentTurnId 等）
2. 归零 `selectedWorkspace`

而项目中已有的空会话 reset 逻辑（在 `handleOpenWorkspacePath` 的 `else` 分支中）完整实现了这些操作，但未被复用。

## 修复方案

### 1. 抽取 `resetToEmptyChatView()` helper（src/App.tsx）

从 `handleOpenWorkspacePath` 的空会话 `useAppStore.setState` 块中抽取为独立的 `useCallback` 函数，集中管理所有需要重置的 store 字段：
- `taskFlow: []`
- `agentMessages: []`
- `conversationTurns: []`
- `currentTurnId: null`
- `planArtifacts: []`、`planTasks: []`、`planStage: "idle"` 等计划相关状态
- `showPlanPanel: false`、`showDiff: false`、`showTerminal: false`、`showFilePanel: false` 等面板状态
- `agentStatus: "idle"`、`isGenerating: false` 等生成状态

### 2. 修改 `handleOpenGlobalChat()` 空 session 分支

当 `refreshSessionsForScope(GLOBAL_CHAT_KEY)` 返回空数组时：
1. 调用 `resetToEmptyChatView()` 清空聊天运行态
2. 调用 `setCurrentWorkspace("")` 归零 workspace
3. 调用 `setCurrentSessionId(null)` 归零 session

### 3. 新增 E2E 测试场景

- **场景定义**（src/lib/e2e.ts）：`SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO`
  - 预置 1 个 workspace（`/tmp/e2e-sidebar-remove-last`）
  - 预置 1 个 active session（`sessionId: 999601`）
  - 预置 1 条 conversation turn（包含 user + agent 消息块）
  - global session 为空数组

- **测试用例**（tests/e2e/sidebar-remove-last-workspace.spec.ts）：
  1. 验证初始状态：workspace 活跃、session 有内容
  2. 模拟删除最后一个 workspace
  3. 验证 ChatArea 清空（taskFlowBlocks === 0）
  4. 验证 currentSessionId 为 null
  5. 验证 Sidebar 不再显示已删除的 workspace

## 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/App.tsx` | 修改 | 抽取 `resetToEmptyChatView()` helper，修改 `handleOpenGlobalChat()` 空 session 分支 |
| `src/lib/e2e.ts` | 新增 | 添加 `SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO` 场景定义和 seed 函数 |
| `tests/e2e/sidebar-remove-last-workspace.spec.ts` | 新增 | E2E 测试用例 |

## 验证结果

- TypeScript 编译检查通过（`npx tsc --noEmit` exitCode: 0）
- `resetToEmptyChatView` helper 已正确定义在 src/App.tsx 第 1041 行
- `handleOpenGlobalChat` 空 session 分支已调用 `resetToEmptyChatView()` 和 `setCurrentWorkspace("")`
- E2E 场景已注册到 `initializeE2EScenarios()` 中

## 残留风险

- E2E 测试中删除 workspace 的 UI 交互（右键菜单 vs 直接按钮）可能因实际实现不同而需要调整选择器
- 如果 `handleOpenGlobalChat()` 在其他路径也被调用（如从其他 workspace 切换），需确保不会意外清空正在使用的会话
