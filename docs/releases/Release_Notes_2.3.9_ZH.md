# MAIN 2.3.9 发布说明

本次构建日期：2026-11-08

版本跨度：2.3.8 → 2.3.9

MAIN 2.3.9 重构了计划访谈与版本化计划文档、新增 `/规则` 项目规则访谈、支持知识库 `#` 消息级资料选择与检索，并统一了桌面工作台入口与旧特性迁移。

## 主要更新

### 结构化计划访谈、版本化计划文档与验证补全

- 输入 `/计划` 后，MAIN 先调查项目事实，再通过执行胶囊展示结构化问卷（`UserQuestionnaire`），支持单选、多选、补充文字及选择数量校验；推荐项不会自动替用户提交，问答记录保留在对话中。
- 访谈完成后保存独立版本化的计划文档：工作区会话保存在 `.MAIN/plans/<documentId>/rev-<n>.md`，普通聊天保存在应用数据目录对应会话下，不同会话互不覆盖，可在聊天卡片点击“查看文档”。
- 区分“仅形成方案文档”与“可执行实施计划”：概念方案保存文档后即可完成，无需虚构文件改动或验证命令；实施计划需在文档保存回执、引用身份与 `SealedWorkPlan` 一致后进入独立审批对话框，批准后方可执行。
- 新增“草稿 · 待补全验证”状态：当实施方案已有正文但验证方式或步骤结构尚未完整时，先保存草稿并列出缺口，点击“补全验证”可在保留原目标与已确认决定的前提下发起新轮次补全，避免整份方案反复重写。

### `/规则` 项目规则访谈与 `AGENTS.md` 审阅

- 输入框 `/` 菜单收敛为 `/计划` 与 `/规则`（`/rules` 与 `/init` 作为 `/规则` 的兼容别名保留）。
- `/规则` 进入规则专用的计划访谈流程：先调查当前项目与根目录 `AGENTS.md`，询问关键工程约束并保存规则草稿，随后打开可编辑正文与 Diff 的审阅窗口。
- 仅在用户确认保存后才通过专用 CAS IPC 写入根目录 `AGENTS.md`，保留人工编写的规则内容，并在文件发生变化时阻止过期草稿覆盖。

### 知识库 `#` 消息级选择与本地词面检索

- 知识库升级为可跨项目复用的个人资料库；在聊天输入框输入 `#` 即可搜索并多选整库或单篇资料，普通 Markdown 标题不会误触发资料选择。
- 选中的资料标签仅随当前消息提交生效，下一条消息默认不继续绑定；首次模型请求前由运行时自动执行本地中英文词面检索，无需依赖模型主动调用检索工具。
- 新增本轮资料证据面板，支持展开核对来源、页码、命中片段与覆盖范围；单篇资料无关键词命中时提供明确标注的有限开头概览，资料内容仅作为参考上下文，不授予指令或工具权限。

### 工作台入口收敛与旧特性安全迁移

- 移除底部模式切换菜单、图像工作室（Image Studio）及独立长期目标自动续跑（Goal 模式）；问答、研究、代码、文档、游戏开发与 MCP 工具调用统一使用同一套 MAIN Turn、Plan、Execute、权限与验证流程。
- 新增启动期幂等迁移：保留历史聊天文本、普通图片输入、附件、截图、工具记录及用户工作区已产出的文件；将未结束的历史 Goal 安全归档为普通已完成对话，不再自动续跑。

### 执行胶囊活动历史与运行时修复

- 执行胶囊新增实时活动与历史详情弹窗，清晰展示当前步骤、工具进展与历史操作记录。
- 完善语义意图路由：区分 `operate` 标签与实际能力需求（声明写入、命令或外部交互进入 Execute，仅工作区读取进入 Analyze，无工具需求进入 Respond），并支持以上一条相关请求作为续接参考上下文。
- 强化写入授权与恢复边界：写文件前按实际目标路径与状态校验源码读取凭据，完善源码前置读取重试、流式原生工具历史、联网完成判定与工作区工具作用域隔离。

## 下载

请选择对应系统的安装包，也可访问[公开 Releases 页面](https://github.com/MSTUDIOHUB/MAIN-Releases/releases)查看全部资产。

| 系统 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [MAIN_2.3.9_macOS_apple_silicon.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.9/MAIN_2.3.9_macOS_apple_silicon.zip) |
| macOS Intel / 通用版 | [MAIN_2.3.9_macOS_universal.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.9/MAIN_2.3.9_macOS_universal.zip) |
| Windows x64 | [MAIN_2.3.9_windows_x64.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.9/MAIN_2.3.9_windows_x64.zip) |

macOS 用户解压后，将 `MAIN.app` 放入 Applications。未使用 Apple Developer ID 签名与公证的 macOS 构建，首次打开如被系统拦截，可在“系统设置 → 隐私与安全性”中使用“仍要打开”。Windows 首次运行可能出现 SmartScreen 提示。

`latest.json`、`*_updater_*` 与 `.sig` 用于应用内更新及完整性校验，手动安装只需下载上表中的 zip。Updater 签名与 Apple / Windows 的开发者身份签名用途不同。

## 源码与反馈

- [公开源码与构建说明](https://github.com/MSTUDIOHUB/MAIN)
- [最新版本下载页](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest)
- [提交问题](https://github.com/MSTUDIOHUB/MAIN/issues)

本说明归档 2.3.9 的发布内容；后续运行时契约以源码仓库中的现行架构文档为准。
