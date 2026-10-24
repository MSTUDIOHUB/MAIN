# MAIN 2.3.7 发布说明

发布日期：2026-10-24  
版本跨度：2.3.5 → 2.3.7

MAIN 2.3.7 围绕 Runtime v2 的任务语义契约、工具审批与结构化结果归一化、Agent Skills 渐进式读取与全局安装、执行阻塞持久暂停及桌面端交互性能进行了系统性升级与修复。

## 主要更新

### 语义任务契约与意图澄清

- 自然语言任务统一通过结构化语义契约路由，分离工作类型、回答格式、能力需求与当前限制，并在整个 Turn 生命周期及各工具边界持续校验。
- 校准模糊工作区意图与预检控制边界：移除仅凭单一布尔值直接阻断工作区执行的路径；仅在存在可验证的目标歧义、缺失输入或能力冲突时进入 `user_choice` 澄清卡片。
- 用户澄清回答先持久化再沿原 Turn / Run 恢复执行，等待期间不额外发起模型请求；支持复用经校验的任务目标作为会话显示标题。

### 工具审批、命令执行与结构化结果

- 完善 Execute 任务授权交接与逐命令审批流程，支持会话级自动审批范围（含工作区外本地读取与命令 scope），支持从待审工具卡片按精确 owner 取消任务，并优化审批卡片居中与左对齐排版。
- 顺序执行 provider shell 工具批次并返回逐项真实回执，保留受信任参数中的引号内换行与标准流复制语法，支持工作区内规范绝对路径 CLI 参数。
- 在工具结果边界统一结构化 outcome：区分传输完成与业务成功，`run_command` 按真实 `success`、`exitCode` 与 `timedOut` 结算失败状态，避免非零退出码误记为完成证据。
- 区分“前驱失败导致的依赖未执行”、“策略/权限阻止”与“实际执行失败”：因同批前驱失败而未执行的合法动作（如 `load_skill`）不再污染拒绝集合，后续批次可正常重新提交。

### Agent Skills 与 Unity CLI 集成

- 支持全局安装可复用的 Skill 包并验证关联资源读取，补充基于 Git 的个人 Skill 安装与更新说明以及 Unity CLI / Skill 集成边界文档。
- 支持带版本化源窗口的大体积 Skill 渐进式分段读取，续读时返回精确文档目标与下一步 `load_skill` 指引。
- 在上下文预算压力与恢复续跑过程中保留有界 Skill 指引与已验证工具结果。

### 执行恢复、持久暂停与上下文管理

- 新增执行阻塞与持久暂停闭环：当同一被拒动作在出站反馈送达后再次出现时进入持久暂停，暂停期间停止继续请求模型；决策先落盘再调度，防止已执行或带部分副作用的命令被自动重放。
- 普通源码观察与常规语义失败后保持已配置的 reasoning 状态，保持普通 Execute 与 CLI 工具可用直至自然收口，并区分客户端流限制与模型完成。
- 在上下文预算允许范围内优先保留 canonical 消息、命令结果与工具回执，跨 provider 传输保持语义 JSON 契约一致。

### 桌面性能、步骤展示与会话存储

- 将工作区文件读取与目录读取移出桌面 UI 线程，减少大工作区操作时的界面卡顿。
- 改进工具步骤与读取结果展示：主界面按“成功 / 未执行 / 已阻止 / 执行失败”显示可读状态与文件/技能范围，将内部协议码、原因码与 provider 关联 ID 收纳至“调试详情”。
- 最终 Session IPC 保存统一走 canonical ledger 序列化，避免重复落盘事件与聚合缓存，并完善项目概览复用与运行时日志分析统计。

## 下载

| 系统 | 下载文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | [MAIN_2.3.7_macOS_apple_silicon.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.7/MAIN_2.3.7_macOS_apple_silicon.zip) |
| macOS Intel / 通用版 | [MAIN_2.3.7_macOS_universal.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.7/MAIN_2.3.7_macOS_universal.zip) |
| Windows x64 | [MAIN_2.3.7_windows_x64.zip](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/download/v2.3.7/MAIN_2.3.7_windows_x64.zip) |

macOS 用户解压后，将 `MAIN.app` 放入 Applications。当前 macOS 包使用 ad-hoc 签名，未完成 Apple Developer ID 签名与公证；首次打开如被系统拦截，可在“系统设置 → 隐私与安全性”中使用“仍要打开”。Windows 包未配置 Authenticode 签名，首次运行可能出现 SmartScreen 提示。

`latest.json`、`*_updater_*` 与 `.sig` 用于应用内更新及完整性校验，手动安装只需下载上表中的 zip。Updater 签名与 Apple / Windows 的开发者身份签名用途不同。

## 源码与反馈

- [公开源码与构建说明](https://github.com/MSTUDIOHUB/MAIN)
- [最新版本下载页](https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest)
- [提交问题](https://github.com/MSTUDIOHUB/MAIN/issues)

本说明归档 2.3.7 的发布内容；后续运行时契约以源码仓库中的现行架构文档为准。
