# 聊天与工作区完成判定修复

源码基线：`b9c880f`。本次修复覆盖生产 TypeScript Runtime v2 及 Rust Web 工具，不重写历史会话。

## 事故与责任边界

9 月 5 日的基金查询（Turn `turn-1788597276193-7t1vvk`）在最后一次输入 49,944 tokens 后正常收到 OMLX 响应。MAIN 将重复的工具过程说明接受为最终回答，随后按正常顺序发布 success。这不是整轮超时、模型崩溃或投影丢失。

生产路径：`submitRuntimeRunner → readOnlyRunner/executeRunner → Controller → executionProviderRequest → streaming/toolExecutor → Rust IPC`。完成候选和执行验收归 Runtime core，协议归 provider adapter，HTTP 与搜索结果解析归 Rust 工具。没有新增第二套执行器或 UI 完成规则。

设计参照 [Codex App Server 的消息与任务事件契约](https://learn.chatgpt.com/docs/app-server)：过程消息、最终消息和工具结果应保持区分。对于没有可靠消息 phase 字段的本地协议，MAIN 从动作规范化、当前请求和实际证据边界判断候选资格，不通过中文关键词、最低字数或模型名称猜测完成。

## 修复内容

- **共享响应接纳。** Chat/analyze 与工作区 Execute、已批准 Plan 的执行共用当前回答候选检查。拒绝未完成动作、协议诊断、原样重复的工具过程说明，以及跨过更新的响应、工具、验证或子任务回执复用旧报告。
- **协议不再被展示清洗吞掉。** 显式 JSON 工具标签进入统一规范化；残缺原生调用、未消费的工具标记及不完整批次保留可恢复诊断。普通 JSON 回答仍可正常完成。空工具总结中发出的动作仍被拒绝，不扩大权限。
- **工作区按契约验收。** 执行契约的纯解析与回放移入 core，Store 保留工具声明和授权。成功必须覆盖契约全部修改目标、最终修改后的每项声明检查，以及原有 authority、版本、验收类型要求。同一检查的较新失败使旧通过失效，另一个检查通过不能将其抵消；后续修改使之前检查失效。下一步指导选择尚未覆盖的验证。
- **恢复与生命周期。** 单次总结失败继续进入带诊断的恢复；重复过程说明也计入恢复压力。保留连续停滞租约、请求不活动和单工具 watchdog，不恢复 4/8/10 分钟整轮硬截止。没有可发布回答的只读任务不能借工具证据标记 partial；工作区未完成验收也不能标记 success。
- **Web 来源与进展。** Bing 使用结果标题链接，解包真实目标 URL，历史跟踪地址也按同一目标比较。Jina HTTP 成功只证明代理响应；源站状态无法确认时，保留正文、原始失败和状态为未核实上下文，不生成成功来源证据。持续改写搜索不能代替读取来源并无限续租。
- **上下文与观测。** 相同 Web 回执在出站请求中引用同一请求内的原文，保留全部调用配对；裁剪后重建引用，避免悬空。补齐无工具请求日志及规范化后的动作/诊断形状日志，不保存私有推理正文。

## 验证

新增回归均先确认失败，再修复对应边界。最终结果：

| 验证 | 结果 |
| --- | --- |
| `npm run test:workflow-assets` | 2,384 项通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 176 项通过 |
| `npm run lint`、`npm run build` | 通过 |
| `cargo build --manifest-path src-tauri/Cargo.toml` | 通过 |
| 修改的 Rust 文件格式检查、`git diff --check` | 通过 |
| OMLX 联网聊天、关闭 Web 的两轮记忆 | 有效答案、唯一终态、idle |
| OMLX 工作区修改与失败恢复 | 修改 → 失败验证 → 再修改 → 通过验证 → success/idle |

实际模型始终为唯一已加载的 `Qwen3.6-35B-A3B-6bit`，使用原生自动工具协议；没有切换模型或清理缓存。SSD 缓存盘点为 16 个十六进制分片、33 个 safetensors 文件、2,768,570,400 字节，response-state JSON 为 0；后续推理可正常增加缓存。本次不是冷缓存性能比较。浏览器测试使用真实 OMLX、生产 Runtime 和真实临时工作区；桌面 IPC 由测试桥接，Web 请求走生产 Rust。

首轮开发服务器回放被热重载打断，随后使用构建后的静态预览完成两类真实验证。最后一次验收边界修正后，又单独重跑工作区验证并保存完整回执。其最终关键序列是 mutation 38 → failed validation 59 → mutation 89 → passed validation 105 → run.completed 118 → final projection 119 → turn.completed 120。

原事故 checkpoint 离线回放现在拒绝旧错误回答。140 条历史事件保持不变，36 条出站消息配对完整；9 个回执引用使序列化请求历史从 96,057 字符减至 77,460 字符，减少 18,597 字符。这是同一历史的字符测量，不冒充新的真实 tokenizer 统计。

[事故回放结果](/tmp/main-completion-fix-20260905/incident-verification.json)、[真实工作区终态证据](/tmp/main-completion-fix-20260905/direct-execute-completion.json)、[联网聊天](/tmp/main-completion-fix-20260905/chat-web-1.json)、[多轮记忆](/tmp/main-completion-fix-20260905/chat-offline-2.json)、[验证日志目录](/tmp/main-completion-fix-20260905)。

## 验证边界

全仓 `cargo fmt --check` 仍报告三个未修改文件的既有格式差异：`src-tauri/examples/read_only_web_bridge.rs`、`src-tauri/src/network_guard.rs`、`src-tauri/tests/code_ast_python_syntax.rs`。本次修改的 `web_search.rs` 格式检查通过。

完成门控证明的是协议、已提交效果和明确验收条件的覆盖；它不是任意自然语言答案或测试质量的语义证明器。外部搜索仍可能包含无关结果，HTTP 200 也不能单独证明页面内容正确。模型应核对来源与信息缺口，业务验收仍需选择能覆盖用户场景的检查。

改动包含 Rust 后端；现有 MAIN 开发进程需要重新启动并加载新构建，才能使用完整修复。
