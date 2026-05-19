# MAIN 2.0.8 中文 Release Note

版本跨度：2.0.6 -> 2.0.8  
整理日期：2026-05-19

MAIN 2.0.8 是在 2.0.6 之后的一轮延续整理发布，重点把“计划恢复链路更清楚”“过程归档与思考摘要更轻”“工具结果反馈更直观”“执行边界与错误恢复更稳”合并收束。相比 2.0.6 更偏重过程归档、思考展示和编排守卫的第一轮收敛，这一版更集中解决批准后继续执行、恢复时是否默认读取 `tasks.md`、过程信息过重，以及工具结果反馈不够直观的问题。

## 主要更新

### 已批准计划的继续执行与恢复链路更清楚

- 计划批准后的 handoff 更稳定，继续执行时更容易沿着当前 runtime 任务清单推进，而不是重复讲一遍计划。
- 恢复执行时会先重新核查当前 workspace 状态，再决定下一步，减少旧上下文、旧检查点或半完成状态误导后续执行的问题。
- `.MAIN/plans/tasks.md` 现在被进一步收敛为“可选审计文件”：只有任务较长、需要跨会话留档，或用户明确要求时才需要持久化；不会再默认为了确认它是否存在而去读取它。

### 过程归档、思考摘要和实时步骤展示继续减重

- 聊天区的 process archive 进一步收敛为更轻量的意图时间线，搜索、读取、编辑、验证等步骤更容易快速扫读。
- turn thought visibility 和 live step folding 继续优化，思考块、执行步骤和最终结论之间的层级更清楚。
- 长回合里的过程摘要更聚焦于“做了什么、结果是什么、接下来做什么”，减少重复思考和工具流水对主回答的干扰。

### 工具结果与错误反馈更直观

- 新增更完整的 tool result presentation 层，工具成功、失败、等待审批和恢复提示的展示更统一。
- ActionCard、聊天区折叠块和相关反馈文案同步调整，用户更容易判断当前是正常执行、等待确认，还是进入恢复路径。
- 过程归档与工具结果展示配合后，复杂回合里“结果”和“过程”分层更明显，减少只看到长日志却不清楚结论的情况。

### 执行边界与恢复稳定性继续补强

- 计划恢复 prompt、最大迭代检查点和暂停提示继续整理，达到边界时会更明确地提示如何继续，而不是简单当作失败结束。
- 内部计划文件和项目源码证据的边界更清楚，恢复总结时不会轻易把 `.MAIN/plans/*` 误当成真实业务交付。
- `design.md`、runtime 任务清单、证据摘要和恢复提示之间的联动进一步增强，多轮长任务更容易在正确位置接续。

## 修复与稳定性

- 改进计划恢复时的上下文读取策略，避免无意义探测缺失的可选 `tasks.md`。
- 优化思考摘要和过程归档的压缩逻辑，减少刷新、恢复或长轮次后出现的信息重复。
- 收紧恢复执行阶段的提示边界，降低“计划已批准但执行入口不清楚”或“恢复后继续跑偏”的风险。
- 改进工具结果反馈与错误恢复提示的一致性，让暂停、继续执行和最终收尾的切换更自然。

## 验证覆盖

- 新增或更新 Node 测试，覆盖 `planExecutionRecovery`、`planArtifactHydration`、`turnProcessArchive`、`toolResultPresentation`、`thoughtDisplay` 和 `workflowModels`。
- 新增或更新 E2E 测试，覆盖 `plan-flow`、`awaiting-choice`、`diff-reload-summary`、`read-context-collapse`、`thinking-policy` 等计划恢复与过程展示场景。
- 版本号与桌面端 bundle 配置已同步到 `2.0.8`，便于沿当前公开下载仓库和 UpdateFeed 仓库流程继续发布。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.0.8_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.0.8_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.0.8_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.0.8_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.0.8_macOS_universal.zip`。
- 解压后把 `MAIN.app` 拖到 `Applications`。
- 在 Finder 里对 `MAIN.app` 点击右键，选择 `Open`。
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`。
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
