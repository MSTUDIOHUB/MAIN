# MAIN 最小运行内核与能力边界

> 状态：现行开发约束
> 按生产调用点核验：2026-07-30
> 目的：在修改 Runtime 前先确定唯一所有者、真实能力和验收事实，避免重新堆叠 v1/v2 式特例。

本文严格区分三类陈述：

- **必须保持**：架构不变量，不等于代码已经完整实现；
- **已经接线**：从生产入口可追到实际调用点，并有聚焦测试或真实回放支持；
- **尚未接线**：合理目标但当前不能对用户宣称拥有。不得因为计划、类型名、UI 文案或未被生产调用的 helper 存在，就把它移入“已经接线”。

## 1. 生产事实源

当前工作区 Turn 的生产入口是：

```text
submitAsyncWorkflowRun.ts
  -> submitRuntimeRunner.ts
  -> runtimeV2/{chat,workspaceRead,plan,execute,goal,studio}Runner
  -> RuntimeV2Controller + provider/tool/checkpoint/projection ports
  -> streaming.ts / toolExecutor.ts
  -> Rust IPC 受信任执行与 Session 存储
```

- `submitRuntimeRunner.ts` 对没有 v2 admission marker 的 Turn fail closed；生产没有 v1 回退。
- 旧 `AgentOrchestrator`、旧恢复辅助函数和 Rust `RuntimeLoop` 可以用于历史对照、Replay 或 Harness，但不能据文件名推断其仍拥有生产策略。
- 文档、测试或 UI 声称某项能力前，必须能从上述入口追到实际调用点。仅存在导出函数不代表能力已经接线。

## 2. 最小内核

Execute 只需要一个可重复的核心循环：

```text
保留原始用户目标
  -> 读取当前事实
  -> 做最小且有版本依据的修改
  -> 在最终修改之后验证
  -> 未通过则带着新证据继续读取/修改/验证
  -> 由结构化事实决定 success / partial / blocked / error / canceled
```

不可破坏的语义：

1. 安全读取在观察、修改、验证阶段始终可用；阶段只表达当前重点，不通过撤工具强迫模型。
2. 修改必须基于父智能体对目标当前版本的读取。子智能体永远不能写文件。
3. 每次修改形成新的验证边界；修改前的验证不能证明修改后的行为。
4. provider 正文只负责说明，不能创造 mutation、validation、permission 或 terminal 事实。
5. 重复读取、无工具响应、协议漂移和弱输出是推进信号，不是任务终态。
6. 最终 mutation boundary 后的真实证据完整覆盖所有必要验收条件时可以 `success`；验收尚未完成时，只有用户取消、权限或外部状态阻塞、兼容 transport 全部不可用、生命周期截止和无法满足的真实验收边界可以提前收口，已有改动但覆盖不全时必须是 `partial`。

“兼容 transport 全部不可用”必须由**没有任何兼容请求可以发出**或所有候选 transport
都已得到不兼容证据来证明。某个已经发出的 provider 请求发生 HTTP、连接、reset 或
timeout 错误，只是一次请求失败；它保留原始错误并回到共享恢复循环，不能被 adapter
改写成 `provider_transports_unavailable` 后直接结束 Turn。

新增循环规则前必须先回答：删除现有哪一条规则仍不能解决问题？如果能通过删除强制工具、轮数门、重复摘要或第二事实源解决，就不得新增恢复分支。

直接 Execute 的读取授权是一个 mutation boundary 内的**多目标集合**：父线程依次读取 A、B、C 后，可以修改这三个已取得版本证据的目标；读取 B 不会撤销 A。任一成功 mutation 会清空该集合，后续修改必须重新读取最新版本。不得退化成“只有最后一次读取的文件可改”，也不得把旧读取永久当作授权。

读取是编辑授权和理解证据，不是用户目标已经产生效果。当前 mutation boundary 已物化精确版本源码、但尚无成功 mutation 时，ledger 必须保持 `source_only_frontier`：后续读取可以补充 workset，却不能不断把“仍未产生效果”的状态重置成已推进。此时 request 可以在**同一完整工具集合**中把现有 mutation 能力排在前面，并要求只有能明确指出一个缺失路径、范围或事实时才继续读取。不得撤掉读取、强制单一编辑工具、按读取轮数结束，或按 Qwen/Gemma 等模型名分支。成功 mutation 自然清除该压力并进入新的验证边界。

