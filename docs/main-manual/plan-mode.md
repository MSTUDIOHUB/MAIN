---
title: "计划模式"
sidebarTitle: "计划模式"
description: "让 MAIN 先产出计划，再经过你批准后执行。"
category: "use-main"
order: 30
status: "draft"
sourceFeature: "PlanReviewBlock、PlanPanel、planLifecycle、.MAIN/plans"
---

# 计划模式

计划模式适合高影响任务：MAIN 先探索和写计划，你确认后再执行文件修改和验证。

<!-- screenshot: docs/main-manual/assets/plan-mode-panel.png -->

## 适用场景

- 多文件修改。
- 新功能、架构调整或复杂 bug。
- 需要先审查需求、设计和任务拆分。

## 前置条件

- 已打开工作区。
- 已选择 `Plan` 工作方式。
- 任务目标和验收标准越清楚越好。

## 步骤

1. 切到 Plan。
2. 描述任务目标、范围、限制和验收标准。
3. 等待 MAIN 读取项目结构和相关文件。
4. 审阅 MAIN 输出的计划、任务清单或 `.MAIN/plans/` 计划文件。
5. 如果计划不对，要求调整。
6. 如果计划可行，点击批准或开始执行。
7. 执行后检查任务进度、Diff 和验证结果。

## `.MAIN/plans/`

复杂任务可能会在工作区内生成计划文件，例如需求、设计、任务或 bugfix 文档。这些文件用于让计划可审阅、可恢复、可追踪。它们不应该承载真实源代码实现。

## 结果确认

- 计划面板显示可审阅内容。
- 任务清单可以展示完成进度。
- 批准前不会直接写源文件。
- 执行后 MAIN 会用工具证据更新任务状态。

## 常见问题

**计划写得太泛怎么办？**  
要求 MAIN 补充具体文件、接口、验证命令和风险点。

**批准计划后能停止吗？**  
可以停止当前生成或拒绝后续审批。已完成的文件改动需要通过 Git 或 Diff 自行审查。

**什么时候不用 Plan？**  
单文件、低风险、目标明确的小改动可以用 Chat 或 Fast。

## 下一步

- 阅读 [权限与审批](permissions-and-approval.md)，理解批准后的写入保护。
- 阅读 [Agent 如何工作](agent-loop.md)，了解计划执行循环。
- 阅读 [代码工作流](coding-workflows.md)，把计划落到实际开发。
