# MAIN 补充修复与 Ornith 两轮验证

2026-10-23。本文承接 `ORNITH_SYSTEM_REPAIR_2026-10-22_ZH.md`，保留上次两轮失败证据。修改仅在源码工作区；没有打包、发布或替换已安装 MAIN。既有无关改动保留。

## 此次修复

### 工具结果的传输完成与实际成功分开

生产调用链为 `submitAsyncWorkflowRun → submitRuntimeRunner → RuntimeV2Controller → executionToolPort → executeTool → Rust`。Rust 已正确返回非零退出；错误发生在 TS ToolPort 创建成功回执时。

新增 `executionToolOutcome.ts`，在 canonical completion、效果记录和模型历史之前，按明确的原生工具合同归一化结果：

- `run_command` 的 `timedOut=true`、非零 `exitCode`、`success=false` 分别产生失败原因，状态为 `failed / execution_failed`。
- `browser_evaluate` 使用其原生 `ok=false` 合同。MCP 的 `isError` 仍由现有 MCP adapter 抛出失败。
- 不解析自然语言错误关键词，也不把读取到的用户 JSON 中的 `success:false` 当作工具失败。
- 真实输出、退出码、超时标志保留在回执与测试审计中。失败不产生成功证据，不成为已完成效果；同批后继逐项返回未执行回执。
- 已运行后失败的命令可能有部分副作用，保持原有禁止自动重放的边界。此修复不把任意 shell 命令猜测成可安全重试的只读观察。

最初四项失败回归均复现 `actual=succeeded / expected=failed`。修复后的原生集成实际执行 exit 6、超时、写入 `partial.txt` 后失败，贯穿真实 Rust、`executeTool`、ToolPort、Controller 和 checkpoint 冷恢复；后继 `tail.txt` 没有创建，部分副作用文件仅为单个 `x`。

### 意图预检不再凭一个布尔值追加审批

删除 `needsUserChoice` 单独决定工作区 blocked 收口的路径。能力需求与任务长度都不能形成新审批；自动审批 scope、明确逐次审核和 Rust 硬性策略继续在真实工具边界执行。

真正的澄清需提供结构化缺口：目标歧义或缺失输入、具体字段、当前指令中的逐字依据和问题；目标候选必须实际出现在该依据中。能力冲突由 admission 的能力限制计算，不接受模型凭空声明冲突。

工作区澄清进入现有 canonical `run.paused` 和 `user_choice`。用户回答记录为 `run.decision_recorded(reply)`，先持久化再调度，同 Turn、同 Run 续跑；回答以 user 消息恢复到唯一模型历史。停止产生正常取消终态。等待期间不向模型发请求。

该入口保留 Execute、只读、Plan 原策略及其能力限制、逐次审核、网络设置和验收合同。精确请求身份、Session epoch、revision 和运行实例的迟到决策门禁继续有效。澄清卡片复用现有 UI，支持候选项和自定义回答。

这是一项结构验证边界：可验证依据确实来自当前指令，不能用自动审批跳过真正输入缺口；对于“缺口是否确实有必要”的语义判断，仍需模型正确理解请求，不能宣称运行时能完全证明自然语言语义。

### 测试宿主正确观察 ready 和终态

- 隔离 Editor 启动后使用当前实际支持的 `unity command editor status --project-path … --caller plugin --skill unity-cli --result-only`。必须返回目标副本路径、ready、非编译、非 domain reload，才开始该轮真实任务。
- `runtimeTaskObservation.ts` 复用 canonical Turn/Run 终态选择器并 normalize checkpoint；覆盖没有 v2 checkpoint 的 admission 终态，忽略无关 Turn、子 Run 和单纯 idle。
- checkpoint commit 与 UI final 发布之间继续等待投影，同时禁止清理改写已经结束的任务。
- 原始 runtime、Session、请求摘要、截图和 acceptance 先保存；清理结果分列。清理失败不再阻止保存独立验收，也不能把已经 blocked 的任务改写成 canceled。
- 两轮外层循环保留每轮异常，第二轮不会因首轮测试失败而被跳过；每轮前后检查实际 loaded model 和请求状态，继续保留缓存。

## 验证边界与已通过的检查

| 检查 | 结果 |
| --- | --- |
| 最终完整 Node 回归 | 2,894 项：2,892 通过、0 失败、2 项原生 opt-in 测试默认跳过 |
| 显式开启真实原生测试 | 7 项通过，包含上述两项 opt-in 边界及其相关断言 |
| 生产暂停、重新检查、停止；生产澄清、回答、续跑 | headless Playwright 2 项通过；实际 TS、Rust shell、独立 SQLite |
| 浅色、深色、黑色的暂停与澄清冷恢复 | headless Playwright 6 项通过，截图已检查 |
| Execute、只读、Plan 的澄清准入/恢复 | 3 项确定性回归通过，包含策略、权限、网络、同一 owner |
| TypeScript、前端源码构建 | 通过；没有构建桌面安装包 |
| Rust 测试宿主源码构建 | 通过 |
| Unity CLI 只读版本检查 | 当前与最新均为 1.0.0-beta.14，没有更新或安装 |

