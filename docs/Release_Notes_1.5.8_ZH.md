# MAIN 1.5.8 中文 Release Note

版本跨度：1.5.7 -> 1.5.8  
整理日期：2026-05-07

## 下载页短摘要

MAIN 1.5.8 重点补强了“桌面端自更新体验”“Game Studio 执行型回复衔接”和“云端工具协议容错”。新版在设置中新增 About 区域，可直接查看当前版本、检查 GitHub Release 更新、打开公开下载页并安装可用更新；同时优化了 Game Studio 中“立即开始重构并完善”这类执行型回复选项，让它们能直接续接到工作室执行链路；对于部分云端模型误输出 `[Tool call: ...]` 占位文本的问题，MAIN 现在会主动纠正并要求模型按正式 XML 工具协议重发，减少工具调用中断。

## 下载说明

- macOS Apple Silicon（M1 / M2 / M3 / M4）用户：下载 `MAIN_1.5.8_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.5.8_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.5.8_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

## 主要更新

### 桌面端 About 与更新体验

- 设置页新增 `About` 区域，可直接查看 MAIN 当前版本、最近一次检查时间和更新状态。
- 支持手动检查 GitHub Release 更新；如果检测到新版本，可在应用内直接执行“安装并重启”。
- 更新检查状态补齐了“检查中 / 已是最新 / 有可用更新 / 安装失败”等反馈，并会显示抓取到的版本说明摘要，减少用户判断成本。
- About 页增加 GitHub Releases 快捷入口，方便直接跳转到公开下载页面查看发布内容和安装包。

### 软件图标与桌面细节

- 新增浅色 / 深色两套 MAIN 软件图标样式，可在设置中切换白底黑 M 与黑底白 M。
- 前端窗口图标与 macOS 应用图标会尽量在运行时同步更新；如果系统当前未立即刷新，重启应用后也会再次应用所选样式。
- 桌面端相关资源、配置与打包版本号同步更新到 `1.5.8`，确保安装包、更新清单与应用内版本展示一致。

### Game Studio 执行型回复衔接

- 在 Game Studio 中，如果模型给出“立即开始重构并完善”“继续实现 SnakeController”这类执行型回复选项，用户点击后会直接续接到 `studio_workflow` 执行链路，而不是退回普通讨论模式。
- 针对回复选项的续接逻辑做了增强：即使当前回合主要处于 reply options 选择态，也能复用原始回合上下文继续执行，减少断层。
- 执行意图识别补充了“重构 / 完善 / 改造 / 接入 / 集成 / build / fix / integrate”等表达，在工作室场景下对明确实现请求的判断更稳。

### 云端工具协议兼容性与恢复能力

- 系统提示词现在明确禁止模型输出 `[Tool call: ...]`、`Tool call: read_file`、`我要调用工具` 这类伪工具占位文本，避免它们被误当成正常响应。
- 如果云端模型仍然输出伪工具占位文本，MAIN 会自动补发恢复提示，要求模型立即改用正式 `<tool_use>` XML 协议并补齐必填参数，而不是直接把错误文本展示给用户后中断流程。
- 对云端工具协议 E2E 场景做了补充，新增伪工具占位恢复与 Game Studio 执行型回复两个回归测试场景，覆盖更真实的弱兼容网关行为。

### MCP 服务器管理

- MCP 服务器现在支持单独启用 / 关闭，不再只能添加和移除。
- 已关闭的 MCP 服务器不会参与工具发现、路由与注入，已发现工具列表也会随启用状态自动过滤，减少离线或临时停用服务带来的误调用。
- 默认 MCP 配置与持久化恢复逻辑同步补强，避免历史配置缺失 `enabled` 字段时出现状态不一致。

## 修复与稳定性

- 修复 Game Studio 中执行型快捷回复可能被错误当成普通讨论继续，导致没有进入工作室工具链路的问题。
- 修复某些云端模型只返回伪工具占位文本时，MAIN 无法继续引导其发出正式工具调用的问题。
- 改进回复选项识别规则，覆盖更多中文和英文实现类表达，减少“用户已经明确要求开始做事，但系统仍停留在确认阶段”的情况。
- 改进桌面端更新检查失败时的错误提示与调试日志记录，便于定位 GitHub Release、签名更新包或网络相关问题。
- 改进运行时图标切换和设置状态回滚逻辑，减少取消设置后界面状态与实际配置不一致的问题。

## 验证覆盖

- 新增 / 补充 Node 测试，覆盖 reply options 执行动作识别、Game Studio 执行意图判断、系统提示词中的伪工具调用禁令，以及伪工具恢复提示生成。
- 新增 / 补充 Playwright E2E，覆盖 Game Studio 执行型回复直接进入工作室工具链路，以及 `[Tool call: ...]` 伪工具占位文本的自动恢复流程。

## 推荐展示文案

MAIN 1.5.8 是一次围绕“更新体验更清晰、工作室执行衔接更顺、云端工具调用更稳”的增强更新。它把桌面端 About 与自更新入口整理成一个更完整的用户面板，也让 Game Studio 中明确的实现型回复可以更自然地继续进入执行链路；同时针对部分云端模型常见的伪工具占位输出，加入了自动恢复与协议纠偏，减少真实项目里因为网关兼容性差异导致的工具调用中断。

---

## 当前工作区新增变化（待提交）

以下内容是当前工作区相对上一版 `1.5.8` 已整理但尚未提交的新增改动摘要。

### 云端账号登录与安全存储

- 云端设置新增认证方式切换，除传统 `API Key` 外，支持 `OpenAI 登录` 与 `Gemini 登录` 两条实验链路。
- OpenAI 实验登录会通过系统浏览器完成 OAuth，并在登录后切换到 ChatGPT / Codex 兼容端点；Gemini 实验登录则走 Google OAuth 与 Gemini API / Code Assist 兼容路线。
- 前端只保存 `tokenRef` 等摘要信息，真实 access token / refresh token 交由 Rust 后端处理，不再暴露到前端配置里。
- Rust 后端新增云端 OAuth 生命周期接口，包括 `cloud_auth_begin`、`cloud_auth_finish`、`cloud_auth_status` 与 `cloud_auth_logout`，打通浏览器授权、本地回调、token 刷新和退出登录流程。
- token 默认保存在本机 app data 文件并收紧到 `0600` 权限；在 macOS 上如果 Keychain 可用，会优先写入系统钥匙串。

### Gemini 协议与实验模型支持

- 云端协议新增 `Gemini` 选项，补齐模型列表地址、`generateContent` 请求地址和 Gemini 响应文本提取逻辑。
- 新增 Gemini 请求体构造器与响应解析器，支持从现有对话消息生成 Gemini 原生 `contents` / `systemInstruction` 结构。
- Gemini API Key 会走 `x-goog-api-key` 请求头；Gemini OAuth 登录模式则改用 Bearer token。
- 补充 Gemini 实验模型候选列表，并在设置中给出 `GOOGLE_CLOUD_PROJECT` 提示，方便 Workspace / 企业 / Code Assist 场景排查。

### 云端设置面板重构

- 云端设置新增“认证方式”面板，可在 API Key、OpenAI 登录、Gemini 登录之间直接切换。
- 新增实验登录状态显示，包括已登录账号、登录过期、存储位置和手动打开授权链接等反馈。
- 将 Endpoint、请求头、API Format、工具协议、响应存储与推理强度整合进折叠的“高级兼容性”区域，默认首屏更简洁。
- 默认隐藏 `Temperature` 与 `Top P` 采样参数，减少在弱兼容网关上的无效扰动。
- OpenAI 登录模式下会额外展示实际使用的 Codex endpoint，方便排查兼容性问题。

### 请求链路与代理兼容性

- 流式请求、非流式请求、预检请求、语义标题生成与 AI commit message 生成，现在都能透传 `authMode` 与 `tokenRef`，统一走 Rust 代理侧的 OAuth token 注入逻辑。
- OpenAI ChatGPT OAuth 模式下，请求头会去掉常规 `Authorization` / `x-api-key` 自动拼装，改由后端注入 Bearer token 与必要账号标识。
- Gemini OAuth 模式下，请求头会改由后端注入 OAuth Bearer，不再复用 API Key 路径。
- 针对 OpenAI / Gemini 的兼容性路径，云端聊天、预检与辅助生成任务中都收紧了采样参数发送策略，减少对弱兼容端点的额外干扰。

### 稳定性与测试覆盖

- 补充 Node 测试，覆盖 Gemini URL / request body / response 解析、云端认证模式归一化、OAuth 头部处理，以及 Gemini / OpenAI OAuth 下的流式代理路由。
- 补充云端设置 Playwright E2E，覆盖高级兼容性折叠、OpenAI 实验登录、Gemini 登录提示和模型刷新后的候选展示。
- 补强云端配置归一化逻辑，确保 legacy 配置迁移到新 auth 结构后仍能保持可用。
