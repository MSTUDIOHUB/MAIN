# MAIN 审批、恢复与持久暂停修复记录

原始事件日期：2026-10-22；实施和验证跨至 2026-10-23。修改位于源码工作区，未发布、未打包、未替换已安装 MAIN。原有版本号等工作区改动保留。

## 原始事件的因果链

日志：`/Users/michael/Library/Logs/com.localagent.ide/main-debug.log`。会话 `1792669744930`，Turn `turn-1792669767462-0df903b0-648f-4223-b79e-9e430a0a5399`，Run `run-251e25ad-caf6-49a2-8beb-b9260dc249b3`。原始会话数据库仅作只读取证。

1. v2 的工作区外本地读取只认可精确路径授权，遗漏会话的 `autoApproveTools + local_file_read` scope。因此预先开启自动审批仍弹出审批；再次操作 UI 后才获得路径授权。策略禁止、显式逐次审核和 Rust 路径检查是独立边界，不能用自动审批覆盖。
2. 两次 `load_skill` 已成功返回可继续读取的 Skill 身份和位置。模型随后提出三个不存在的 `read_skill` 和一个 shell 调用；旧入口整体丢弃了批次，缺少逐项标准回执。模型开始猜测 Skill 的磁盘路径，外部读取审批后报 ENOENT，再尝试被 Rust 拒绝的 `find /`。
3. blocked/failed 动作被混入“已经完成”的集合；恢复继续要求工具调用，并把普通语义失败转成关闭 reasoning 的条件。这使模型难以解释阻塞或选择另一条路径。原始 Run 有 19 次运行时请求、17 次恢复，没有提交修改或完成验证，最终由用户取消。
4. “归纳范围”是运行时初始化步骤，并不表示每次做了完整代码结构分析。本次内部 skeleton 调用约 27 ms，之前 admission 已花约 1,031 ms 建立 baseline；额外约 14 秒来自意图预检。旧 UI 又会把单纯思考映射到默认 scope，因此容易形成“每次固定一步”的假象。
5. 现有 v5 serializer 已能只保存 canonical ledger，但最终 Session IPC 保存未使用它，导致事件、aggregate 和调度缓存重复落盘。日志分析器还把普通 shell 当作验证，并遗漏取消终态。原始数据库实际上只有一组取消终态和一条 final；重复发布日志不能等同于重复 final。

## 实施边界

| 所属层 | 实施内容 |
| --- | --- |
| 授权 | 外部本地读取复用既有会话 scope 规则，记录授权来源和会话身份；硬性禁止和逐次审核仍先执行。 |
| 工具协议 | 新增逐项拒绝、未执行和异常失败的 durable 事实；未知工具批次和延后调用不再静默消失。普通 shell 非零退出的状态归一化仍有缺口，详见真实回放结果。 |
| 模型恢复 | 普通语义失败不再强制工具调用或关闭 reasoning。真实输出截断仍保留本请求的可追溯恢复。Skill 续读返回明确的 `load_skill` 下一步。 |
| 暂停 | 同一拒绝动作在实际出站请求已包含反馈后再次出现，才形成闭环暂停；暂停期间不继续调度模型。无已证明独立工作时，只展示重新检查和停止。 |
| 决策与恢复 | 决策先持久化，再调度同 Turn、同 Run。精确请求身份、Session epoch、实例及 revision 共同防止迟到决策。已落盘但尚未调度的决策可以恢复。 |
| 副作用 | 已完成效果不重放。执行后失败的命令也不能因点击重新检查而直接重放；执行前被拒绝的动作可以重新检查条件。 |
| 等待与进度 | 审批等待从停滞计时中扣除；缓存回放和相同证据不续租。恢复历史使用 ledger 中的标准调用与结果对，不靠重执行工具补历史。 |
| 上下文与 UI | 有效 baseline 直接复用；实际初始化命名为“读取项目概览”，保留具体活动范围；纯思考不创建 scope 步骤。暂停原因使用可读文案。 |
| 存储与诊断 | 最终 Session IPC 保存调用既有 serializer，仅保存 canonical ledger。验证次数按类型统计；final 发布按 ID 去重，取消终态能被统计。 |

生产闭环回归还复现并修复了 UI 门禁问题：本任务暂停后 `agentStatus=pending_review` 被误认为另一个活动运行。现在只对精确匹配自己的执行暂停选择放行，其余 owner 门禁保持有效。

## 已完成的回归验证

- 完整 Node 回归：2,873 项，其中 2,872 通过，1 项需显式开启 Rust 测试宿主；该项另行开启后通过。
- 生产 Rust 测试：路径/进程执行 16 项、审批策略 17 项通过。
- Rust headless 宿主实际验证：允许命令、需要审批的命令、审批仍不能覆盖 `find /`、真实退出码 7、符号链接越界、Session CAS 冲突，均通过。
- 无界面 UI：既有选择流程、项目初始化和主题共 16 项通过；其中暂停卡片的浅色、深色、黑色冷恢复检查再次运行 3 项通过，并保留截图。
- 生产暂停闭环：真实 TS 提交、Runtime、Rust shell、SQLite 保存、UI 点击重新检查与停止，1 项通过。副作用文件保持单个 `x`，同 Run 仅有一次 `run.started`、一次 `run.resumed`、一组最终 Run/Turn 终态和一条 `assistant_final`；暂停期间请求计数不增长。
- 最新相关协议、批次和续跑回归通过；TypeScript 检查、前端源码构建通过。构建仅用于验证，没有安装或发布。

