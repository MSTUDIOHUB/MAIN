# MAIN 本地模型 Agent Loop 复评

更新时间：2026-09-02

## 结论

MAIN 应只有一套与模型和 Provider 无关的执行过程：Turn admission → 读取证据 → 选择结构化动作 → 权限与 schema 校验 → 执行副作用 → 有限验证 → 基于 ledger 收尾。模型能力可以影响选取动作的质量、迭代次数和最终结果，但不能改变权限、执行、验证和终态的定义。

当前生产链已经基本满足这一方向。普通 MAIN、游戏开发和 MCP 工作都应进入同一 Runtime v2；Image Studio 仍是明确的非 Agent 图像渲染边界。原 Game Studio 的协议包、专用 slash、副作用 adapter 和独立 runner 不再保留。

## 已确认的生产所有权

- `submitAsyncWorkflowRun` 在 Turn admission 后冻结工作区规则、输入事实、工具目录与能力面。
- `submitRuntimeRunner` 只接受带 Runtime v2 标记的 Turn，并按不可变 runtime intent 选择 runner；不存在 legacy agent loop 回退。
- Execute runner 负责真实循环；Controller 负责 decision → durable schedule → side effect 的顺序。
- native tool call 和文本工具信封都会归一为相同的标准 action，再经过同一 schema、权限、执行和 ledger。
- Plan、Execute、Goal、Chat/Workspace Read 使用不同的有限能力面，但共享同一 Runtime 契约，而不是按模型名称分叉逻辑。

## 本轮修正的过程缺口

### 1. 无工具正文不能冒充完成

弱本地模型常先输出“我将继续检查”之类正文。此前 Execute/Validate 中一条无工具正文可能在恢复策略之前被终态化。现在只有证据已满足并由 Runtime 进入 `conclude` 模式时，无诊断正文才允许成为终结报告；其他正文保留在 transcript 中，并进入现有 recovery pressure。

### 2. 未分类验收不能默认为 behavioral

Direct Execute 没有显式 evidence requirement 时，不再被强制分类为 behavioral。未分类 criterion 以 durable `null` 保存，允许任一绑定到最终 mutation boundary 的真实有限 validator 闭环。显式 static、behavioral、interaction 分类仍保持权威。

### 3. 文本工具信封必须明确要求动作

Runtime 已计算“本次必须给出结构化动作”时，文本 lane 现在会把该要求传入工具信封提示，避免同时出现“必须动作”和“如果需要工具”的矛盾。

### 4. MCP 必须进入同一冻结工具目录

复评发现一个关键缺口：旧的 Runtime v2 admission 只冻结内置工具，虽然 Store 已发现 MCP 工具，Execute provider 仍无法看到或调用它们。现在 MCP discovery 会先归一为 catalog entry 和 capability，再与内置工具一起冻结到当前 Turn；provider 展示、schema 校验、授权和实际 executor 都使用同一份 catalog binding。Turn 开始后的 discovery 变化不能偷偷改写能力面。

MCP provider surface 受冻结的 routing threshold 限制。用户明确点名的已启用工具可被保留，但 remote name、exposed name、canonical name 或 `server:tool` 任一禁用键都是展示与执行的双重硬边界，提示词不能把它复活。

### 5. MCP effect 是外部效果证据，不是 workspace 或验收证据

成功的 MCP write/browser/desktop/destructive 调用会形成 durable effect/mutation evidence，并重置旧 observation frontier，使 agent loop 能继续验证和收尾；其 target 来自真实外部 `path`、`uri`、`url`、`target` 或 `input`。它不会伪造 workspace diff、源码 lease、mutation preflight 或文件版本。

在没有 typed contract 前，两个边界保持 fail closed：Approved Plan 不允许 MCP effect 越过已审阅 scope；任何非内置工具都不能充当 `execute_validation`。MCP transport 返回 `success/passed` 也不能被升级为 acceptance pass。

## 模型无关的过程契约