### 2.1 跨模型统一协议，而不是统一思考过程

Qwen 一类模型可能返回很长的 reasoning，Gemma 一类模型可能很短或不返回同形字段；
不同 provider 也可能把正文、reasoning 和 tool calls 编码成不同增量。这些都是 adapter
需要规范化的**模型输出差异**，不是 Runtime 生命周期差异。

Runtime 只统一以下可观察事实：

- 标准化后的 tool call、参数、执行结果和幂等身份；
- 当前 phase、权限、目标版本、mutation boundary 和 validation receipt；
- provider 请求能否继续、是否存在真实硬边界，以及最终结构化 outcome。

Runtime 不得把以下内容当作进度、授权或终态事实：

- reasoning 的长度、是否存在、标签名、措辞或内部推理步骤；
- provider 正文声称“已经理解”“应该完成”或“无法继续”；
- 某个语义 oracle 对第一次修法的主观优劣判断。

因此跨模型兼容必须发生在 provider adapter：按能力协商 native tools、文本信封、
streaming、reasoning 字段和输出上限，再统一投影成相同的工具协议。provider/protocol
身份可以在 adapter 内选择真实 wire format、URL 和专有请求字段；禁止用它改变 Runtime
phase、重试次数、读取权限、验收或终态。也禁止按模型名称、“重思考/轻思考”分类或特定
正文格式改变读取—修改—验证循环。reasoning budget 是请求边界的资源参数，不是 Runtime
策略；没有 reasoning 字段不是协议失败，reasoning 很长也不证明任务取得进展。

上下文只能保留 provider 为紧邻下一次响应所要求的 reasoning continuation。旧工具组的
隐藏 reasoning 不得提升为 system message、任务证据或项目记忆，也不得随源码 workset
持续累积。真正需要跨轮保留的是原始目标、标准 assistant/tool 对、当前源码证据、修改
与验证事实。

验收必须分成两条互不越权的通道：

1. **协议收敛（Runtime 必须保证）**：在权限内完成合理的 inspect → edit → verify，
   失败后仍能继续选择工具，并以结构化事实得到 truthful `success` 或 `partial`。
2. **结果质量（评测指标）**：实现是否是最佳方案、解释是否理想、语义 oracle 是否满意。
   它可以指导下一次产品改进或用户的后续 Turn，但不能生成模型专用补丁、无限修正循环，
   也不能把已经有真实证据的安全结果伪造成协议失败。

这不放宽安全或完成真值：没有覆盖验收条件时仍然只能是 `partial`；但当结构化证据已经
覆盖用户条件时，即使写法不是评测器偏好的最佳实现，也应结束当前 Turn。用户针对不理想
结果再发新指令，是正常 Agent 工作流，不是 Runtime 需要在单轮内消灭的模型差异。

## 3. 唯一所有者

| 事实 | 唯一所有者 | 允许的输入 | 禁止越权 |
| --- | --- | --- | --- |
| Turn/Run 身份与终态 | Runtime v2 controller/checkpoint | admission、结构化事件、硬边界 | UI 文案、模型正文、动作次数决定终态 |
| 模型消息与 tool-call 协议 | provider adapter | 标准 `assistant.tool_calls -> tool` 历史、provider 能力 | 用另一个有损摘要替代真实工具结果 |
| 工具是否可见与可执行 | 同一个 authority resolver | phase、permission、scope、consent | “已暴露但执行时另行拒绝” |
| 文件修改 | 父智能体 + mutation preflight | 当前版本读取、用户/WorkPlan scope | 子智能体写入、陈旧读取授权修改 |
| 验收事实 | validation receipt / evidence ledger | 最终 mutation boundary 后的匹配验证 | 任意 build、服务启动或 provider 声称完成 |
| Session 持久化 | 强类型 snapshot builder + Rust CAS | 白名单 canonical state | Store 展开、递归 snapshot、未知字段透传 |
| UI 状态 | canonical runtime projection | structured events/outcome | 从“完成/失败”等自然语言猜状态 |

## 4. 上下文、内存与文件读取

这三个概念不能混成一个固定字符常量：