回归证据：`test-results/ornith-system-repair-regressions-20261022/`。主题截图：`test-results/ornith-system-repair-ui-20261022/`。

## 两轮真实模型验证方法

使用唯一已加载的 `Ornith-1.5-35B-A3B-OptiQ-4bit`。保留默认缓存，不清空、不卸载、不切换模型。每轮复制相同的 Assets、Packages、ProjectSettings 和 .protocols；每轮使用新副本、新 Session，保持原始指令、自动审批 scope 和子 Agent 偏好。

MAIN 通过 Vite + headless Playwright 运行。原生 IPC 中的 shell 审批与执行使用生产 `PermissionGuard`、生产 `run_workspace_shell_command` 和可信路径检查；Skill 读取使用受管理的实际内容寻址包；Session 写入每份副本自己的 SQLite。文件代理是测试适配器，不能把其结果当作所有桌面 IPC 均已覆盖的证明。

独立 Unity oracle 使用 Pipeline 的 Input System 注入键盘，eval 仅用于读取状态，不设置位置、分数或调用收集/重开方法。场景不存在、真实帧没有推进、输入不可用、无法取得 HUD 截图或 Console 结果未知，都不能通过功能验收。模型的自述和 shell 退出码 0 不能替代移动、三次收集、胜利、重开及截图验收。

最初两轮启动检查均在测试适配层失败，没有向模型发请求：通用 fixture 误读 CSV 文件，Editor 启动观测带了当前 CLI 不支持的参数。两轮请求总数前后均为 266，原失败记录保存在 `test-results/ornith-system-repair-20261022/`。修正后另开两轮真实模型回放，完整结果保存在 `test-results/ornith-system-repair-20261022-v2/`。不得把初始启动检查当作模型验收，也不得用后续成功覆盖初始失败。

## 两轮真实回放结果

两轮使用同一源码指纹 `2fb799204307…`。独立判定保存在 `test-results/ornith-system-repair-20261022-v2/independent-results.json`，与 Playwright 自身断言分开保存。

| 验收项 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 实际执行路径 | 进入 Runtime v2，15 个 canonical provider 响应，18 个实际出站请求（含预检与截断恢复） | 意图预检后即以 blocked 收口，未进入 Runtime v2 |
| 实际 shell | 27 条；其中 5 条真实非零退出码被错误记成 succeeded | 0 条 |
| 是否循环失控 | 收到重复拒绝反馈后持久暂停；请求数 18→18 | 预检新增了没有必要的“是否确认继续执行”门槛 |
| 功能结果 | 没有生成 CollectorTest.unity，无游戏交互验收证据 | 没有生成 CollectorTest.unity，无游戏交互验收证据 |
| 存储、收口 | ledger-only 保存通过；测试清理后只有一组 canceled 终态、一条 final | 有一组 admission blocked 终态、一条 final，无 Runtime v2 checkpoint |
| 判定 | **失败**：运行时协议仍有产品缺陷，且游戏任务没有完成 | **失败**：意图预检可以再次制造审批门槛，执行路径不稳定 |

第一轮的暂停、零新增请求、Session 序列化和唯一清理终态已验证，但这些不能替代游戏功能验收。第二轮没有 Runtime v2 ledger 是因为任务在 admission 阶段已经结束，不能把它误报为 ledger-only 合同通过或数据库丢失。

### 第一轮首次因果分歧：工具传输完成被当作工具成功

最早同类失真在 canonical sequence 40：`which unityhub` 的真实退出码为 1，ledger 却是 `succeeded`。直接导致最终闭环的是 sequence 265：

```text
unity command scene get_hierarchy --path Assets/Scenes/SampleScene.unity --format json
Rust: success=false, exitCode=6
CLI: Scene 'Assets/Scenes/SampleScene.unity' is not open.
Runtime: tool.completed(status=succeeded)
```

模型随后正确打开了 SampleScene（sequence 281，Rust exitCode 0）。再次查询相同层次结构时，Runtime 先以 `already_completed` 拒绝，再以 `already_rejected` 拒绝，最后在 sequence 294 暂停。此处不能仅归咎于模型重复：失败操作首先被记成了成功，实际结果污染了完成集合。

责任层是 TypeScript 的工具结果边界。Rust 已正确返回结构化 `success=false/exitCode=6`；`executionToolPort.ts` 仍向 `toolCompletionFor` 传入 `succeeded`。后者只在 `execute_validation` 路径检查语义结果，普通 `execute_tool` 原样接受成功状态。因此“普通 shell 的失败”仍可能成为成功证据，顺序批次也可能错误放行后继命令。

### 第二轮首次因果分歧：模型预检获得了审批控制权

