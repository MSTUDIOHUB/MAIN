# MAIN 1.6.3 中文 Release Note

版本跨度：1.6.2 -> 1.6.3  
整理日期：2026-05-09

MAIN 1.6.3 重点强化了“回复语言一致性控制”“Unity MCP 优先诊断路径”和“回合过程压缩留痕策略”。本版新增可配置的回复语言策略，并在模型输出与回合重试链路中加入语言偏差自动纠偏；Unity 相关请求会优先走 Unity MCP 工具并支持首轮失败自动回退到本地诊断；同时新增“完整过程留存”调试开关，在默认模式下回合完成后自动压缩过程消息，仅保留结论、改动摘要与异常详情。

## 主要更新

### 回复语言策略与自动纠偏

- 通用设置新增“回复语言策略”：`follow_input_language`（跟随输入语言）与 `prefer_system_language_with_explicit_switch`（系统语言优先，显式指令可切换）。
- 统一回合语言解析逻辑：普通发送、待确认重放、Game Studio 工作流命令均使用同一套目标语言解析器。
- 新增显式语言切换识别（中英双向），例如“请用英文回复 / reply in chinese”可覆盖默认策略。
- Orchestrator 新增“语言不匹配恢复”机制：当可见回复语言与本轮目标语言不一致且未触发工具调用时，自动发起一次纠偏重试，减少中英文串线。

### Unity MCP 优先路由与自动回退

- MCP 发现结果新增服务器状态快照（`connected` / `failed` / `disabled`），并把状态信息回传给调度层做策略决策。
- Unity 任务下启用 Unity MCP 优先路由：优先选择 Unity 服务器工具，控制台诊断场景会强制优先 `read_console`（必要时配合 `set_active_instance`）。
- 若 Unity MCP 首轮未触发工具调用，或关键调用缺失/失败（如 session、unreachable、route mismatch 等），会自动回退到本地只读诊断路径并给出明确续跑提示。
- MCP 调用失败信息标准化为 `MCP_CALL_FAILURE[...]`，便于统一分类恢复与排障。

### 回合过程压缩与调试留痕开关

- 调试面板新增“记录完整回合过程”开关（默认关闭）。
- 默认模式下，回合完成后会对 `agentMessages` 执行压缩：保留用户输入与最终结论，同时补充“本轮改动统计”和“异常详情”，减少冗余流水。
- 开启调试开关后可保留完整工具/过程轨迹，便于复杂问题复盘。

### 交互与意图细节优化

- Top Island 展示规则收敛：不再因普通工具活动虚构执行进度，只有真实“阻塞选择”或“进度上下文”才驻留显示。
- 会话回合折叠卡片重排：标题、意图、状态、摘要与变更信息布局更紧凑，历史扫描更直接。
- MAIN 显式执行快捷词进一步收敛：不再解析 `/执行` / `/execute` 作为主入口意图快捷命令，减少误触执行模式。
- Reply Options 对“修复/修改”类选项动作识别增强，执行型选项更稳定映射为 `execute_once`。

## 修复与稳定性

- 修复多语言输入与工作流命令混合场景下的回复语言漂移问题。
- 改进 Unity 排障场景中“有 MCP 但未优先使用”的路径偏移风险。
- 改进复用回合（继续处理同一问题）时的意图升级判定，降低该执行却停在讨论态的概率。
- 优化历史消息体积，降低长会话下的上下文噪声累积与持久化负担。

## 验证覆盖

- 新增 Node 测试：`tests/node/orchestrator-language-mismatch.test.mjs`，覆盖语言不匹配纠偏重试与一次性上限。
- 新增/更新 Node 测试：`workflow-models` 覆盖语言策略归一化、显式语言指令识别、目标语言解析与自然语言失配检测。
- 新增/更新 Node 测试：`tool-capabilities` 覆盖 Unity MCP-first 路由与 `read_console` 强制前置行为。
- 更新 Node 测试：`run-intent`、`reply-options`、`system-prompt`、`game-studio-catalog`、`im-adapters`，覆盖新意图语义与语言约束文案。
- 更新 E2E：`tests/e2e/top-island-execution-progress.spec.ts`，验证无真实进度时不显示 Top Island 执行进度壳层。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_1.6.3_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.6.3_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.6.3_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件