- **模型上下文上限**：由 provider 报告的模型能力或明确配置形成硬上限。空闲内存不能让模型获得超过自身能力的 context window。
- **模型单次输出上限**：与输入 context window 分开处理。只有语义明确表示硬能力的 `max_output_tokens` / `max_completion_tokens` 等字段才能限制生成；通用或 OMLX 状态中的 `max_tokens` 可能只是请求默认值，不能冒充不可突破的能力上限。adapter 必须按真实协议区分二者。
- **设备内存容量**：是本地请求的资源压力信号。它可以在可靠模型上限内调整本轮可用预算、并发和压缩时机，但不能凭一个假定模型尺寸制造上限。
- **本轮输入预算**：模型上限减去输出、工具 schema、系统说明和安全余量。压缩只应在估算输入逼近这个预算时发生。
- **文件读取窗口**：从本轮剩余输入预算派生，并受文件工具的绝对安全上限约束；不得再为 Execute、Plan 和 child 分别硬编码不同的小窗口。

大文件读取的完整性契约是：

1. 返回内容与 `returnedLines`、`returnedChars`、`nextStartLine` 必须描述模型实际收到的同一批字节，任何后续层不得静默二次截断。
2. 当当前判断需要全文件语义时，模型按 `nextStartLine` 连续读取，runtime 记录同一版本的 coverage；当只需报错行、符号或局部调用链时，应读取精确窗口或使用 AST/引用工具，不能机械读取整文件。
3. 超过单次上下文容量的文件不可能“全文同时在场”。旧窗口只能在明确的预算压力下压缩，并保留路径、版本、范围和需要复读的信息；修改前仍须取得目标的最新精确字节。
4. 分页续读以新的 `start_line` 为推进事实。如果 provider 沿用了上一窗已经过期、且小于新起点的 `end_line`，runtime 将它视为未提供结束行并返回从新起点开始的正常有界窗口，而不是静默折叠成单行。
5. 同一次 provider 响应并行选择多个 `read_file` 时，这批读取共同分享本 Run 的单次读取窗口；不得让 N 个并行调用各自占用完整窗口，把输入预算放大 N 倍。分配后的每个结果仍须返回精确字节、版本、范围和 `nextStartLine`，模型随后只续读与当前判断相关的缺失范围。
6. `read_file` 使用独立的无损源码结果通道，明确绕过通用命令结果 decoder 和 `.trim()`：普通行窗口保留 CRLF 与文件末尾换行；空文件是带版本的 `0-0` envelope，不能被替换成提示文案。
7. 超长单行以 zero-based、end-exclusive 的 `returnedCharRange` 和 `nextStartChar` 续读；相邻 `start_char + max_chars` 窗口必须能逐字重组。任一未完成字符窗口报告 `returnedLines=0-0`，在完整覆盖前不得形成 materialized mutation coverage 或写入授权。
8. `run_command` 不是文件分页器。

### 2026-07-29 能力审计

已经接线：