预检返回的 `workType=implement`，所需能力是 workspace_read、workspace_write、command，`approvalRequiredCapabilities=[]`，但同时返回：

```json
{
  "needsUserChoice": true,
  "question": "本任务需要执行大量 Unity CLI/Pipeline 命令并运行 Play 模式进行键盘交互验证，是否确认继续执行？"
}
```

原始指令已明确要求“直接执行并完成”，且会话自动审批 scope 已开启。Runtime 仍接受这条模型生成的执行确认，把已 admitted 的 Turn 以 `workspace_instruction_action_applied / blocked` 收口，没有形成可恢复的实际执行 Run。

责任层是意图预检与 admission 控制边界。这与外部读取遗漏 scope 是两个不同问题：修正读取授权不能阻止模型在预检阶段重新发明审批要求。两轮进入路径不同，说明稳定性仍不足，不能宣称“完全修复”。

## 剩余修复方案与回归条件

### P0：在工具结果边界统一结构化 outcome

1. 在创建 canonical completion 之前，按工具的既有结构化结果合同归一化结果。`run_command` 使用真实 `success`、`exitCode`、`timedOut`；失败进入 `failed / execution_failed`，保留退出码和原始错误，不产生成功证据。其他具有明确结果合同的工具复用同一入口。
2. 不从 `modelContent`、stderr 的自然语言或字符串里的 “error” 猜状态；读取到的用户文件里有 `success:false` 也不能被误判为工具失败。
3. failed、blocked、not_executed 都不能进入已完成集合；失败前驱必须逐项结算剩余调用，不能放行依赖其成功的后继 shell。
4. 区分执行前拒绝与已经运行后失败。后者可能已有部分副作用，不能自动重放；修正外部条件后的重新观察，需要可证明的观察语义和新鲜度，不应只靠文件 mutation boundary 或模型自报幂等。

回归必须穿过真实 Rust → `executeTool` → ToolPort → Controller，而不是只断言 Rust 的 `success=false`。至少包括：exit 6、timeout、命令先产生部分副作用再失败、失败批次的后继不执行、冷恢复后同样的状态判定。再回放本次 sequence 265→281 的因果链，验证不会再出现 `exitCode=6` 与 `succeeded` 同时成立。

### P0：模型不能新建超出用户设置的审批门槛

1. 授权继续由用户指令、会话 scope、明确的逐次审核设置和硬性策略决定。模型的 `needsUserChoice` 只能提出缺失信息，不能单独成为重新确认已授权执行的依据。
2. 预检需给出可验证的结构化缺口，例如目标不明确、关键输入缺失或约束冲突；Runtime 对照 admission 事实校验。不要用中英文关键词规则判断“这个问题只是重复审批”。
3. 保留真正有必要的用户选择；使用已有 durable `user_choice`，记录准确 Turn/Run 身份后暂停，决策落盘后沿原 Turn 续跑。需要输入不能被投影成一个已结束但仍在询问的 blocked final。

回归使用同一份原始指令和相同授权设置，分别注入 needsUserChoice=true/false 的预检回包。仅因任务包含较多命令或 Play 验证，不能再次要求执行确认；真实目标歧义、策略禁止和显式逐次审核仍应正确保留。中文和英文等价输入都需覆盖。

### P1：补齐测试宿主的启动与终态观察

1. 当前 CLI 的 `--caller/--skill` 适用于 Pipeline command，不适用于这里使用的顶层 `status/open` 观测。启动隔离 Editor 后，应使用已发现的 `unity command editor status --project-path …` 等待真实 ready，并记录准确退出码。
2. 第一轮独立探针已经证明隔离 Editor 实际 ready，并确认当前工作目录默认连接的是副本 Assets；模型打开 SampleScene 的回执也明确指向副本端口 7801。因此启动观测参数错误不是第一轮最终闭环的主因，但必须修正，避免冷启动差异污染后续验证。
3. Playwright 必须观察 MAIN 整体的 canonical Turn/Run 终态。现有轮询只等 Runtime v2 checkpoint，遗漏 admission 已完成的 blocked 终态，使第二轮在没有模型请求的情况下空等，随后清理也不应把已经 blocked 的任务改写为 canceled。
4. 任一阶段失败时，先保存原始终态、请求摘要、Session 和独立 acceptance，再执行清理。原始任务结果与测试清理结果必须分列。

完成上述修复后，需要再用最终同一版本做两轮全新隔离项目验证，并继续保留本次失败。只有审批、真实失败状态、暂停续跑和 Unity 实际交互全部满足，才可给出“完全修复”的结论。

## 最终证据核对

两轮源码文件指纹一致，原始 Unity 项目 Assets、Packages、ProjectSettings、.protocols 文件指纹完全未变。两轮后均为 Ornith 唯一 loaded model、active_requests=0、waiting_requests=0。请求累计数为 266→284→285；没有切换或清除模型缓存。前端最终源码构建再次通过。

第二轮 Playwright 的清理断言失败保留在原日志中；独立验收和原始 Session 明确记录其真实任务结果是 admission blocked，未把该结果改写成取消。没有完成任何移动、金币收集、胜利、重开或 HUD 截图验收。
