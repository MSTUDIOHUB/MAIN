# MAIN 2.4.0 发布说明

本次构建日期：2026-11-13

版本跨度：2.3.9 → 2.4.0

MAIN 2.4.0 重点增强了 Unity / 引擎开发工具链与内置引擎手册预设、已批准计划的续跑与修正边界、运行中主动子智能体协作与消息引导，并优化了工作台布局与桌面端后台节流策略。

## 主要更新

### Unity 工程编译、Shader 导入与 Editor 连接

- 新增 MAIN 托管的 Unity 工程校验能力：支持针对精确工作区工程的 C# / asmdef / asmref 编译校验与关联 Shader（`.shader` / `.hlsl` / `.cginc` / `.compute` 及 `#include` 依赖）导入诊断。
- 支持通过 `useUnityEditorReconnect` 自动重连或按需提示连接目标 Unity Editor 实例，精确校验返回工程路径与进程身份，并支持通过 operation ID 取消正在执行的 Unity 操作。
- 新增 `editorConsoleEvidence` 与诊断作用域识别：区分编译器诊断、Shader 导入错误与运行时 Console 报错，确保未解决的 Editor 校验阻塞不会误判为完成。

### 内置引擎代码手册预设与智能绑定

- 知识库新增内置引擎手册预设（`presets.rs`），开箱提供 **Unity 6 (6000.0)**、**团结引擎 (Tuanjie Engine)** 与 **Unreal Engine / UEFN Verse** 官方文档索引与核心 API 速查。
- 支持根据工作区特征（如 `ProjectSettings/ProjectVersion.txt`、`.uefnproject`、`*.verse`）自动识别目标引擎并在首次请求前按需绑定对应手册参考，同时保留用户通过 `#` 显式选择的资料优先级。
- 知识库面板支持一键添加或同步引擎手册预设，并增强知识库索引与引用呈现。

### 已批准计划的修订续跑、阶段推进与引导

- 新增已批准计划（Approved WorkPlan）的断点续跑与基线校验（`approvedPlanContinuation`）：支持从历史已批准但中断/阻塞的计划回合继续执行，校验计划修订版本、文档哈希与证据一致性，发现漂移时明确阻塞提示。
- 新增运行中用户消息引导（`guidance.admitted`）：在当前 Run 正常收尾前允许注入新的用户引导并精确追踪其送达状态（`waiting` / `applied` / `unapplied`），避免与正常终态产生竞态。
- 在左侧边栏与计划面板中更清晰地展示已批准计划的执行进度、阶段边界与修复入口。

### 主动子智能体协作与运行时稳定性

- 新增基于诊断分支的主动子智能体协作调度（`proactiveSubagents`）：当存在多个互不依赖的 C# 编译或 Shader 诊断目标且写入作用域互不重叠时，可安全拆分并发排查；同时严格约束子智能体预算与写入互斥。
- 改进 Runtime v2 状态机与持久化：增强 checkpoint 合并（`checkpointMerge`）、完成前置条件（`completionRequirement`）、协作决策（`collaborationDecision`）与多模型车道协调（`modelLaneCoordinator`）。
- 桌面端窗口配置启用 `backgroundThrottling: "disabled"`，避免应用切到后台时长任务定时器与流式响应被系统节流；支持工作台侧栏与面板拖拽调整尺寸。
- 设置面板新增“自动更新项目规则摘要”（`ManagedProjectRulesSettings`）开关，支持按工作区审阅并更新 `AGENTS.md` 中的 MAIN 受管区块。

## 下载

请选择对应系统的安装包，也可访问[公开 Releases 页面](https://github.com/MSTUDIOHUB/MAIN-Releases/releases)查看全部资产。

| 系统 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [MAIN_2.4.0_macOS_apple_silicon.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.0/MAIN_2.4.0_macOS_apple_silicon.zip) |
| macOS Intel / 通用版 | [MAIN_2.4.0_macOS_universal.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.0/MAIN_2.4.0_macOS_universal.zip) |
| Windows x64 | [MAIN_2.4.0_windows_x64.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.0/MAIN_2.4.0_windows_x64.zip) |

macOS 用户解压后，将 `MAIN.app` 放入 Applications。未使用 Apple Developer ID 签名与公证的 macOS 构建，首次打开如被系统拦截，可在“系统设置 → 隐私与安全性”中使用“仍要打开”。Windows 首次运行可能出现 SmartScreen 提示。

`latest.json`、`*_updater_*` 与 `.sig` 用于应用内更新及完整性校验，手动安装只需下载上表中的 zip。Updater 签名与 Apple / Windows 的开发者身份签名用途不同。

## 源码与反馈

- [公开源码与构建说明](https://github.com/MSTUDIOHUB/MAIN)
- [最新版本下载页](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest)
- [提交问题](https://github.com/MSTUDIOHUB/MAIN/issues)

本说明归档 2.4.0 的发布内容；后续运行时契约以源码仓库中的现行架构文档为准。