- `read_file` 对大文件返回显式窗口元数据；`max_chars` 会约束实际返回字节。
- Runtime v2 主线程只有一份 canonical transcript：标准 assistant/tool 对与 workspace、WorkPlan、child handoff system anchor 共存；不得恢复 `modelContext`、evidence digest 或另一份按条数/字符截断的内容副本。
- `submitRuntimeRunner` 在 admission 后只解析一次 `RuntimeContextBudget`；Execute、Plan、Goal slice、Chat 和 child 共享同一个不可变对象。
- 本地 Run 只有在 provider 同时报告所选模型的 context 上限且确认模型已加载时，才可在显式配置之上扩展；当前可用内存可以在该硬上限内降低容量。探测失败回退配置，不阻断 Turn。
- 云 Run 保持 provider-managed context，不套用本机 KV 内存估算。
- 输入未达到本轮 token 预算时不压缩消息；达到压力后按完整 assistant/tool 组回收旧上下文，并保留当前目标、最新证据包和尾部 phase authority。
- provider 的活动源码 workset 与 canonical transcript 分离：同一文件为获得完整语义而连续分页的窗口全部保留；跨文件为每个不同的语义桥保留最新前驱，使 caller→controller→view 链不会被裁成一条边，同时避免一个高频标识符把整个项目档案拖入每次请求。无关精确回执留在 ledger 中供缓存重放；最终仍由同一个 Run input-token budget 裁定，不使用固定文件数、轮次或模型名分支。
- Runtime 计算 materialized source、coverage 和 mutation lease 的 decision view 是一次请求的精确 wire payload。该请求必须标记为 caller-owned，provider adapter 不得在 gateway retry 时静默再截断或 aggressive compact；若精确 payload 无法发出，应把原始 provider 错误留作可恢复请求证据，不能根据未到达 wire 的源码授予写入。只有 adapter-owned 的旧 Chat 请求可以继续使用 adapter 自有压缩。
- Execute、Plan 和 child 的 `read_file.max_chars` 从同一个 Run 预算派生；`__raw` 只用于运行时版本哈希，不进入模型上下文。
- Execute、Plan 和 child 对同一 provider 响应中的并行 `read_file` 使用同一批次计数，共享上述 Run 窗口。它只控制本请求返回量，不改变模型硬上限，也不妨碍用 `nextStartLine` 对同一版本继续分页。
- child handoff 也从同一 Run 输入预算派生：按目标路径从 canonical transcript 与 ledger 选取当前 mutation boundary 的相关父上下文；源码窗口整条纳入或明确列为 omitted，不能截成伪完整代码，也不再固定截取“最后六条、每条 2400 字符”。
- `modelLaneCoordinator` 会读取系统内存来控制本地父/子模型请求的并发准入。
- 模型请求并发不通过提示词询问模型，也不按 Ollama、LM Studio、OMLX 等产品名猜测数值。若活动配置提供 `maxActiveRequests`，它只能在产品总请求安全上限四以内选择更小上限，并仍受内存保护；未知平台从“主体 + 一个真实工作子流”开始，只有多个请求都已收到真实 transport 首包才逐级开放下一个槽位。主体始终保留一个槽位。
- 只有明确的容量事实会收缩当前 lane：OOM、HTTP 429/明确并发限制或本机内存压力。连接重置、gateway/stream timeout、长 reasoning 和“暂无可见正文”只是该请求的 transport/协议事实，不得把 provider 并发能力错误降为一。真正收缩时优先释放最新子流而不是中断主体；串行服务仍可完成子任务，只是不被 UI 宣称为并行。

明确限制：

- 旧的 `modelDiscovery.computeDynamicLocalContextLimit()` 依赖猜测模型体积且没有生产调用方，已删除；不得恢复这种“猜模型、再扩大上限”的旁路。
- Settings 的滑块/内存展示是用户配置与说明，不是运行中的第二预算所有者。
- provider 未报告能力或未确认所选模型已加载时，runtime 绝不猜测更大的上限；因此这类 provider 只使用用户配置。
- OpenAI-compatible API 没有标准字段能查询服务端实际并发；服务自身未报告时，“最多并行多少”只能来自显式配置或真实请求重叠观察，不能从模型回答中伪造。
- 设备内存估算是容量保护而非精确 KV 分配器；provider 仍可在请求时返回真实容量错误，后续应把它作为新的资源事实处理，不能静默截断正文。
- 单次模型可见读取仍有绝对窗口上限。需要全文件语义时必须沿同一版本连续取窗，而不是提高常量或把文件偷偷裁成摘要。
- reasoning 的专有请求字段只属于 adapter。OMLX 的 `auto` 不发送正向 reasoning 覆盖，保持所选模型声明的默认行为；只有 `explicit` 才依据该次请求的真实输出上限派生 hidden-thinking budget，`off` 用于关闭 thinking 的有界恢复。Execute、Plan 和 child 共用这一 adapter 规则，未知 endpoint 不接收这些字段；Runtime 只消费规范化后的 reasoning-toggle 能力来处理 reasoning-only 的长度截断。

## 5. 项目基线不是会话记忆

跨会话项目理解应拆成两个不同事实层，不能把一次模型总结当成永久大前提：

1. **项目基线**是可重建的结构事实：工作区身份、manifest/lockfile、用户维护的项目规则、脚本、语言与依赖事实、关键目录，以及每项事实的来源和内容哈希。
2. **任务证据**是当前 Turn 的版本化读取、mutation 和 validation receipt。它随源码变化失效，永远不能被项目基线替代。

