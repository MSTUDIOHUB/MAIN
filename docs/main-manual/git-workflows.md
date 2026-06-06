---
title: "Git 工作流"
sidebarTitle: "Git 工作流"
description: "查看改动、预览 Diff、生成提交信息、commit、push 和创建分支。"
category: "use-main"
order: 50
status: "draft"
sourceFeature: "Sidebar Git menu、getGitStatus、getGitDiff、gitCommitAll、gitPushCurrentBranch"
---

# Git 工作流

MAIN 可以在侧边栏显示工作区 Git 状态，并提供 Diff 预览、提交信息生成、commit、push 和创建分支入口。

<!-- screenshot: docs/main-manual/assets/git-workflows-menu.png -->

## 适用场景

- 审查 MAIN 刚刚产生的改动。
- 快速查看当前分支和改动文件数量。
- 生成一条可读的提交信息。
- 在完成验证后提交并推送。

## 前置条件

- 当前工作区是 Git 仓库。
- Git 已安装且当前用户有提交权限。
- 推送需要远程仓库和认证配置。

## 步骤

1. 在左侧工作区条目查看 Git 状态。
2. 打开 Git 菜单刷新状态。
3. 选择查看 Diff，确认改动是否符合预期。
4. 如需提交，先让 MAIN 总结改动和验证结果。
5. 使用生成提交信息入口，或手动输入提交信息。
6. 点击 commit。
7. 需要同步远程时点击 push。
8. 新任务开始前，可以创建新分支隔离改动。

## 结果确认

- Git 菜单显示分支、改动数、ahead/behind 等状态。
- Diff 预览可以看到文件级变更。
- commit 后工作区状态减少或变 clean。
- push 成功后远程分支更新。

## 常见问题

**commit 前还需要自己检查吗？**  
需要。MAIN 可以辅助生成信息和执行操作，但提交前仍建议人工查看 Diff。

**push 失败怎么办？**  
检查远程仓库权限、网络、分支 upstream 和认证状态。

**MAIN 会自动提交吗？**  
只有在你明确要求或点击 Git 操作时才会提交。普通代码修改不会自动 commit。

## 下一步

- 阅读 [代码工作流](coding-workflows.md)，先完成开发和验证。
- 阅读 [权限与审批](permissions-and-approval.md)，理解命令和写入审批。
- 阅读 [故障排查](troubleshooting.md)，处理 Git 或命令错误。