| 阶段 | Runtime 保证 | 模型只负责 |
| --- | --- | --- |
| Admission | 冻结 workspace、intent、规则、工具目录、能力与审批状态 | 理解目标 |
| Inspect | 提供有界读取工具与当前 source frontier | 选择需要读取的证据 |
| Act | schema、身份、调度、权限与 mutation preflight | 提出合法结构化动作 |
| Verify | 要求 mutation 之后、绑定 criterion/target/version 的有限验证 | 选择合适 validator |
| Recover | 对拒绝、重复、无工具正文和无效修改给出统一 ledger feedback | 改写动作或更换策略 |
| Conclude | 只从 durable evidence 和 Runtime phase 产生终态 | 组织用户可读报告 |

不应加入按 Ollama、OMLX、LM Studio、模型名字或参数规模定制的 agent loop。兼容差异只允许存在于 Provider adapter，例如 native tools、文本工具信封和结构化 capability error；归一后必须进入同一内核。

## 仍需验证的兼容边界

- Settings 中的“XML”目前实际表示关闭 native tools 后使用 tagged JSON 文本信封，不是旧式任意 XML tool grammar。UI 命名应改为“文本工具信封”，或增加一个严格、完整单块的 XML adapter；不能恢复从普通 prose 猜工具的启发式解析。
- 未知 OpenAI-compatible 网关的 native-tool capability error 仍可能只有字符串。可控 adapter 应逐步返回结构化 capability code。
- MCP effect 暂不能进入 Approved Plan 或成为 validator；要开放这两项，必须先定义可验证的外部 target/effect scope 与结构化 validator receipt，而不是依据工具名或成功字符串猜测。
- transaction/rollback、typechecker 级 mutation preflight、长驻 dev service 和视觉 artifact feedback 仍是通用内核能力缺口，不能通过模型特判补偿。

## 本地模型验收矩阵

每个受支持 Provider 至少选择一个较小模型和一个能力较强模型，使用相同 fixture 与验收条件：

1. inspect → edit → finite verify → conclude。
2. 首次只返回无工具正文，第二次收到 recovery 后发出合法动作。
3. schema 错误、未知参数和缺少必填参数都被拒绝，随后可纠正。
4. 同一动作经 native 与文本工具信封归一为相同参数、action identity、权限结果和 tool history。
5. 配置/文档/类型修改可由真实 static validator 闭环；显式 behavioral/interaction criterion 不得被 build-only 证据满足。
6. MCP 游戏引擎任务使用 MAIN 的通用工具面和审批边界，不进入任何专用模式；禁用工具即使被明确点名也不可恢复。
7. MCP effect 形成 durable 外部效果证据，但不能冒充 workspace diff、Approved Plan scope 或最终 validator。

建议矩阵：Ollama、LM Studio、OMLX 各跑至少一个真实模型；另外保留纯 adapter fixture，避免把网络和模型波动误判为 Runtime 回归。

## 已完成的自动化证据

- Runtime v2、instruction tombstone、system prompt 与 MCP 聚焦回归：222/222。
- MCP discovery → frozen catalog → capability → provider surface → real executor binding，以及审批、Plan、validator、routing、disabled-key 边界：4/4（包含在上项）。
- Composer、新手引导、三主题可读性、快捷菜单语义与工具分组 E2E：22/22。
- TypeScript lint 与生产 build：通过；`git diff --check`：通过。
- 全量 Node 回归：2319/2319。复评中同时清理了既存结构债务：将 review/terminal completion 与 recovery 原样抽到 `planCompletion.ts`，`planRunner.ts` 从 644 行降到 542 行；核心 loop、Provider/模型分支和终态/`finally` 顺序未改，550 行门禁保持不变并全绿。

这些证据验证的是“统一过程与失败边界”，不是宣称不同参数规模的模型会给出相同结果。Ollama、LM Studio、OMLX 的真实小/大模型矩阵仍应作为下一阶段发布验收；能力较弱的模型可以更早进入可解释 recovery 或 partial/error，但不能靠 provider/model 特判绕过 schema、权限、证据或终态规则。
