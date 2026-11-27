# MAIN 2.4.3 发布说明

本次构建日期：2026-11-27

版本跨度：2.4.2 → 2.4.3

MAIN 2.4.3 新增多预设主题配色系统与自由调色体验、Unity Play Mode 验证与真实 Game View 捕获闭环、Unity 官方 MCP 与本地 stdio MCP 连接器支持，以及终端敏感凭证脱敏和 CLI 更新能力。

## 主要更新

### 多预设主题配色系统与自由调色体验

- 新增 `AppearanceThemeSettings`、`themePresets` 与 `useThemePalette`，支持跟随系统、浅色、深色与纯黑四种外观模式。
- 浅色与深色模式各内置 6 套配色预设（MAIN 默认、Catppuccin Latte/Mocha、暖纸米白/暖炭深灰、极简冷灰、GitHub Light/Dark、清冷雾白/北欧深灰），支持背景色、前景色与强调色的取色器及 Hex 微调与实时代码预览；黑色模式保留纯黑高对比底色并支持强调色自定义。
- 自动派生全界面表面层级、代码块、展开弹窗、Mermaid 图表与内置终端配色，更新设置文档说明。

### Unity Play Mode 验证、Game View 捕获与修复闭环

- 新增 `unity_playmode_evidence.rs` 与 `unityPlayMode`，解析 C# 测试特性并采集真实的 Play Mode 验证证据。
- 新增 `unity_game_view.rs` 与 `executionUnityGameView`，通过专用受限 IPC 捕获当前已连接 Unity 工程的真实 Game View 画面，且图片数据不进入命令历史。
- 新增程序集引用依赖分析（`unity_assembly_dependencies.rs`、`unityAssemblyReferences`）与 `unityRepairLoop`，完善诊断到修复验证的闭环体验。

### Unity 官方 MCP、本地 stdio MCP 连接器与 CLI 更新

- 新增 `src-tauri/src/mcp/stdio.rs` 本地进程 `StdioMcpClient`，在握手阶段严格校验协议版本、服务端身份、工具能力声明及单帧体积限制。
- 新增 `unityOfficialMcp`，支持扫描、绑定并调用当前工程已连接 Editor 的 Unity Official MCP 工具。
- 新增 `unity_cli_update.rs`，支持检查并应用 Unity CLI 更新。

### 终端凭证脱敏与运行时健壮性增强

- 新增 `terminal_credentials.rs`、`terminalCredentials` 与 `terminalCredentialHistory`，在不破坏 PTY 原始字节游标的前提下识别并脱敏终端输出与历史中的敏感访问令牌（如 `--access-token`）。
- 完善 `executionObservationProgress`、执行阻塞器、主动子智能体调度及项目文档与测试覆盖。

## 下载

请选择对应系统的安装包，也可访问[公开 Releases 页面](https://github.com/MSTUDIOHUB/MAIN-Releases/releases)查看全部资产。

| 系统 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [MAIN_2.4.3_macOS_apple_silicon.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.3/MAIN_2.4.3_macOS_apple_silicon.zip) |
| macOS Intel / 通用版 | [MAIN_2.4.3_macOS_universal.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.3/MAIN_2.4.3_macOS_universal.zip) |
| Windows x64 | [MAIN_2.4.3_windows_x64.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.3/MAIN_2.4.3_windows_x64.zip) |

macOS 用户解压后，将 `MAIN.app` 放入 Applications。未使用 Apple Developer ID 签名与公证的 macOS 构建，首次打开如被系统拦截，可在“系统设置 → 隐私与安全性”中使用“仍要打开”。Windows 首次运行可能出现 SmartScreen 提示。

`latest.json`、`*_updater_*` 与 `.sig` 用于应用内更新及完整性校验，手动安装只需下载上表中的 zip。Updater 签名与 Apple / Windows 的开发者身份签名用途不同。

## 源码与反馈

- [公开源码与构建说明](https://github.com/MSTUDIOHUB/MAIN)
- [最新版本下载页](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest)
- [提交问题](https://github.com/MSTUDIOHUB/MAIN/issues)

本说明归档 2.4.3 的发布内容；后续运行时契约以源码仓库中的现行架构文档为准。