项目基线的正确生命周期：

- 第一次需要工作区上下文时做快速、确定性的 anchor 扫描，不用模型阅读全文，也不阻塞等待全仓库索引。
- 以 schema version、canonical workspace identity 和 anchor fingerprint 持久化；manifest、lockfile、项目规则或相关配置变化时重建。不能只靠时间戳宣称新鲜。
- 每个新 Session、Turn 和 child 都接收同一份有界基线；根据任务再从 repo map/AST/文件工具检索具体事实，而不是把整个索引塞进 prompt。
- 用户维护的 `.MAIN/steering` 或等价项目规则保持独立权威；自动基线只能引用，不能重写它。
- 失败历史、模型推断、临时路径和“上次这样修成功了”不能成为无条件全局记忆。只有带 workspace、目标、版本和验证 provenance 的事实才能跨 Turn 复用，并在来源变化时失效。

当前能力审计：

- Rust `SessionMemoryStore` 只有在调用 `load_session_memory` 或 `record_session_failure` IPC 时才会创建或更新 `.MAIN/memory/session_memory.json`。生产端目前只在检测到应用未正常结束的旧 Run 时直接调用 `record_session_failure`；`load_session_memory` 没有生产调用方，文件内容不会进入 Execute、Plan、child 或 Chat 的 provider 上下文。因此删除旧文件不会改变当前执行能力，也不能把“无旧文件回放”解释成记忆已经重建。
- 该旧 profile 仅凭文件存在推断构建命令，并会累积自由文本失败/反思，不满足来源、版本和失效契约。不得直接注入 provider 上下文。
- 工作区 `AGENTS.md`、`CLAUDE.md`、`AGENT.md`、`.MAIN/rules`、显式 active instruction skill，以及 `.MAIN/steering` 中 `inclusion: always` / 已知路径匹配的 `fileMatch` 规则，已收敛到同一个 `ResolvedInstructionSet`。每个 Turn 在 Run admission 前刷新一次，随后把带 source provenance 的完整文本冻结到 Runtime v2 admission context；父线程和之后启动的 child 使用同一快照。
- 上述规则同步与会话压缩互相独立；旧 `session_memory.json`、provider 总结和 conversation summary 都不能填充这个字段。规则刷新失败时保留上一份已解析规则并继续安全读取，不能把一次可选 bootstrap I/O 失败升级为终态。
- repo map 目前仅在模型调用 `repo_map_*` 工具时构建，且调用会重新扫描；它是按需代码检索，不是 Session bootstrap 项目基线。
- 因此“每轮默认获得带 manifest/lockfile fingerprint 的完整结构基线”仍是**尚未接线**能力；目前已经接线的是用户维护的项目规则和浅层 workspace observation。实现剩余结构基线时应替换或收敛上述重复存储，不能再增加第三份项目真值。

### OpenCode 公开实现的可采用边界

OpenCode 的公开实现提供了一个有价值的对照，但不是可直接复制的补丁：

