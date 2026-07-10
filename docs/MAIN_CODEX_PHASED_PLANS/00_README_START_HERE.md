# MAIN Runtime Harness 重构路线图

本目录包含适合直接发送给 Codex 的分阶段重构方案。

推荐执行顺序：

1. 01_PHASE1_RUNTIME_FOUNDATION.md
2. 02_PHASE1_IMPLEMENTATION_TASKS.md
3. 03_PHASE2_MEMORY_INDEX_EVALS.md
4. 04_PHASE3_MULTI_AGENT_MCP_RUNTIME.md
5. 05_UNITY_MCP_AND_GAMEDEV_RUNTIME.md
6. 06_ARCHITECTURE_RULES_AND_CONSTRAINTS.md
7. 07_MAIN_REFACTOR_GAME_STUDIO_STATUS.md
8. 08_MAIN_REFACTOR_REASSESSMENT.md

当前 MAIN / Game Studio 大文件重构应先阅读
`08_MAIN_REFACTOR_REASSESSMENT.md`。它覆盖 07 中“继续拆分 Phase 3”的旧判断，
并给出新的停止条件、行为验收门和后续阶段顺序。当前 Phase 3S、Phase 4 与 Phase 5
受控切片与 Phase 6 集成验收已完成；`ChatArea`/`SettingsModal` 的整体拆分经评估后
推迟。剩余 Playwright 基线债务应另立行为修复任务，不继续扩大本轮结构重构。

不要一次性把全部大文档塞给 Codex。

最佳实践：

- 每次只给一个阶段
- 让 Codex 先实现
- Review diff
- 再进入下一阶段

原因：

Codex 对超长战略文档容易：
- 过度重构
- 偏离目标
- 一次修改过多
- 丢失现有架构

MAIN 当前已经具备：
- Tauri
- Rust
- React
- Agent Workflow
- Plan / Execute
- Workspace

所以目标不是重写。

而是：

“增量式 Harness Engineering”
