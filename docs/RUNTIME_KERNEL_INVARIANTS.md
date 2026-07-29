# MAIN 最小运行内核与能力边界

> 状态：现行开发约束
> 按生产调用点核验：2026-07-29
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
6. 只有用户取消、权限或外部状态阻塞、兼容 transport 全部不可用、生命周期截止和无法满足的真实验收边界可以收口；已有改动但覆盖不全时必须是 `partial`。

新增循环规则前必须先回答：删除现有哪一条规则仍不能解决问题？如果能通过删除强制工具、轮数门、重复摘要或第二事实源解决，就不得新增恢复分支。

直接 Execute 的读取授权是一个 mutation boundary 内的**多目标集合**：父线程依次读取 A、B、C 后，可以修改这三个已取得版本证据的目标；读取 B 不会撤销 A。任一成功 mutation 会清空该集合，后续修改必须重新读取最新版本。不得退化成“只有最后一次读取的文件可改”，也不得把旧读取永久当作授权。

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
- **设备内存容量**：是本地请求的资源压力信号。它可以在可靠模型上限内调整本轮可用预算、并发和压缩时机，但不能凭一个假定模型尺寸制造上限。
- **本轮输入预算**：模型上限减去输出、工具 schema、系统说明和安全余量。压缩只应在估算输入逼近这个预算时发生。
- **文件读取窗口**：从本轮剩余输入预算派生，并受文件工具的绝对安全上限约束；不得再为 Execute、Plan 和 child 分别硬编码不同的小窗口。

大文件读取的完整性契约是：

1. 返回内容与 `returnedLines`、`returnedChars`、`nextStartLine` 必须描述模型实际收到的同一批字节，任何后续层不得静默二次截断。
2. 当当前判断需要全文件语义时，模型按 `nextStartLine` 连续读取，runtime 记录同一版本的 coverage；当只需报错行、符号或局部调用链时，应读取精确窗口或使用 AST/引用工具，不能机械读取整文件。
3. 超过单次上下文容量的文件不可能“全文同时在场”。旧窗口只能在明确的预算压力下压缩，并保留路径、版本、范围和需要复读的信息；修改前仍须取得目标的最新精确字节。
4. `run_command` 不是文件分页器。

### 2026-07-29 能力审计

已经接线：

- `read_file` 对大文件返回显式窗口元数据；`max_chars` 会约束实际返回字节。
- Runtime v2 主线程保留标准 assistant/tool 对，工具结果不再只存在于有损 evidence digest。
- `submitRuntimeRunner` 在 admission 后只解析一次 `RuntimeContextBudget`；Execute、Plan、Goal slice、Chat 和 child 共享同一个不可变对象。
- 本地 Run 只有在 provider 同时报告所选模型的 context 上限且确认模型已加载时，才可在显式配置之上扩展；当前可用内存可以在该硬上限内降低容量。探测失败回退配置，不阻断 Turn。
- 云 Run 保持 provider-managed context，不套用本机 KV 内存估算。
- 输入未达到本轮 token 预算时不压缩消息；达到压力后按完整 assistant/tool 组回收旧上下文，并保留当前目标、最新证据包和尾部 phase authority。
- Execute、Plan 和 child 的 `read_file.max_chars` 从同一个 Run 预算派生；`__raw` 只用于运行时版本哈希，不进入模型上下文。
- child handoff 也从同一 Run 输入预算派生：按目标路径选取相关父上下文，容量允许时保留完整读取窗口，不再固定截取“最后六条、每条 2400 字符”。它仍受模型硬上限和有界安全上限约束。
- `modelLaneCoordinator` 会读取系统内存来控制本地父/子模型请求的并发准入。

明确限制：

- 旧的 `modelDiscovery.computeDynamicLocalContextLimit()` 依赖猜测模型体积且没有生产调用方，已删除；不得恢复这种“猜模型、再扩大上限”的旁路。
- Settings 的滑块/内存展示是用户配置与说明，不是运行中的第二预算所有者。
- provider 未报告能力或未确认所选模型已加载时，runtime 绝不猜测更大的上限；因此这类 provider 只使用用户配置。
- 设备内存估算是容量保护而非精确 KV 分配器；provider 仍可在请求时返回真实容量错误，后续应把它作为新的资源事实处理，不能静默截断正文。
- 单次模型可见读取仍有绝对窗口上限。需要全文件语义时必须沿同一版本连续取窗，而不是提高常量或把文件偷偷裁成摘要。