- [`/init` 与 Rules](https://opencode.ai/docs/rules/) 扫描重要项目文件并创建或更新可审阅、建议提交到 Git 的 `AGENTS.md`；它不是后台自由文本记忆。
- [`instruction.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/instruction.ts) 从明确来源解析项目/全局规则，并在读取子目录文件时按路径补充附近规则。MAIN 可以采用“来源有序、按路径懒加载、每个 Turn 去重”的边界，不能让模型总结成为规则权威。
- [V2 Compaction](https://opencode.ai/v2/docs/compaction) 明确区分 durable session、lossy checkpoint 和 instruction synchronization：压缩不删除历史，也不把历史摘要提升为新指令。MAIN 的 checkpoint、项目规则和任务证据同样必须分层。
- [`task.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts) 把 child 建模为有 `parentID`、独立 history 和明确 permission 的子 Session，结果再交回 parent。可见 child history、深度上限和传递式权限值得采用；OpenCode 自身曾出现权限继承、递归和并发问题，因此 MAIN 仍坚持父线程唯一写入、运行时 lane 探测和结构化 evidence handoff。

采用 OpenCode 参照后，MAIN 的最小方向不是“再加 Memory Store”，而是：

1. 项目规则是用户可读、可版本控制的 instruction source；
2. 可重建结构事实来自带 hash 的 deterministic baseline；
3. 会话摘要只帮助续接，不授权修改或验收；
4. child 继承同一 instruction snapshot，并从当前任务证据开始工作。

## 6. 子智能体边界

- `preferred` 是可选协作偏好，不是开场必须 spawn。
- 子智能体只适合独立的 `explore`、`review`、`validate`；父线程始终是唯一写入者。
- 子智能体应接收目标、相关父证据、当前版本/修改边界和缺失验收项组成的锚点上下文。继承证据必须带 provenance，不能因协议不允许引用而被迫重读。
- 当前最小内核不向 child 暴露额外“报告工具”：child 每次请求同时保留其安全工具和普通最终文本能力，不使用 required-tool、不预留固定“强制总结阶段”，也不在取得首条证据后撤掉工具。精确重复动作只得到标准工具拒绝结果并继续同一 child 生命周期。child 用普通最终文本收口，runtime 只在报告引用子任务真实新证据或明确交付给 `review` 的版本化父证据时记为 `completed`。继承父证据必须单独保存 provenance；它可以支持 review finding，但绝不计入子任务新证据、交付、采用或验收数量。
- child 取得**新证据**但未形成合法报告时记为 `degraded`，UI 显示“已降级由主体接管”；只有继承上下文但没有合法报告，或根本没有新证据时记为 `failed`。父任务取消时为 `canceled`。这些状态都不能制造验收事实。
- 子智能体 `degraded/failed` 后父线程继续当前目标。协作状态不得成为父线程停止原因；只有 `completed` 且报告引用真实 evidence 时才是成功的协作结果。
- 子智能体面板显示当前真实 lane 状态：能力未知时为“探测中”，确认首 token 重叠后同时显示“已实测数量”和“当前开放数量”，显式配置则标为“已配置”。不得写死“最多两个子流”，也不得把主体槽位混入子流计数。

## 7. 验收与 UI

- 静态 build/lint/typecheck 只证明对应静态条件。用户可见交互必须由有限测试、browser 或 desktop 断言证明。
- 服务 ready 只是验证前置条件，不是验收。
- **必须保持**：修改后的语法/静态检查发生在用户行为验收之前；任何自动回滚都必须比较版本并且只能回滚本批智能体改动，不能覆盖用户并发或原有脏改动。
- Turn 计时由 exact session/run 的 epoch 时间边界计算。UI 不维护第二套全局 elapsed 真值。
- Composer 的子智能体和自动审批选择是 Session 偏好；发送时新建 Session 必须继承本次快照，发送后不能无故复位。
- provider、tool 和 child 的原始诊断码只进入有界调试日志；用户界面展示本地化的结构化状态与可行动原因，不直接泄露后端错误串或 JSON。
- UI 改动必须验证 light、dark、black、selected、disabled、hover、focus 和 terminal 状态；运行时修复不得顺手改视觉结构。

### 当前验收能力与明确缺口

已经接线：

- 同一个 Runtime authority resolver 生成 Execute 工具面并执行授权；本 Turn consent 可允许 `browser_evaluate`，桌面控制仍保留逐次授权。
- browser validation 只有在存在因果关联的 passed assertion，且没有 page/console error 时才算通过；静态 build 不能单独覆盖行为 criterion。
- Goal/WorkPlan 明确声明的 `behavioral`、`interaction`、`static` 证据类型必须严格保持。普通 Execute 没有该类型事实时，Runtime 不从自然语言猜分类，也不把所有目标硬编码为 behavioral；模型选择的真实有限 validator 可以覆盖未分类条件，最终报告必须如实说明实际验证内容。
- Plan discovery 始终同时保留安全读取和 WorkPlan 提交工具，不按读取次数、动作次数或独立 discovery 时钟撤掉读取面。只有共享生命周期截止可以结束；provider 无动作和协议漂移只作为软反馈或兼容 transport 协商。
- 普通副作用按规范化后的 tool+arguments 在同一 mutation boundary 精确拒绝，工具本身和其他参数仍然可用。`read_file` 是 coverage-aware 例外：首次缓存重放后，同一路径、同版本的其他范围只有在该请求范围仍物化于**当前实际发给模型的 decision view** 时才属于“无新信息”；canonical transcript 曾经覆盖过不等于模型现在仍看得到。若有界 workset 已淘汰该源码，允许再次从缓存重放而不访问磁盘。首次 replay 可以返回精确缓存源码；源码仍可见时再次重分片只能返回有界结构化指引，不能附加源码奖励无效读取。durable replay receipt、标准工具对、路径/版本和 mutation receipt 负责恢复关闭事实，但执行拒绝前必须再与当前 decision view 求交，不能只相信 process-local Map 或历史 ledger；成功 mutation 会重新开放新的边界。
- 精确重复的安全读取不重新访问工作区：若同一 mutation boundary 已有成功回执，runtime 直接重放原 assistant/tool 结果；provider 同时提出新读取时只执行新部分。失败回执不缓存，成功 mutation 会使全部旧读取回执失效。
- provider 没有产生合法工具调用或动作被精确拒绝时，下一次请求会保留完整可见的 assistant 响应和结构化 runtime 反馈；只有完全相同的响应/反馈对会合并。重试不能遗忘刚刚失败的尝试，也不能靠固定轮数收口。
- 已拒绝的标准 assistant/tool 动作对继续存在于 canonical ledger，但从下一次 provider 的决策副本中整体移除，并由有界的结构化拒绝事实替代；真实源码读取回执仍按路径、版本和范围保留。不得删除持久化真值，也不得让失败动作反复占用模型决策上下文。
- provider 工具参数在生成 action identity 之前按工具 JSON schema 做递归标量规范化；例如数值字段的 `"260"` 与 `260` 必须是同一个动作。不得针对模型名、字段名或事故参数编写修正规则。
- 原生工具仍由 provider 配置/能力决定。某一次请求使用文本信封 fallback 只挽救该请求，不能写成 Turn 级“已证明能力”并永久撤掉后续原生工具。
- 本地工具协议的默认值已经统一为 `auto`；LM Studio、Ollama、OMLX 不再因产品名默认进入 XML。真实 wire format 和兼容 fallback 由 adapter 能力与本次请求结果决定。
- 用户保存的 native/XML 是偏好，不是能力证明。Gemini adapter 当前尚未完成工具声明、`functionCall` 解析、调用历史回放和 `functionResponse` 结果回放，因此 Execute、child 和 Plan 即使偏好 native 也直接使用现有文本信封；四向测试全部通过前不得打开 native capability。
- workspace mutation 在落盘前复用共享 preflight：检查路径、当前源码、有限 diff 和拟写入源码。Rust 语言检查除 parser error 外还覆盖 JavaScript/TypeScript 模块重复导出这一类早期错误；真实 OMLX 回放适配器维持同一安全语义。
- mutation preflight 检查的是整份拟写入 post-image，不是补丁片段本身。只要语言检查适用于该文件，post-image 就不得残留任何解析或模块早期错误；“错误数减少但仍损坏”不能落盘。检查器返回有界的错误位置与类型列表，让模型能在同一个 mutation transaction 中完成整份结构修复，而不是靠猜测逐步写坏文件。
- 有限命令验收必须保留真实退出状态。文件描述符重定向（如 `2>&1`）不是后台进程，但包含 `| head` / `| tee` 等未保证 `pipefail` 的管道仍因退出状态含糊而拒绝；工作区根目录是默认 `cwd`，也接受 fail-fast 的安全目录前缀。分类器只承认具有可判定退出语义的测试、构建、lint、typecheck、check 与内联断言工具族；直接 CLI 调用与 package script 使用同一验收语义，不能把任意 shell 命令放宽为验证。
- checkpoint v5 只持久化一份 canonical event ledger；动作/idempotency identity 使用固定长度摘要，避免把大参数反复写入 projection。Session、UI、调试器和 E2E 读取原始 checkpoint 时必须先调用统一 normalizer 重放 ledger，再访问 materialized aggregate；不得直接依赖可选 `.aggregate`，也不得为方便观察重新持久化第二份 aggregate/events。
- Execute 的 durable ledger 会派生 `source_only_frontier`。它只改变下一次请求的推进指引和稳定工具排序，不改变授权工具集合或 action identity；新增不同源码证据不能清除此压力，mutation receipt 才能清除。

尚未接线，不能写进完成声明：

- 没有通用 `MutationTransactionV1`、修改前镜像或 CAS 自动回滚器。当前只有修改前 scope/version preflight、修改 receipt 和后续验证；不能声称语法破坏会被自动恢复。
- mutation preflight 不是完整 typecheck 或跨文件引用分析。它能拒绝当前支持语言的解析错误和已实现的模块早期错误，但不能单凭这一关证明变量已定义、导入有效或项目可构建；这些仍需最终静态验证。
- 没有 Runtime 所有的长驻 dev-service 启动/readiness/清理生命周期。有限 validation 会拒绝 `npm run dev` 这类长驻命令；服务启动本身也不是验收。
- 没有通用视觉证据 artifact 回流协议。browser 结构化断言可证明页面行为，但不能声称每次截图都会自动作为图片进入下一次模型修正请求。

## 8. Runtime 修改门

每次增加运行逻辑前按顺序完成：

1. 用调用点证明生产所有者；同时查看 v1 历史行为和当前 v2，写出两者失败的共同原因。
2. 写明原始用户目标、不可破坏的边界、准备删除的旧策略，以及为何现有共享能力不足。
3. 优先做减法：删除第二事实源、强制工具、固定轮次、重复上下文和 task-specific 分支。
4. 在拥有该边界的测试中先复现失败，只实现一个最小变化并立即运行聚焦测试。
5. 只有聚焦测试通过后才进入下一阶段；不要累计多层改动后一次性测试。
6. Runtime 单测通过不等于任务完成。对真实事故使用隔离 fixture、真实模型和匹配的行为 oracle。
7. 最终检查 Node、Rust、lint、build、相关 Playwright、UI 主题及原工作区哈希，再提交。

多轮真实 OMLX 回放必须隔离缓存变量：

1. 明确区分三层状态：`response-state` 是 Responses API `previous_response_id` 的 JSON 延续状态；十六进制分片中的 `.safetensors` 才是 SSD prefix/KV cache；hot/paged prefix 状态由已加载 scheduler 持有。每轮前分别记录适用路径、文件数/字节数、prefix hit rate、indexed blocks 和当前 loaded model。
2. 任何 cache clear、文件删除或 unload 前必须确认 `active_requests=0`、`waiting_requests=0`。需要完全冷启动对照时，先通过支持的模型管理接口卸载并确认目标模型既未 loaded 也未 loading，再用已认证的 OMLX admin control 依次清 hot 与 SSD prefix tier。
3. 管理接口不可用且用户明确授权删除缓存时，本地兜底也只能在 idle + unloaded 后删除**已解析并逐个核对的十六进制 shard 目录直属 `.safetensors` 文件**。禁止删除 `.omlx`/cache 根目录、模型权重、response-state、vision features、活动 boundary snapshots 或任何未解析变量/通配目标。
4. 清理后验证 SSD shard 文件数为 0，再只加载目标模型并确认状态稳定。若本来就是 0，记录“SSD prefix cache already empty”，不要假称执行了有效清理。仅清 `response-state` 不能隔离 prefix 命中；仅删 SSD 文件也不能证明已加载 scheduler 的内存状态已清空。

真实回放适配层必须保留生产工具的安全语义。特别是 `read_file_window` 的
`contentVersion` 不得在 IPC/mock/fixture 转换时丢失；否则回放制造的是一个
生产中不存在的“永远没有版本化读取授权”的假故障。遇到这种失败应修复适配层，
不得放松生产 mutation preflight。语法检查 mock 同样必须覆盖生产已承诺的
模块早期错误；不能用只做 parse 的弱替身让回放写入生产会拒绝的代码。checkpoint
观察器同样必须 normalize/replay canonical ledger，不能因为持久化形态没有
materialized aggregate 就误判 Runtime 未启动或没有终态。

禁止以如下方式“让测试变绿”：

- 针对中文请求、MD Viewer、某个模型名或某条错误字符串添加业务分支；
- 用动作/轮次数耗尽直接生成终态；
- 强制模型下一步只能调用一个工具；
- 把任意 mutation + 任意 passed command 当 success；
- 提高存储上限、context 上限或超时来掩盖递归、重复或协议问题；
- 修改期望值去固化一次事故中的错误策略。
