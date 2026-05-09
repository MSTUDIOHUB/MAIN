# MAIN 1.6.2 中文 Release Note

版本跨度：1.6.1 -> 1.6.2  
整理日期：2026-05-09

MAIN 1.6.2 重点强化了“思考输出策略可控性”“MCP 服务器联调诊断能力”和“会话列表时序稳定性”。本版将旧的思考显示配置收敛为双档 Thinking Policy（正常 / 仅结论与动作），并在提示词、流式处理中统一执行；同时为 MCP 增加单服务测试入口与分类诊断信息（连接、路由、请求头、RPC、响应格式），降低接入排障成本；会话排序也改为优先依据 `updatedAtMs`，跨工作区与重启后的会话顺序更一致。

## 主要更新

### Thinking Policy 双档化（替代旧思考显示模式）

- 设置项由原“思考显示”三档收敛为“思考策略”两档：`normal` 与 `action_only`，并提供旧配置自动迁移。
- `action_only` 模式下会抑制思考块写入与展示，聊天流中仅保留结论、动作与执行结果。
- 系统提示词新增 Action-only 约束段，减少长推理文本回显；云端推理强度在该模式下自动收敛为 `none`。
- 思考文本提炼逻辑更新为统一摘要输出，保留关键信息并去除重复噪声。

### MCP 连接测试与诊断链路增强

- MCP 服务器面板新增“测试”按钮，支持逐个服务快速验证连通性与工具发现状态。
- 新增分类诊断反馈：`unreachable`、`route_mismatch`、`header_mismatch`、`rpc_error`、`invalid_response`、`empty_tools` 等。
- MCP 客户端重构为会话化初始化流程，支持 `mcp-session-id` 复用、`initialize` 生命周期与 SSE/JSON-RPC 响应解析。
- Rust 侧新增 `proxy_request_detailed` 命令，返回状态码、响应头与响应体片段，前端可据此提供更精确错误提示。

### 会话时间戳与排序一致性改进

- 会话创建与发送链路补充 `updatedAtMs` 更新，确保最新交互优先排序。
- Rust 会话索引与读取逻辑统一按 `updatedAtMs -> updatedAt -> date -> id` 进行降序排序。
- Sidebar 与主界面会话列表同步采用更新时间展示与排序，减少“新会话排在后面”的错位感。

### macOS 应用图标刷新能力补强

- macOS 图标切换时，除运行时图标外，也会尝试同步更新 `.app` bundle 图标并触发系统文件变更通知。
- 降低切换图标后 Finder/启动台图标刷新不及时的问题。

## 修复与稳定性

- 改进工作区切换时的会话持久化节奏，减少阻塞式等待带来的切换停顿感。
- 改进思考内容持久化体积与噪声控制，降低历史会话中的冗余过程文本。
- 改进 MCP 发现失败时的可观测性，排查“地址不通 / 路由错误 / 头不匹配”更直接。
- 统一 E2E 场景命名与行为（`thought-display-mode` 升级为 `thinking-policy`），减少测试与配置语义偏差。

## 验证覆盖

- 新增 E2E：`tests/e2e/thinking-policy.spec.ts`，覆盖思考策略切换、UI 可见性与刷新后持久化行为。
- 调整 E2E：`theme-black-mode` 场景切换到 `thinking-policy`，保持主题测试与新配置体系一致。
- 更新 Node 测试：覆盖 Thinking Policy 归一化、旧字段迁移、思考摘要去噪与系统提示词参数兼容。

## 下载说明

- macOS Apple Silicon（M1 / M2 / M3 / M4）用户：下载 `MAIN_1.6.2_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.6.2_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.6.2_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件
