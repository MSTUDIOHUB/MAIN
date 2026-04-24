---
paths:
  - src/lib/orchestrator.ts
  - src/store/useAppStore.ts
  - src/components/PlanPanel.tsx
  - src/components/RightPanel.tsx
---

# Plan Workflow Invariants

这些文件共同决定 Plan 模式的用户体验，修改时必须维持以下不变量：

## 单次执行原则
- review gate 只负责“展示审批 + 返回用户决定”；
- 真正的工具执行应由 orchestrator 统一负责；
- 禁止在 UI 层和 orchestrator 层各执行一次同一条写操作。

## 任务进度原则
- `tasks.md` 是计划任务状态的事实来源；
- 不要因为“成功写了一个文件”就自动把某个计划任务标记完成；
- 如果要展示 `in_progress`，只能作为 UI 衍生状态，不能替代 `tasks.md` 的真实完成状态。
- 生成 `requirements.md` / `design.md` / `tasks.md` / `bugfix.md` 时，应优先遵循 `.MAIN/templates/plan/` 下对应模板的章节结构。

## 收尾原则
- Edit / Plan 模式在模型输出最终总结时，允许自然结束；
- 只有当模型明显在“口头说要调用工具但没调用”时，才应二次催促；
- Plan 执行阶段只要仍有未完成任务，就不能静默收尾。
- 如果完成检查 Hook 仍提示存在未完成项或缺失验证，不得直接宣告任务闭环。

## 方案保留原则
- `.MAIN/plans/` 下的文件默认是临时规划文件；
- 用户应能把当前计划文档导出到普通路径；
- “只想保留方案、不想执行”必须是受支持场景。
