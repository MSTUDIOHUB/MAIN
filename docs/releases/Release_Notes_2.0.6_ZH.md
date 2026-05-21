# MAIN 2.0.6 中文 Release Note

版本跨度：2.0.3 -> 2.0.6  
整理日期：2026-05-18

MAIN 2.0.6 是在 2.0.3 基线上的一轮聚焦整理发布，重点把“回合过程归档更轻量”“思考与实时步骤展示更清楚”“编排守卫与目标收敛更稳”“桌面发布产物校验更可靠”合并收束。相比 2.0.3 更偏重设计先行计划执行、Runtime Harness 和本地发布能力的打底，这一版更集中解决长对话里过程信息过重、实时执行层级不够清楚，以及 macOS 自动更新包容易混入额外元数据的问题。

## 主要更新

### 聊天区新增更轻量的“过程归档”与意图时间线

- 复杂回合中的搜索、检查、编辑、验证、阻塞等过程信息会被整理成更聚焦的步骤时间线，默认展示更短，展开回看时仍保留完整上下文。
- 过程归档会提炼每一步的意图、动作、结果和下一步，减少原始长文本、重复思考和工具流水把主回答冲散的问题。
- 选择分支后的上一轮反馈现在可以折叠保留，既不丢信息，也避免等待选择阶段把聊天区拉得过长。

### 思考展示与实时执行步骤更清楚

- 实时执行中的 live steps 支持更自然的折叠和收束，思考块、操作步骤和最终结论之间的层级更清楚。
- turn thought visibility 做了新一轮整理，减少不必要的思考外露，同时保留关键执行线索的可读性。
- ChatArea、TopIsland、PlanPanel 和右侧信息展示进一步对齐，用户更容易区分“正在做什么”“已经做完什么”“哪些只是过程归档”。

### 编排守卫与任务目标收敛继续加强

- 编排层新增更严格的 task targeting / orchestration guards，减少回复跑偏、目标不收敛，或在错误上下文里继续执行的问题。
- reply options、plan evidence 和 workflow models 的联动进一步增强，等待用户选择、恢复执行和回合总结之间更一致。
- 语言不一致、过程重复和计划执行边界的保护继续补强，长流程多轮交互更稳。

### 发布链路补强到 2.0.6：自动更新包校验更严格

- 本地 `release:local` 与 GitHub Actions 桌面构建流程新增 macOS updater 归档校验，打包时会主动禁用 AppleDouble 元数据写入。
- 对 `tar.gz` 自动更新包新增结构检查，确保归档顶层只包含目标 `.app`，避免混入 `__MACOSX`、`._*` 等额外文件影响更新分发。
- 版本号已同步提升到 `2.0.6`，方便后续继续沿当前公开下载仓库和 UpdateFeed 仓库流程发布。

## 修复与稳定性

- 改进过程归档后的摘要逻辑，长回合中的思考、上下文读取、编辑和验证信息更不容易重复刷屏。
- 优化实时步骤折叠和归档回放体验，刷新页面或重新载入后，过程信息的层级与可见性更一致。
- 收紧编排保护，减少执行中因目标漂移、选择态恢复不完整或思考展示过重带来的干扰。
- 补强 macOS 自动更新产物校验，降低因打包元数据污染导致 updater 读取失败或结构异常的风险。

## 验证覆盖

- 新增或更新 Node 测试，覆盖 `turnProcessArchive`、`thoughtDisplay`、`workflowModels`、`replyOptions` 等过程归档与展示逻辑。
- 新增或更新 E2E 测试，覆盖 `thinking-policy`、`diff-reload-summary`、`read-context-collapse`、`awaiting-choice`、`plan-flow` 和 Game Studio 工具分组折叠等场景。
- 发布脚本与 CI 工作流已补入 macOS updater 归档校验逻辑，便于后续在正式发布前直接检查自动更新资产结构。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.0.6_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.0.6_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.0.6_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.0.6_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.0.6_macOS_universal.zip`。
- 解压后把 `MAIN.app` 拖到 `Applications`。
- 在 Finder 里对 `MAIN.app` 点击右键，选择 `Open`。
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`。
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
