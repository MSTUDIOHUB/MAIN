# MAIN 1.5.9 中文 Release Note

版本跨度：1.5.8 -> 1.5.9  
整理日期：2026-05-08

## 下载页短摘要

MAIN 1.5.9 重点补强了“云端账号登录兼容性”“长会话上下文记忆”和“外部本地文件读取审批”。新版把 OpenAI / Gemini 的实验登录入口收敛到设置中的实验室开关下，并把 Gemini 登录链路明确为 Gemini Code Assist 兼容通道；同时把上下文压缩升级为结构化任务记忆，在长任务里更能保住目标、约束、进度和关键文件；对于工作区之外的本地文件读取，也新增按文件粒度的首次审批，既能读取需要的日志或外部材料，又不会无感放开整个本机文件系统。

## 下载说明

- macOS Apple Silicon（M1 / M2 / M3 / M4）用户：下载 `MAIN_1.5.9_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.5.9_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.5.9_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

## 主要更新

### 云端设置与实验登录入口整理

- 云端设置默认继续以 `API Key` 为主线；只有开启“实验室”开关后，才会显示 `OpenAI 登录` 与 `Gemini 登录` 这两条实验入口。
- 设置页把原先偏技术化的“高级兼容性”整理为更易理解的“详细设置”，Endpoint、请求头、响应存储和推理强度等高级项仍然可配，但默认首屏更干净。
- `Temperature` 和 `Top P` 采样参数默认隐藏，减少在弱兼容云网关上的无效扰动。
- 前端只保存 `tokenRef` 和登录状态等摘要信息，真实 access token / refresh token 交给后端安全存储；在 macOS 上如果 Keychain 可用会优先写入钥匙串，否则回退到本地 app data 并收紧到 `0600` 文件权限。

### OpenAI Codex 与 Gemini Code Assist 兼容更新

- OpenAI ChatGPT OAuth 登录链路补齐了更稳的 Codex / Responses 兼容请求体：会主动补齐 `instructions`、`stream: true`、`store: false` 和 `user_prompt_id`，并优先使用更适配的 `input_text` 结构。
- Gemini Google OAuth 现在明确走 Gemini Code Assist 兼容通道，而不是复用普通 Gemini API Key 路线；登录后会自动固定到 `cloudcode-pa.googleapis.com`，并在需要时提示 `GOOGLE_CLOUD_PROJECT`。
- 云端设置会在 OpenAI / Gemini 不同认证方式之间自动修正不匹配的旧 Endpoint，减少“模型已切换，但请求仍打到旧地址”的兼容问题。
- `authMode` 与 `tokenRef` 现在会贯穿流式请求、预检、标题生成和 AI commit message 生成等辅助链路，统一复用后端 OAuth token 注入逻辑。

### 上下文记忆与压缩摘要升级

- 新增结构化 `ContextMemoryState`，会把长任务中的目标、约束、决策、进度、证据、关键文件、阻塞项和下一步动作整理成状态化记忆，而不再只依赖零散对话片段。
- 背景压缩结果现在会产出更清晰的 `memoryPacket`、`microCompactionKind` 和 `microCompactedCount`，区分“历史上下文压缩”“长工具输出截断”和“上下文溢出保护”等不同场景。
- 聊天区中的压缩提示文案同步更新，用户能更直观看到当前是普通历史压缩、长内容整理，还是长工具输出被截断。
- runtime snapshot 现在会持久化 `contextMemoryState`，并在新建空会话、切换到空白工作区或恢复空会话时一并清空，避免把旧记忆误带进新的空白上下文。

### 外部本地文件读取审批更细

- 新增 `local_file_read` 风险级别：当 `read_file`、`read_document`、`analyze_tabular_document` 或 `query_tabular_document` 读取工作区之外的绝对路径文件时，会要求用户先批准。
- 用户允许后，批准会按“单个文件路径”在当前会话内生效，不会直接放开所有后续命令或整个本机文件系统。
- 通过审批的外部文件会先被导入到当前对话的临时附件工作区，再交给读取工具处理，既保留读取能力，也维持会话边界和可追踪性。
- 如果用户拒绝，系统不会提前导入文件，也不会偷偷读取内容。

### 附件与交互细节

- `.log` 文件现在被视为文本附件，可直接附加调试日志、运行日志或崩溃日志给模型分析。
- 工具审批卡片在“外部本地文件读取”场景下会显示更准确的说明文案，明确告诉用户“允许后，本会话内不再重复询问这个文件”。
- 对聊天区里信息价值不高的待执行 `write_file` / `replace_in_file` 中间卡片做了隐藏收敛，让执行流阅读更清爽。

### 品牌图标与版本同步

- `LogoM_app.svg` 与多平台应用图标资源已整体刷新，桌面端、iOS、Android 和 Windows 打包图标同步更新。
- 前端版本、Tauri 配置、Cargo 版本与平台打包版本统一同步到 `1.5.9`。

## 修复与稳定性

- 改进 OpenAI / Gemini 不同认证模式下的请求头、请求体和 Endpoint 兼容策略，减少实验登录链路中的误配和探测失败。
- 改进长会话压缩后的恢复信息结构，减少压缩提示只剩统计数字、缺少任务关键信息的问题。
- 改进工作区外本地文件读取的审批边界，避免会话级自动放行把外部文件读取一并跳过审查。
- 改进云端设置保存与测试流程，降低历史配置从旧结构迁移到新认证结构时的错配风险。

## 验证覆盖

- 新增 / 补充 Node 测试，覆盖 OpenAI / Gemini OAuth 请求构造、Responses SSE 文本解析、上下文记忆压缩、外部本地文件读取审批、工具风险判定和 `.log` 附件支持。
- 新增 / 补充 Playwright E2E，覆盖实验室开关下的 OpenAI / Gemini 登录 UI、模型刷新探测，以及工作区外本地文件读取的批准 / 拒绝流程。

## 推荐展示文案

MAIN 1.5.9 是一次围绕“云端登录更稳、长任务记忆更清楚、本地文件边界更可控”的增强更新。它把 OpenAI / Gemini 的实验登录链路收拢到更清晰的设置入口，并补齐了 Codex 与 Gemini Code Assist 兼容请求细节；同时把上下文压缩升级为结构化任务记忆，让长会话在被压缩后仍能保住目标、证据和下一步；对于工作区外日志或材料的读取，也新增按文件粒度审批，既方便真实排障，又不会无感放开整个本地文件访问范围。
