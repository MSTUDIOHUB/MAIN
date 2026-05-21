# MAIN 1.6.5 中文 Release Note

版本跨度：1.6.4 -> 1.6.5  
整理日期：2026-05-10

MAIN 1.6.5 重点强化了“Game Studio 计划入口收敛”“工具调用生命周期可视化”和“Unity/MCP 诊断恢复链路稳定性”。本版将 Game Studio 中的 MAIN 快捷入口收敛为 `plan`，避免执行/报告类入口误入；工具执行卡片新增按 `toolCallId` 的生命周期对齐与批量完成分组展示，减少长回合里重复卡片噪声；同时补强 Unity 场景下的首轮回退判定、`read_console` 软提醒、`<tool_code>` 非标准工具格式纠偏和语言失配处理，让复杂执行回合更稳、更可控。

## 主要更新

### Game Studio 计划入口与续跑语义收敛

- Game Studio 模式下，`/` 菜单中的 MAIN 快捷入口收敛为 `plan`，不再暴露 `/报告` 等非计划入口，降低误触发意图切换风险。
- 支持在 Game Studio 中通过 `Shift + Tab` 快速切换计划意图锁定；从前导 `/` 选择计划入口时会保留原始输入内容。
- “继续”类消息在 Game Studio 里可正确复用上一轮计划回合，不再错误新开普通回合。
- Composer 意图建议与快捷解析改为“按模式过滤”，确保不同主模式只出现允许的意图入口。

### 工具调用生命周期与会话展示优化

- 工具执行状态流新增 `toolCallId` 贯穿：`onToolExecuting / onToolDone / onToolError` 会优先按调用 ID 回填，避免同名同目标工具在并发场景下串卡。
- 新增 `toolLifecycle` 匹配逻辑：优先按 `toolCallId` 命中，失败再回退到 `toolName + target`，提升状态更新稳定性。
- 聊天区新增“已完成工具调用分组卡片”（Game Studio 回合），可将连续完成的工具调用折叠汇总，同时保留当前运行中工具卡片与活动提示。
- 回合活动提示补充“已完成 N 次”上下文，执行态信息密度更高；用户手动中断时，运行中工具会落到 `rejected` 而非笼统 `failed`。
- 新回合创建时自动折叠上一回合，减少长会话滚动噪声。

### Top Island 交互与样式升级

- Top Island 选项区新增编号展示，支持“真实分叉选项”与“执行批准动作”分区显示，避免把授权动作误读为模型分支提问。
- 自定义输入项加入编号位序，与模型选项保持同一交互结构。
- 选项、输入框、悬停态改为跟随主题强调色，浅色/深色/黑色主题下视觉一致性更好。
- Top Island 选项字号与行高可跟随聊天字号联动，提升可读性。

### Unity/MCP 诊断与工具协议恢复增强

- Unity console 诊断判定新增“否定语义过滤”：像“没有报错/无编译错误”这类输入不会被误路由到强制 console 诊断。
- Unity MCP 首轮回退触发条件收敛为“无工具调用且无 reply options”；若模型已给出可点击选项，不会被首轮兜底逻辑覆盖。
- 强制 `read_console` 路径新增一次软提醒：当已执行只读工具但仍缺 `read_console` 时，会先提示补齐标准 `<tool_use>`，再决定是否回退本地诊断。
- 新增非标准工具格式识别：`[Tool call: ...]` 与 `<tool_code>...</tool_code>` 会被识别为不可执行格式并触发标准 XML 工具调用纠偏。
- 文本工具解析器增强：支持解析 `<tool_code>` 包裹的单次函数调用，以及白名单工具的单位置参数写法（如 `list_directory("src")`）。

### 语言一致性与回合暂停控制

- 标准化流结果新增 `hasExplicitUserChoiceRequest` 标记：显式 `<user_options>` 或协议级选项调用会触发强制暂停，避免“有选项但被继续执行覆盖”。
- 语言失配恢复策略细化为三态：`recover_once`、`hide_text_continue`、`pass`；在“已重试且有工具调用”的场景下会隐藏错语种可见文本，减少用户端语言跳变。
- 系统提示新增“工具调用前可见说明也必须跟随目标语言”约束；若语言不确定，优先直接发工具调用而非输出错语种过程句。
- 显示语言切换时会同步将回复语言策略设为“系统语言优先（可显式切换）”，减少切换后的语言漂移。

## 修复与稳定性

- 重复调用防护提示文案改进：明确这是“重复调用安全护栏”而非写入引擎故障，并引导复用已有成功结果后再推进下一目标。
- 云端/本地协议混合场景下，伪工具调用恢复路径更稳定，降低“看似调用工具但实际未执行”的空转概率。
- 回合中止、失败、等待输入等状态下的工具卡片结算规则更清晰，减少 UI 状态残留。

## 验证覆盖

- 新增 Node 测试：
  - `tests/node/tool-lifecycle.test.mjs`（工具生命周期匹配与完成分组）
  - `tests/node/unity-mcp-fallback.test.mjs`（Unity 首轮回退与 read_console 软提醒）
- 新增/更新 Node 测试：
  - `legacy-tool-parser`（`<tool_code>` 与单位置参数解析）
  - `normalized-turn`（显式 user choice 标记）
  - `orchestrator-language-mismatch`（隐藏错语种文本分支）
  - `pseudo-tool-call-recovery`（非标准工具格式识别）
  - `reply-options`、`run-intent`、`system-prompt`（模式约束与语言约束）
- 新增/更新 E2E：
  - `tests/e2e/game-studio-plan-shortcuts.spec.ts`
  - `tests/e2e/game-studio-tool-group-collapse.spec.ts`
  - `tests/e2e/awaiting-choice.spec.ts`
  - `tests/e2e/cloud-tool-protocol.spec.ts`

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_1.6.5_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.6.5_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.6.5_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件