证据目录：`test-results/ornith-supplement-regressions-20261023/`。

保留的测试适配失败：第一次新增集成用例复用了前一项的真实临时 SQLite，导致 Session CAS 冲突；第二次改成独立目录后遗漏非空 fixture。现在每项有独立项目和数据库，并创建明确 fixture。两次失败日志和数据库未删除，第三次两项通过。完整 Node 首轮另有一项旧断言仍要求预检提出问题后立即 blocked 收口；新合同要求进入可恢复 Runtime，已更新该回归并重新完整运行通过。

## 两轮真实模型验证

证据保存于 `test-results/ornith-supplement-repair-20261023/`。模型固定为唯一已加载的 `Ornith-1.5-35B-A3B-OptiQ-4bit`；两轮使用同一源码指纹、同一原始指令、相同授权与验收、各自全新项目副本和 Session，不清缓存、不切模型。

每轮通过真实 provider 和受管理 Skill 包，shell 审批、路径边界、退出码和 Session CAS 使用生产 Rust 函数。文件代理仍是有边界的测试适配器，不能把通过结果扩展为全部桌面 IPC 覆盖。

Unity 独立 oracle 要求真实帧推进、Input System 键盘移动、逐枚收集、胜利、重开、HUD 截图和 Console 检查；不允许直接设置坐标、分数或调用游戏方法代替。任务自述、退出码 0 或生成一个场景都不能替代功能验收。

源码指纹为 `fb7d2266b32680f6f508a6a0c5d5d0940f03f96ae9d048a8ef048418cfa1989d`，两轮结束后的重新计算完全一致。原项目 Assets、Packages、ProjectSettings、.protocols 文件指纹未变。两份隔离 Editor 均已确认退出，没有结束原项目 Editor。

| 验收项 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 隔离 Editor ready | 通过，约 84 秒，路径准确 | 通过，路径准确 |
| 实际模型请求，含意图预检 | 7；累计 285→292 | 4；累计 292→296 |
| 意图预检 | implement，needsUserChoice=false，正常进入 v2 | implement，needsUserChoice=false，正常进入 v2 |
| 人工工具审批请求 | 0 | 0 |
| 实际执行的 shell | 2 条，退出码均为 0 | 1 条，退出码为 0 |
| 非零退出误报成功 | 本轮未产生真实非零 shell；相关不变量由原生 exit 6/timeout 回归验证 | 同左 |
| 运行时结果 | 持久暂停，重复拒绝 load_skill | 持久暂停，重复拒绝 load_skill |
| 暂停期间请求数 | 7→7 | 4→4 |
| Session ledger-only | 通过 | 通过 |
| 重复项目概览扫描 | 0 | 0 |
| 测试清理 | 单组 canceled Run/Turn 终态、一条 final，无清理错误 | 同左 |
| Unity 实际验收 | 未生成 CollectorTest.unity；未覆盖移动、收集、胜利、重开及 HUD 截图 | 同左 |
| 最终判定 | **失败** | **失败** |

两个实际预检都没有追加执行确认。另以完全相同的原始指令注入 `needsUserChoice=false/true` 和上次真实的重复审批问题，确认两者得到相同 Execute 路由、能力限制及工具审批指令；证据为回归目录中的 `original-intent-true-false.json`。

测试宿主此次没有出现上次的空等、终态误认或清理抹掉原结果的问题。两个原始结果均为非终态 paused，cleanup.json 中的 canceled 是测试结束时的独立清理，不能算作模型完成或原任务成功。两轮后 Ornith 均为唯一 loaded model，active/waiting 均为 0。

## 剩余根因：未执行的 Skill 动作污染拒绝集合

两轮失败具有同一可复现的产品原因，不能归结为 Unity 没有启动或模型不会使用 Skill。

1. 两轮 sequence 5 都提出一个 shell 加两个 `load_skill` 的批次。shell 包含工作区外路径或不受支持的重定向，sequence 11 被生产路径边界正确拒绝。自动审批不能覆盖这些边界，此处不是新增审批缺陷。
2. sequence 17 和 23 的两个 Skill 读取尚未执行，同批结算返回 `blocked / provider_batch_predecessor_failed`。这能阻止本批依赖错误假设继续执行，但没有证明 Skill 读取自身失败或不被允许。
3. `executionProviderEffectFacts.ts:155` 已识别这些回执，并把它们加入 `unexecutedToolCallIds`；但同文件 `:269` 的拒绝动作派生又按 `blocked + execution_failed` 把同一个 Skill 身份加入 `rejectedActionIdentities`，没有排除未执行动作。
4. ProviderPort 把该集合交给动作选择器。模型之后使用正确的 `load_skill(skill_id)` 也被返回 `already_rejected`。第一轮 sequence 74、第二轮 sequence 45 形成“模型已看到拒绝又提交”的反馈闭环，最终暂停。