## 5. 子智能体边界

- `preferred` 是可选协作偏好，不是开场必须 spawn。
- 子智能体只适合独立的 `explore`、`review`、`validate`；父线程始终是唯一写入者。
- 子智能体应接收目标、相关父证据、当前版本/修改边界和缺失验收项组成的锚点上下文。继承证据必须带 provenance，不能因协议不允许引用而被迫重读。
- 当前最小内核不向 child 暴露额外“报告工具”：child 用普通最终文本收口，runtime 只在至少有一条真实或合法继承 evidence 时编译结构化报告并记为 `completed`；有 evidence 但报告不合法时为 `degraded`，无 evidence 时为 `failed`，父任务取消时为 `canceled`。
- child 已取得 evidence 但未形成合法报告时记为 `degraded`，UI 显示“已降级由主体接管”；evidence 为空才记为 `failed`。两者都不能制造验收事实。
- 子智能体 `degraded/failed` 后父线程继续当前目标。协作状态不得成为父线程停止原因；只有 `completed` 且报告引用真实 evidence 时才是成功的协作结果。

## 6. 验收与 UI

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
- 精确重复的 tool+arguments 在同一 mutation boundary 可被拒绝，但工具本身和不同参数仍然可用；成功 mutation 会重新开放新的边界。
- provider 没有产生合法工具调用或动作被精确拒绝时，下一次请求会保留完整可见的 assistant 响应和结构化 runtime 反馈；只有完全相同的响应/反馈对会合并。重试不能遗忘刚刚失败的尝试，也不能靠固定轮数收口。
- 原生工具仍由 provider 配置/能力决定。某一次请求使用文本信封 fallback 只挽救该请求，不能写成 Turn 级“已证明能力”并永久撤掉后续原生工具。
- workspace mutation 在落盘前复用共享 preflight：检查路径、当前源码、有限 diff 和拟写入源码。Rust 语言检查除 parser error 外还覆盖 JavaScript/TypeScript 模块重复导出这一类早期错误；真实 OMLX 回放适配器维持同一安全语义。
- mutation preflight 检查的是整份拟写入 post-image，不是补丁片段本身。若原文件同时存在多个解析或模块早期错误，只修其中一个仍必须拒绝；不得为了让局部修复落盘而忽略剩余结构错误。
- checkpoint v5 只持久化一份 canonical event ledger；动作/idempotency identity 使用固定长度摘要，避免把大参数反复写入 projection。Session、UI、调试器和 E2E 读取原始 checkpoint 时必须先调用统一 normalizer 重放 ledger，再访问 materialized aggregate；不得直接依赖可选 `.aggregate`，也不得为方便观察重新持久化第二份 aggregate/events。

尚未接线，不能写进完成声明：

- 没有通用 `MutationTransactionV1`、修改前镜像或 CAS 自动回滚器。当前只有修改前 scope/version preflight、修改 receipt 和后续验证；不能声称语法破坏会被自动恢复。
- mutation preflight 不是完整 typecheck 或跨文件引用分析。它能拒绝当前支持语言的解析错误和已实现的模块早期错误，但不能单凭这一关证明变量已定义、导入有效或项目可构建；这些仍需最终静态验证。
- 没有 Runtime 所有的长驻 dev-service 启动/readiness/清理生命周期。有限 validation 会拒绝 `npm run dev` 这类长驻命令；服务启动本身也不是验收。
- 没有通用视觉证据 artifact 回流协议。browser 结构化断言可证明页面行为，但不能声称每次截图都会自动作为图片进入下一次模型修正请求。

## 7. Runtime 修改门

每次增加运行逻辑前按顺序完成：

1. 用调用点证明生产所有者；同时查看 v1 历史行为和当前 v2，写出两者失败的共同原因。
2. 写明原始用户目标、不可破坏的边界、准备删除的旧策略，以及为何现有共享能力不足。
3. 优先做减法：删除第二事实源、强制工具、固定轮次、重复上下文和 task-specific 分支。
4. 在拥有该边界的测试中先复现失败，只实现一个最小变化并立即运行聚焦测试。
5. 只有聚焦测试通过后才进入下一阶段；不要累计多层改动后一次性测试。
6. Runtime 单测通过不等于任务完成。对真实事故使用隔离 fixture、真实模型和匹配的行为 oracle。
7. 最终检查 Node、Rust、lint、build、相关 Playwright、UI 主题及原工作区哈希，再提交。

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
