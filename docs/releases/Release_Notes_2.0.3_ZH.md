# MAIN 2.0.3 中文 Release Note

版本跨度：1.6.7 -> 2.0.3  
整理日期：2026-05-17

MAIN 2.0.3 是一次跨版本整理发布，重点把 1.6.7 之后陆续落地的“设计先行计划执行”“Runtime Harness 底座重构”“聊天展示与上下文体验提升”“本地发布流程完善”合并收束。相比 1.6.7 主要围绕 Game Studio 帮助文档与本地快路径，这一版更集中地补强了计划、执行、权限、运行时稳定性和公开分发链路，整体上更接近可持续演进的 2.0 基线。

## 主要更新

### 计划执行流升级为更完整的“设计先行 + 可调整执行”

- 计划物化、批准后执行和恢复链路继续前移，批准后的任务列表、执行阶段和回合状态更一致。
- 新增计划调整输入能力，用户可以在执行前后补充修正意见，不必每次都重新走完整轮规划。
- TopIsland、聊天区和右侧面板对计划状态、执行阶段和真实进度的展示进一步收敛，减少“界面显示在推进，但实际没有进入对应阶段”的错位感。

### Runtime Harness 与权限边界完成一轮底座重构

- 新增 Runtime Harness 运行底座，把权限预检、运行时循环、事件总线、重试、验证和追踪等能力收敛到更稳定的执行框架里。
- `.MAIN/permissions.yaml`、权限规则预检与 harness telemetry 路径同步接入，命令为什么能执行、为什么被拦截、建议如何处理，反馈更明确。
- Rust 侧补齐 memory、index、planner、eval、MCP、terminal、git、filesystem、browser、unity 等基础模块，为后续更复杂的代理执行与工具编排提供统一入口。

### 聊天展示、上下文提示和工具反馈更清楚

- 新增用户上下文 pills，`@文件`、附件和截图会以更紧凑的形式展示，减少长路径和原始附件信息挤占聊天区。
- Markdown 渲染、操作卡片和工具反馈展示做了集中整理，长回复、思考块、命令反馈和结构化状态提示更稳定。
- 文件预览策略、外部文件打开、聊天错误分类与重试提示同步增强，遇到流式中断、协议异常或工具失败时更容易判断下一步。

### 本地发布与公开分发流程补齐

- 新增 `npm run release:local:mac -- <version>` 和 `npm run release:local:windows -- <version>`，在 GitHub Actions 额度不足时也能本地完成构建、签 updater、生成 `latest.json` 并上传。
- 修复 macOS share zip 打包链路，公开下载包和自动更新资产的整理方式更一致。
- 发布文档同步补齐，私有主仓库构建、公开 Releases 下载仓库和 UpdateFeed 自动更新仓库的分工更清晰。

## 修复与稳定性

- 改进计划执行进度保护，减少普通工具活动被误判成真实计划步骤推进的问题。
- 收紧 Harness 权限策略，降低命令切片、危险参数或不明确权限边界带来的误执行风险。
- 补强流式响应 watchdog、重复调用防护、伪工具调用恢复和工作流模型判定，长任务执行更稳。
- 改进文件面板预览与外部打开体验，减少大文件、二进制文件或不适合内嵌预览内容带来的卡顿与误判。

## 验证覆盖

- 新增或更新 Node 测试，覆盖用户上下文 pills、workflow models、plan materialization、runtime tools / events、repetition guard 和 public release tools。
- 新增或更新 E2E 测试，覆盖云端工具协议、文件面板布局、计划流、TopIsland 执行进度和用户上下文展示。
- 发布脚本与文档链路已补齐到本地发布场景，便于后续直接执行 `release:local:*` 做正式发布前检查。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.0.3_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.0.3_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.0.3_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.0.3_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.0.3_macOS_universal.zip`。
- 解压后把 `MAIN.app` 拖到 `Applications`。
- 在 Finder 里对 `MAIN.app` 点击右键，选择 `Open`。
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`。
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