首次错误的语义归类在两轮 sequence 17，而不是最后的 pause。第一轮模型已成功改用 `command -v unity` 和 `unity --version`，第二轮已成功执行 `which unity` 并列举 Skill 元数据，但仍不能重新读取此前根本没有执行过的 Skill。受管理 Skill 包可用，Editor 也 ready；阻塞来自 TS 的效果事实派生与批次恢复。

最小回归仅需要原始 ledger 中的 `command.scheduled(load_skill)` 与 sequence 17 的未执行回执。运行：

```sh
node test-results/ornith-supplement-repair-20261023/reproduce-unexecuted-skill.mjs
```

该单独保留的失败回归得到 `unexecuted=true, rejected=true`；独立预期为 `unexecuted=true, rejected=false`，断言确定失败。原始 fixture、实测 JSON、断言日志与两轮完整失败均保留。它不属于已通过的 Node 主套件，不能用主套件绿色掩盖这个新暴露的覆盖缺口。

## 剩余修复方案与回归条件

### P0：分别派生执行失败、准入拒绝与依赖未执行

责任层：`executionProviderEffectFacts.ts`，邻接边界为 `executionSequentialShellBatchReceipt.ts`、ProviderPort 的动作集合以及历史恢复。

修复应首先使用现有 canonical 未执行回执排除拒绝缓存污染：

1. `provider_batch_predecessor_failed/unsettled`、provider deferred 和其他明确未执行回执，不得进入该动作自身的失败/永久拒绝或已完成集合。它们仍关闭原 provider tool-call ID，并保留前驱依赖事实。
2. 新 provider 批次单独提出此前未执行的合法动作，重新走原有 schema、scope、审批和路径校验，不能继承前一个批次的“前驱失败”。同一个仍含失败前驱的批次不得借此放行后续命令。
3. 真实执行后失败的 shell 继续禁止自动重放；部分副作用不因解除未执行缓存而丢失。真实策略禁止、用户拒绝和显式逐次审批仍有效。
4. 审计 provider history、完成身份和恢复后的集合派生，避免只修内存路径。pause 规则继续依赖真实拒绝事实，不通过关闭循环保护来掩盖错误缓存。

必需回归：失败 shell + 两个 Skill 的原始批次；分别重新提出两个 Skill 应各执行一次；重提包含失败前驱的依赖 shell 批次仍不执行；实际部分副作用失败不重放；冷恢复前后集合一致；每个调用都有一条可追溯回执。

### P1：缩小混合批次的依赖假设

责任层：provider batch 调度和工具能力合同。当前把 shell 后的所有读取都视为依赖，连内容寻址、没有外部可变前驱的 Skill 指南读取也一起中止。

可以依据真实工具能力与不可变资源版本允许已证明独立的指南读取继续执行；无法证明独立的后续 shell 和受前驱影响的项目读取继续逐项结算为未执行。不能仅凭模型声称“独立/幂等”放行，也不要新增模型专属规则或猜测工具别名。即使保留保守批次中止，P0 也必须保证后续独立新批次能正常再提出该动作。

回归必须同时证明独立 Skill 不被封死、依赖操作仍受保护、没有静默丢调用或重复副作用。

### P1：未执行步骤的展示和诊断码仍需收口

实际检查第一轮 `main.png` 发现，执行步骤仍把前驱失败导致的 Skill 未执行展示为“失败”，并直接显示 `TOOL_BLOCKED`、`TOOL_NOT_EXECUTED` 和 provider 调用 ID。这是独立的投影缺陷，不是导致任务暂停的首个原因。

责任层是工具步骤和 presentation 映射。应按 canonical outcome/未执行原因展示“未执行”“被策略阻止”“执行失败”，只把真正尝试失败计入失败统计；内部协议码和关联 ID 保留在调试详情与日志中，主界面使用可读原因。不能修改模型收到的真实工具回执来美化 UI。

回归需加入真实失败批次的浅色、深色、黑色截图断言：主步骤不含内部码或 provider ID，Skill 未执行不显示为已执行失败，展开详情仍能追溯原始原因。本次已通过的 6 项主题检查验证了暂停/澄清卡片与恢复，不能代替该工具行断言。

### P1：保留外部状态观察与完整 Unity 验收的证据缺口

任意 shell 都不能只凭命令文本或模型声明被当成可安全重试的观察；外部条件改变后如何重新观察，仍需受支持的观察语义和新鲜状态依据。不要通过放开 Rust 路径限制或自动重放失败命令来解决。

上述 P0/P1 完成后，应把本次最小失败 fixture 纳入正式回归，再用新冻结版本做两轮新副本验证。Unity oracle 此次因场景缺失没有执行键盘、帧推进、收集、重开和截图；这些均仍是未覆盖项。不能根据修复了 Skill 读取便推断游戏一定可完成。

本轮三个指定补充修复已实现并有相应回归证据，但两轮真实任务均失败，**MAIN 的完整端到端修复尚未达到验收标准**。当前保留原始失败并交付上述剩余根因和补充修复边界，没有用额外重试覆盖这两轮结果。
