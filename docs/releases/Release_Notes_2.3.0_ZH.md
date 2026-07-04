# MAIN 2.3.0 中文 Release Note

版本跨度：2.2.9 -> 2.3.0  
整理日期：2026-07-01

MAIN 2.3.0 是一轮聚焦于"核心工作流稳定性"、"多 Agent 协作"与"执行恢复机制"的重大更新版本。本次更新增强了计划执行中断后的自动恢复与进度追踪能力，全面优化了多 Agent MCP 运行时通信协议与任务分发；深化了 Unity 游戏开发集成与意图识别预检；改进了云模型发现、路由逻辑及网关错误重试机制。同时，对对话流式渲染、Patch 精确匹配、PTY 终端缓冲以及上下文记忆管理进行了深度性能调优，并修复了侧边栏布局、主题切换等多个界面与稳定性问题。这一版本在复杂任务处理能力、系统可靠性与用户体验上均实现了全面升级。

## 主要更新

### 亮点 1：增强的计划执行与中断恢复机制

- **自动恢复与状态重建 (Plan Execution Auto-Recovery)**：改进了计划中断后的自动恢复能力，支持基于执行上下文的智能状态重建，确保长流程任务中断后能够顺畅恢复执行，减少重复操作。
- **进度追踪与上下文加载 (Progress Tracker & Context Optimization)**：新增计划执行进度追踪器，支持实时可视化展示各阶段任务完成状态，并优化了恢复时的上下文加载策略，提升整体执行效率。

### 亮点 2：多 Agent MCP 运行时与任务分发改进

- **多 Agent 通信协议 (Multi-Agent Communication Protocol)**：完善了多 Agent 协作过程中的通信协议与状态同步机制，提升了多 Agent 协同场景下的执行可靠性。
- **MCP 客户端与任务分发 (MCP Client & Task Dispatching)**：增强了 Model Context Protocol (MCP) 客户端的运行稳定性，新增对复杂跨 Agent 任务分发的支持，实现了更高效的分布式协作。

### 亮点 3：Unity 游戏开发集成与意图识别优化

- **Unity MCP 适配与预检 (Unity MCP Adapter & Pre-check)**：优化了 Unity MCP 适配器的响应处理效率，新增游戏开发意图识别的预检机制，大幅提升了游戏项目识别的精准度。
- **引导流程优化 (Game Studio Onboarding)**：改善了游戏工作室（Game Studio）的引导流程与交互细节，降低了游戏开发者接入与部署的门槛。

### 亮点 4：云模型发现与云网关路由增强

- **模型发现与路由 (Cloud Model Discovery & Routing)**：重构了云端模型的自动发现与路由分发逻辑，确保请求能够精准调度至最佳模型实例。
- **网关协议与错误恢复 (Gateway Protocol & Retry Mechanism)**：优化了云网关适配器协议，增强了网络波动时的自动化重试与错误恢复能力，提升了远程服务的连贯性。

### 亮点 5：交互体验、终端与编辑效能提升

- **流式响应与思考块呈现 (Streaming & Thought Block Visualization)**：大幅优化了对话流式响应的渲染帧率，改善了工具调用折叠/展开交互以及思考块（Thought Block）的视觉样式。
- **代码 Patch 与文件处理 (Patch Matching & Large File Paging)**：改进了 Patch 代码应用时的精确匹配算法，优化了大文件读取的分页策略与 Diff 对比清晰度。
- **PTY 终端与上下文管理 (PTY Terminal & Memory Management)**：优化了 PTY 终端输出缓冲与长日志读取性能；升级了上下文窗口裁剪与记忆持久化策略，加快了工作区索引构建速度。

## 修复与稳定性

- **计划与执行状态修复 (Plan Execution Fixes)**：修复了计划恢复时可能丢失进度、部分工具调用在计划模式下未正确记录以及任务勾选状态不同步的问题。
- **对话与流式渲染修复 (Chat & Stream Fixes)**：修复了流式响应中断后消息显示异常、工具结果折叠状态丢失以及思考块在特定条件下显示不完整的问题。
- **云服务与远程控制修复 (Cloud & Feishu Remote Fixes)**：修复了云模型选择生效延迟、飞书远程控制连接稳定性问题以及部分云网关响应解析异常。
- **UI 与布局修复 (UI & Layout Fixes)**：修复了侧边栏在特定窗口尺寸下的布局重叠、主题切换后部分组件样式未更新以及部分快捷键冲突问题。
- **版本合规统一**：项目配置、应用描述及包配置文件中的版本号已统一校准更新至 `2.3.0`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.3.0_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.3.0_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.3.0_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.3.0_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.3.0_macOS_universal.zip`；
- 解压后把 `MAIN.app` 拖到 `Applications`；
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`；
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`；
- 如果看到 "damaged and can't be opened" 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
- 如遇到启动卡死或权限阻拦，可尝试在终端运行 `rm -rf ~/Library/Application\ Support/main ~/Library/Caches/main` 清除缓存后重试。