# MAIN 1.6.6 中文 Release Note

版本跨度：1.6.5 -> 1.6.6  
整理日期：2026-05-11

MAIN 1.6.6 重点强化了“云端兼容回退隔离”“远程上下文超限自恢复”和“多配置切换的状态连续性”。本版将 provider compatibility 的 XML 回退策略从全局逻辑升级为按运行通道（profile/provider/model/protocol/toolProtocol/apiFormat/auth）独立管理，避免一个云端网关的兼容问题污染其他配置；同时在云端出现 context length 错误时，新增一次本地压缩后重试流程，不再直接失败；并把上下文记忆与兼容回退状态一起做了分通道持久化，切换模型或服务后更稳。

## 主要更新

### Provider Compatibility 回退按“运行通道”隔离

- 新增运行通道键（runtime lane key），由 `profile/provider/model/toolProtocol/protocol/apiFormat/auth` 组成，用来隔离不同配置的兼容策略状态。
- 当云端出现 provider compatibility 错误时，只对当前通道开启“强制 XML 工具协议”，不会影响其他云端服务或模型配置。
- 强制 XML 回退增加 TTL（12 分钟）自动过期机制，过期后会自动清理回退状态。
- 引入“原生工具调用成功计数”恢复逻辑：同一通道连续成功达到阈值后，会自动退出兼容回退状态，恢复原生 tools 路径。

### 云端 Context Length 错误新增“压缩后重试一次”

- 过去云端遇到远程上下文超限会直接报错停止；现在会先触发一次本地强制压缩（含 context memory），再重试本轮请求。
- 重试过程中会同步回写压缩统计与上下文状态，维持回合可观测性。
- 若压缩后仍超限，才给出明确失败提示，指引用户开启新会话或缩短历史。

### 上下文记忆改为按通道持久化

- `contextMemoryState` 扩展为按 runtime lane 存储（`contextMemoryStateByRuntimeKey`），不同模型/协议通道各自维护记忆，不再混用。
- 切换配置时会自动加载对应通道的上下文记忆，降低“上一通道残留上下文”对当前对话的干扰。
- Session runtime snapshot 新增按通道的 context memory 与 provider compatibility 状态持久化，重启后恢复更完整。
- `setConfig` 切换配置后会按当前 lane 自动对齐上下文记忆，减少“切换模型后沿用旧上下文”的错位感。

### 工具协议决策链路收敛

- `shouldUseXmlToolProtocol` 增加兼容覆盖参数（override），支持强制启用或强制关闭 XML，避免“自动判定”和“兼容回退”互相冲突。
- 回合启动、迭代执行、压缩重试等阶段的 `nativeToolsEnabled` 判定统一使用同一逻辑，工具协议行为更一致。
- 当原生工具调用成功时，新增回调上报，为兼容回退自动恢复提供可靠信号。

### 运行时工具事件与反馈封装（新增）

- 新增 `runtimeTools` 运行时规划模块：统一产出工具调用的计划动作（auto execute / review required / blocked 等）与生命周期初始状态。
- 编排层工具结果增加生命周期状态标注（`completed / failed / declined / blocked`），让“失败、拦截、拒绝、无变化”等状态更可区分。
- 新增 `toolFeedbackEnvelope`（`[MAIN_TOOL_FEEDBACK_V1]`）：对工具结果增加结构化头部，保留 `tool_call_id/tool/target/status/summary`，便于后续兼容重放和诊断。
- Provider compatibility 重试链路支持识别并保留 envelope 头，避免降级重试时丢失关键工具上下文。
- 新增 `turnEvents` 事件模型与 ring buffer（`thread/turn/item/error`），支持运行时事件流的结构化记录。

### 版本与打包配置同步到 1.6.6

- 前端与桌面端版本号已同步更新到 `1.6.6`（`package.json`、Tauri/Cargo 配置）。
- macOS / Windows bundle 版本号同步刷新，确保安装包显示版本与应用内版本一致。
- `Release_Notes_1.6.6_ZH.md` 已纳入发布内容，方便后续直接用于公开下载页说明。
- 新增配置项 `eventStreamMode` 与 `toolFeedbackFormat`，并完成持久化与恢复路径接入。

## 修复与稳定性

- 修复多云端配置并行使用时，兼容回退状态可能串线的问题。
- 改进配置切换后的上下文记忆一致性，减少跨配置“历史污染”导致的意图偏移。
- 改进远程超限场景下的失败路径，优先尝试可恢复策略，再进入终止错误。
- 持久化快照新增 `contextMemoryStateByRuntimeKey` 与 `providerCompatibilityByRuntimeKey`，多次重启后状态恢复更稳定。

## 验证覆盖

- 本次改动集中在运行时编排与状态管理层（`orchestrator` / `useAppStore`）。
- 新增/更新 Node 测试：
  - `tests/node/runtime-tools-events-envelope.test.mjs`（运行时工具规划、事件流与 envelope 解析）
  - `tests/node/provider-compatibility.test.mjs`（兼容重试保留工具反馈 envelope 头）
- 建议发布前至少执行：
  - `npm run test:workflow-assets`
  - `npm run release:desktop -- 1.6.6`

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_1.6.6_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.6.6_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.6.6_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件
