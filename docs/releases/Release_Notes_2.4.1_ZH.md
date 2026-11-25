# MAIN 2.4.1 发布说明

本次构建日期：2026-11-24

版本跨度：2.4.0 → 2.4.1

MAIN 2.4.1 重点强化了已批准计划下的子智能体并发写入委派与暂存提交、审查发现（Review Findings）处置闭环、终态验收事实快照与紧凑收口上下文，以及计划验证确认控制与模型车道并发估算能力。

## 主要更新

### 已批准计划的子智能体写入委派、暂存与并发控制

- 新增 `planSubagentAuthorization` 与 `executionSubagentStaging`，针对已批准工作计划（WorkPlan）的前沿步骤校验目标锁定互斥、依赖顺序、操作类型与源码版本新鲜度，支持安全委派子智能体并发修改互不重叠的文件，并在暂存提交阶段统一验证落盘。
- 完善主动子智能体调度（`proactiveSubagents`）、子智能体汇聚与报告汇总（`executionSubagentJoin` / `subagentReport`），以及同回合缺陷修复委派流程，避免并发子任务互相覆盖或遗漏写权限边界。

### 审查发现处置闭环与缺陷修复

- 新增 `reviewFindings` 与 `resolve_review_finding` 工具：为审查产出的 `blocking` 与 `advisory` 问题建立结构化状态账本（`pending` / `repaired` / `falsified` / `deferred_unresolved`）。
- 支持在限定修复轮次内对阻塞性问题进行闭环修复、证伪核验或显式延迟记录，防止严重审查问题在收口阶段被静默跳过。

### 终态验收事实快照与紧凑收口上下文

- 新增 `terminalFacts`（`deriveRuntimeV2TerminalAcceptanceFacts`）与 `executionConcludeContext`（`buildCompactRuntimeV2ConcludeConversation`），统一汇总交付文件、步骤完成度、自动化验证、Unity 编译/Shader 导入校验、人工检查清单及审查处置结果。
- 在 `conclude` 总结阶段自动压缩历史大体积工具输出与调用参数，在完整保留用户指令、补充引导和验收事实的前提下降低总结请求上下文膨胀。

### 计划验证确认、模型车道并发与问卷体验优化

- 新增计划验证确认控制（`planVerificationControl`）、本地并发估算（`localConcurrencyEstimate`）、模型车道协调增强（`modelLaneCoordinator`）与 Provider 语言一致性重试（`executionProviderLanguageRetry`）。
- 优化结构化问卷表单（`UserQuestionnaireForm`）、问答历史展示（`UserQuestionAnswerHistory`）及计划审批对话框与计划面板交互（`PlanApprovalDialog`、`PlanPanel`）。

### CI 与专项回归测试增强

- CI 回归测试阶段升级至 Node 24（`.github/workflows/ci.yml`），原生支持运行 TypeScript 回归测试夹具。
- 新增已批准计划委派、缺陷修复恢复、风险审查处置与子智能体暂存并发等专项 Node 回归测试。

## 下载

请选择对应系统的安装包，也可访问[公开 Releases 页面](https://github.com/MSTUDIOHUB/MAIN-Releases/releases)查看全部资产。

| 系统 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [MAIN_2.4.1_macOS_apple_silicon.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.1/MAIN_2.4.1_macOS_apple_silicon.zip) |
| macOS Intel / 通用版 | [MAIN_2.4.1_macOS_universal.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.1/MAIN_2.4.1_macOS_universal.zip) |
| Windows x64 | [MAIN_2.4.1_windows_x64.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.1/MAIN_2.4.1_windows_x64.zip) |

macOS 用户解压后，将 `MAIN.app` 放入 Applications。未使用 Apple Developer ID 签名与公证的 macOS 构建，首次打开如被系统拦截，可在“系统设置 → 隐私与安全性”中使用“仍要打开”。Windows 首次运行可能出现 SmartScreen 提示。

`latest.json`、`*_updater_*` 与 `.sig` 用于应用内更新及完整性校验，手动安装只需下载上表中的 zip。Updater 签名与 Apple / Windows 的开发者身份签名用途不同。

## 源码与反馈

- [公开源码与构建说明](https://github.com/MSTUDIOHUB/MAIN)
- [最新版本下载页](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest)
- [提交问题](https://github.com/MSTUDIOHUB/MAIN/issues)

本说明归档 2.4.1 的发布内容；后续运行时契约以源码仓库中的现行架构文档为准。
