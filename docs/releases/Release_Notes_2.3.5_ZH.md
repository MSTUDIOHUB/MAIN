# MAIN 2.3.5 发布说明

发布日期：2026-09-05  
版本跨度：2.3.3 → 2.3.5

MAIN 2.3.5 更新了联网查询、Agent Skills、项目初始化、计划与执行恢复，并精简了桌面界面和旧版 Game Studio 集成。

## 主要更新

### 联网查询与只读任务

- 联网开关接入只读工作流，支持使用 `web_search` 和 `web_fetch` 搜索、读取网页，再结合实际返回内容回答。
- 聊天与工作区分析共用只读执行基础设施，并根据当前任务分别限制可用工具。
- 请求上下文加入当前日期，帮助模型处理新闻、天气、日程等时效性问题。
- 改进网络搜索结果处理，并兼容 TUN 代理使用的 Fake-IP 域名解析。

### Agent Skills

- 支持从技能面板、个人目录、工作区和协议包构建技能目录，按需加载完整技能内容及关联资源。
- 技能支持“允许模型自动匹配”和“仅手动”两种使用方式；显式引用可启用仅手动技能。
- 技能设置可在重新打开页面后恢复，加载技能仍遵守当前任务的工具权限。

### 项目初始化与使用指南

- 新增项目初始化与基线审查流程，通过 `/init` 了解项目，通过 `/init --refresh` 刷新已有基线。
- 初始化结果经过审查后再写入，支持基线冲突与现有项目状态检查。
- 新增 MAIN 使用指南入口，集中说明斜杠命令、文件引用、附件与自动审查，适配浅色、深色和纯黑主题。

### 计划、协作与执行恢复

- 完善计划提交、校验、修复和审批后的执行范围传递。
- 改进计划重载恢复、子智能体交接和证据归属，区分继承的上下文与子任务实际产出的证据。
- 加强文件读取范围、修改前检查、执行结果证据和重复操作反馈之间的一致性。
- 改进空响应、流式输出、工具协议和上下文预算相关的恢复处理。

### 桌面界面与旧功能清理

- 调整聊天区、状态胶囊、工具步骤、思考内容及会话交互，减少重复反馈。
- 为网络搜索和网页读取显示对应进度，调整全局聊天中的工作区时间线展示。
- 移除内置 Game Studio 专用界面、命令资产和旧运行时桥接代码；专用工作流可通过现有 Skills 与协议包扩展。

## 下载

| 系统 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [MAIN_2.3.5_macOS_apple_silicon.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.5/MAIN_2.3.5_macOS_apple_silicon.zip) |
| macOS Intel / 通用版 | [MAIN_2.3.5_macOS_universal.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.5/MAIN_2.3.5_macOS_universal.zip) |
| Windows x64 | [MAIN_2.3.5_windows_x64.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.5/MAIN_2.3.5_windows_x64.zip) |

macOS 用户解压后，将 `MAIN.app` 放入 Applications。当前 macOS 包使用 ad-hoc 签名，未完成 Apple Developer ID 签名与公证；首次打开如被系统拦截，可在“系统设置 → 隐私与安全性”中使用“仍要打开”。Windows 包未配置 Authenticode 签名，首次运行可能出现 SmartScreen 提示。

`latest.json`、`*_updater_*` 与 `.sig` 用于应用内更新及完整性校验，手动安装只需下载上表中的 zip。Updater 签名与 Apple / Windows 的开发者身份签名用途不同。

## 源码与反馈

- [公开源码与构建说明](https://github.com/MSTUDIOHUB/MAIN)
- [最新版本下载页](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest)
- [提交问题](https://github.com/MSTUDIOHUB/MAIN/issues)

本说明归档 2.3.5 的发布内容；后续运行时契约以源码仓库中的现行架构文档为准。
