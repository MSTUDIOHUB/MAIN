# MAIN 2.4.2 发布说明

本次构建日期：2026-11-27

版本跨度：2.4.1 → 2.4.2

MAIN 2.4.2 重点新增多引擎工作区识别与按需能力绑定、自然语言语义路由精细化与实验性 OMLX 首响应融合、全流程语言一致性契约与阶段进展去重，以及 Plan 流式执行监控与持久化恢复稳定性增强。

## 主要更新

### 多引擎工作区识别与统一编码入口

- 新增 `workspace_engine.rs` 与 `workspaceEngineProfile`，统一识别工作区内的 Unity（`ProjectSettings/ProjectVersion.txt`）、Godot（`project.godot`）、Unreal（`*.uproject`）与 UEFN（`*.uefnproject`）工程结构、版本及关联信息，并按当前任务按需加载对应手册与验证能力。
- 在同一自然对话入口下明确区分普通聊天、工作区代码检查、实施与显式方案审阅边界：纯问答与无工具需求保持轻量会话响应，不再触发不必要的工作区准备。

### 语义路由优化与实验性 OMLX 首响应融合

- 自然语言进入 Plan 须由当前请求中的显式方案或修订诉求（`planRequestExcerpt`）佐证；复杂实施保持在 Execute 推进，并支持基于精确历史检查回合与源码版本续接修复。
- 在本地模型高级兼容性设置中新增默认关闭的实验性 OMLX 首响应融合（`intentFirstResponse`、`preparedReadOnlyResponse`）：在单次流式请求内解析 `MAIN_INTENT` 记录并直接衔接普通回答或有界只读提案，若首响应无效或流中断则自动回退至标准语义预检。

### 语言一致性契约与阶段进展去重

- 新增 `languageContract`，要求工具调用前的阶段说明、澄清提问与选项、子智能体摘要、计划文档正文及最终总结全程与目标语言一致，拦截不匹配的英文过渡句与计划提交并引导重写。
- 新增 `interimCommentary`，在发布阶段进展至聊天时间线前自动裁去同一 Run 内已发布的重复开头句，避免流式阶段更新重复刷屏。

### Plan 流式执行、持久化恢复与收口稳定性

- 新增 `planCheckpointRecovery`、`planProviderStream`、`planRunDiagnostics` 与 `planSubmissionToolSchema`，统一共享模型车道内的 Plan 流式指标采集、账本余量预留与取消/异常终态结算。
- 当验证阶段缺少必要回执且替代恢复未产生新动作时，运行明确进入暂停状态并提示具体缺项；优化应急终端收口与多场景启动迁移稳定性。

### 基准评测与回归覆盖增强

- 新增 `scripts/coding-agent-benchmark.mjs` 及 `coding-agent-benchmark.test.mjs`、`plan-ledger-headroom.test.mjs`、`startup-session-migration.spec.ts` 等专项测试，扩展多引擎、首响应融合与语言一致性回归覆盖。

## 下载

请选择对应系统的安装包，也可访问[公开 Releases 页面](https://github.com/MSTUDIOHUB/MAIN-Releases/releases)查看全部资产。

| 系统 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [MAIN_2.4.2_macOS_apple_silicon.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.2/MAIN_2.4.2_macOS_apple_silicon.zip) |
| macOS Intel / 通用版 | [MAIN_2.4.2_macOS_universal.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.2/MAIN_2.4.2_macOS_universal.zip) |
| Windows x64 | [MAIN_2.4.2_windows_x64.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.4.2/MAIN_2.4.2_windows_x64.zip) |

macOS 用户解压后，将 `MAIN.app` 放入 Applications。未使用 Apple Developer ID 签名与公证的 macOS 构建，首次打开如被系统拦截，可在“系统设置 → 隐私与安全性”中使用“仍要打开”。Windows 首次运行可能出现 SmartScreen 提示。

`latest.json`、`*_updater_*` 与 `.sig` 用于应用内更新及完整性校验，手动安装只需下载上表中的 zip。Updater 签名与 Apple / Windows 的开发者身份签名用途不同。

## 源码与反馈

- [公开源码与构建说明](https://github.com/MSTUDIOHUB/MAIN)
- [最新版本下载页](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest)
- [提交问题](https://github.com/MSTUDIOHUB/MAIN/issues)

本说明归档 2.4.2 的发布内容；后续运行时契约以源码仓库中的现行架构文档为准。
