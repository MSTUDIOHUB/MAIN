# MAIN 未执行动作与步骤展示补充修复

2026-10-23。本次承接 `ORNITH_SUPPLEMENT_REPAIR_2026-10-23_ZH.md` 中剩余问题。仅修改工作区源码、测试与文档；未打包、发布或替换已安装 MAIN，既有无关改动保留。

## 修复及边界

### 未执行回执不再成为动作自身的拒绝

旧版本首次因果错误发生在上次两轮 ledger 的 sequence 17：同批 shell 被真实路径策略拒绝后，两个 `load_skill` 在 sequence 17、23 以 `provider_batch_predecessor_failed` 结算，尚未执行，却再次按 `blocked / execution_failed` 加入拒绝集合。之后正确的技能读取也被 `already_rejected` 阻止。

本次新增共享的 `isRuntimeV2UnexecutedToolReceipt`，只依据 canonical 原因码识别依赖未执行事实，不解析模型措辞，不增加工具别名或 Ornith 特例：

- `executionProviderEffectFacts` 保留该 provider call ID 的未执行结算，但跳过动作失败、拒绝身份及成功效果派生。
- `already_rejected` 只是先前拒绝的反馈映射，不能单独建立新的拒绝授权。冷恢复重新从真实原始拒绝回执派生集合，避免继承旧版本错误缓存。
- `controllerRecovery` 不再为未执行动作建立“执行失败”的恢复事实。
- 同批前驱失败后仍保守地阻止批次尾部；后续新批次可重新提出未执行的合法动作，并重新经过 schema、scope、审批和路径检查。没有放宽 Rust 路径边界，也没有允许重放已经执行后失败的副作用。

完整旧 ledger 的只读重放同时验证了内存及序列化后冷恢复：两轮 sequence 17、23 均得到 `unexecuted=true, rejected=false`；原始真实权限拒绝继续保留。旧失败日志与旧实测 JSON 保留，修复后输出独立存放。

### 执行步骤按 canonical outcome 显示

工具行增加展示用的 `toolOutcome`，区分未执行、被阻止、执行失败和成功。投影会纠正历史已标成失败的行；Session 冷恢复也从经过 owner 校验的 canonical checkpoint 重新派生展示，不建立执行权限。

主步骤、摘要和状态标签使用可读结果，内部协议码、原因码、provider 关联 ID 及原始输出放入需手动展开的“调试详情”，canonical ledger 和模型收到的工具回执原文不变。成功读取的用户源文本不因包含类似错误字符串而被删改；真实验证器的编译错误输出仍保留。

未执行、权限阻止不计为实际尝试失败，也不增加已读取文件、已运行命令等计数。失败后有部分 diff 的修改继续保留其部分效果。新增测试还发现仅有失败/被阻止工具时界面会跳过整个步骤区域，现已纳入正常步骤展示。

## 确定性与生产集成验证

证据：`test-results/ornith-unexecuted-regressions-20261023/`。

| 检查 | 结果 |
| --- | --- |
| 新增运行时失败回归 | 修复前 4 项失败；修复后通过；覆盖两类前驱原因、冷恢复、真实拒绝与失败保护 |
| 新增展示失败回归 | 修复前 4 项失败；修复后通过；覆盖历史已结算行、状态、计数、原始回执不变 |
| 完整 Node 回归 | 最终 2,917 项：2,913 通过、0 失败、4 项原生 opt-in 默认跳过 |
| 显式原生 ToolPort/Rust 退出码与批次测试 | 9 项通过，包括上述 opt-in 路径；真实审批、路径、退出码、CAS、失败副作用保护及项目外测试存储 |
| 三主题 UI、Session 恢复与用户选择 | 15 项通过：三主题工具展示 3、暂停/澄清冷恢复 6、页面稳定性 1、选择交互 5；截图已检查 |
| 生产 TS + Rust + 独立 SQLite 集成 | 3 项通过；只替换模型 SSE，工具执行和权限使用真实生产边界 |
| TypeScript 与前端源码构建 | 通过 |
| Rust 测试宿主构建 | 通过；未构建桌面安装包 |
| 上次两轮完整 ledger 重放 | 两轮各含内存/冷恢复检查，未执行 Skill 不再被拒绝；真实权限拒绝保留 |

新增生产集成用例先提出一个权限禁止的 shell 和两个技能读取。两个技能在本批均不执行，随后新批次分别成功读取一次。接着 `printf x >> effect.txt; exit 6` 实际只写入一个 `x`，canonical 回执为非零退出失败；依赖的 `downstream.txt` 命令没有执行。再次提出失败动作会持久暂停，暂停后请求数不增加，最终用户停止仍正确收口。

保留了测试开发中的所有失败：原始确定性失败、初次类型检查、旧断言对 blocked 的错误预期、步骤区域漏显，以及 UI 测试首次只打开外层步骤却未打开内层操作卡的选择器错误。只读历史重放适配器首次误用仅含待执行项的 `scheduledCommands` 也已留档，随后改从 `command.scheduled` 事件读取历史命令。这些测试适配问题不归为模型失败。

## 首组两轮及测试宿主修正

首组保存于 `test-results/ornith-unexecuted-repair-20261023/`。两轮均执行，源码指纹 `8429730c1be841873f2cce44b6d4c96092192ae697ce122ec312b82b7b25aaf3` 全程一致；原项目文件指纹未变；两份测试 Editor 已确认退出。两轮均未通过，不用补测覆盖其失败。

| 检查 | 首组第一轮 | 首组第二轮 |
| --- | --- | --- |
| 实际 Ornith 请求 | 0，尚未进入模型请求 | 23，含意图预检 |
| 实际结果 | 首次 Session 保存失败，canonical error 收口 | 达到预定 780,000 ms 上限时仍在执行 |
| 技能与命令 | 尚未执行 | 4 次 `load_skill` 成功；37 次 shell 成功、3 次非零失败；另有 1 次权限阻止、3 次依赖未执行 |
| 游戏验收 | 没有 CollectorTest 场景 | 没有 CollectorTest 场景、没有新增游戏 C# 文件；实际输入验收未覆盖 |
| 原始结论 | 单个 error Run/Turn、一条 final | 截止点没有终态；之后独立清理为单个 canceled Run/Turn、一条 final |
| 出站工具配对 / 步骤内部码 | 无模型请求 / 无泄漏 | 无缺失配对 / 主步骤无内部码 |

第一轮的首次因果分歧是冷数据库初始化，不是 load_skill 或模型失败：原生测试宿主每次 IPC 新开 SQLite 连接，空数据库上的首次 `save_project_session` 与 `list_project_sessions` 并发初始化，前者返回 `database is locked`。20 个全新目录的原生并发探针中，16 个复现；先完成一次初始化再并发访问的 20 个对照目录均通过。生产 `SessionStore::open` 也调用同一 WAL 配置/迁移实现，因此新建数据库的并发初始化需要另行硬化，不能仅把该风险归为测试机器问题。

第二处是测试观察器：准入持久化失败后，MAIN 正确清空 `currentTurnId`，保留了准确归属的 error 结论。测试却继续用空活动指针查找目标，导致 13 分钟空等、后续持久化/清理误判。独立重建使用原始准入的 Turn ID，可立即得到 terminal error、禁止重复取消、零一致性错误。原始错误验收 JSON 与独立重建结果分列保留。

为使后续两轮确实进入 Ornith，而不掩盖这次失败，修正测试宿主：

- 顺序完成临时空数据库的 schema 初始化，再启动 UI 并发调用；不重试 Session 保存，不弱化 revision CAS，也不复制用户真实数据库。
- 从 `lastWorkspaceInstructionAcceptance.receipt.turnId` 保存准入 owner，终态观察、检查点读取、落盘验证和清理始终使用这个 owner；不从“最近一轮”猜身份。
- 原生桥的 SessionStore 错误按生产 IPC 的结构化格式输出，保留错误码；损坏数据库的真实错误回归修复前失败、修复后通过。
- 每次 Session 保存的审计保留输入哈希和 CAS 元数据，避免把不断增长的完整 ledger 重复复制数百次。真实 SQLite、最终 Session/ledger 和协议证据仍完整保留；首组原始大日志未删除。

这没有修复生产冷数据库并发初始化本身。顺序准备测试库只是匹配已运行 MAIN 的已初始化存储条件；产品初始化问题的修复边界见后文补充方案。宿主修正后的完整 Node、原生与三项生产链回归均重新通过。

## 补充两轮独立 Ornith 验证

最终两轮均已完成，**游戏任务两轮均未通过，不能宣称系统已完全修复或实际游戏验收通过**。确定性回归验证了本次拒绝集合及展示修复；真实模型仍暴露任务完成度和验证反馈问题。

### 展示补修与失败回归

实际回执发现成功读取也会泄漏 `READ_FILE_RESULT`、`TOOL_RESULT_EMPTY` 和 Skill 内部元数据。新展示函数只解析已知自有读取协议，标题显示读取范围或技能名称，正文保留用户原文，原始回执仅在“调试详情”展开。

长 Skill 又揭示两条独立缺陷：

1. Runtime 的展示预览在约 4,000 字符处截断 JSON，而 canonical `modelContent` 完整。界面解析截断预览失败后回退显示原始元数据。现在从完整 canonical 回执生成展示。
2. 相邻上下文活动先按 exploring 合并，才检查未执行/阻止状态，导致成功 Skill 被合入“未执行”步骤。现在先检查停止状态，保留各自结果。

补充回归还确认，若用户文件本身是一段完整读取协议示例，投影解包后 ActionCard 再解包会把 476 字符原文裁成 20 字符。修复保持完整回执传给 ActionCard，只进行一次正文格式化；canonical 内容及模型协议不变。原始失败、长回执失败、三主题合并失败、二次解析失败、测试端口占用失败均保留在回归证据目录，后续通过不覆盖它们。

### 历次尝试及中断归属

| 证据目录 | 结果及首个因果分歧 |
| --- | --- |
| `ornith-unexecuted-repair-20261023/` | 首组两轮均失败：冷库并发初始化与测试观察 owner 错误；第二轮达到时限。详见前节，完整证据保留。 |
| `ornith-unexecuted-repair-20261023-v2/` | 两轮均执行。第一轮页面重载、测试初始化覆盖恢复状态；第二轮 27 次模型请求，生成三个 C# 文件及场景，但仍到时限，独立日志存在 6 处 C# 编译错误，输入验证未完成。更新报告期间发生重载是本次测试操作风险，不能归为模型失败。 |
| `ornith-unexecuted-repair-20261023-v3/` | 冻结 Vite 模块图后第一轮 13 分钟未完成，Console 曾出现 10 条错误命令发现日志；第二轮启动阶段收到用户要求直接使用 TestCli，已终止副本及其 Editor，不作为完整两轮交付。 |
| `ornith-testcli-unexecuted-repair-20261023/` | 首次直接 TestCli 尝试中，为修复已证实的原文二次解析缺陷而受控中断。已归档其脚本及 durable Session，并还原项目。没有完成模型验收，不计算为最终两轮。中断产生的孤立 Vite 已关闭。 |
| `ornith-testcli-unexecuted-repair-20261023-v2/` | 下文最终同源码两轮，直接复用既有 TestCli Editor。 |

历史目录只保留紧凑工程证据包，Library、Temp 等生成缓存已删除。原日志及源码产物保留；首组约 280 MB 的重复 Session 审计经解压后 SHA-256 校验再无损压缩。

### 直接 TestCli 的最终两轮

按用户最新要求，未创建或启动其他 Unity 项目。实际项目为 `/Users/michael/Documents/Unity/TestCli`，复用原 Editor PID 19708。两轮分别使用全新浏览器上下文、会话和独立 SQLite，数据库位于各轮证据目录，未向 TestCli 创建 `.MAIN-test-session.sqlite3`。

源码指纹全程一致：`2f5f41f48e556627774e73ab92339cee3ad4c9665fd4bac414f1e943fdee6b41`。真实 Rust 测试宿主 SHA-256：`126cdac76c6b748c97d3f817207afbca07e16e43378e4f951a582999ba9090d4`。

第一轮将脚本写在固定备份范围外的 `AgentScripts`。在第一轮结束、第二轮提交前，测试宿主被暂停；依据 canonical diff 的 `existed=false` 和最后完整文件回执核对内容，归档并删除本轮新建的五个文件，再恢复宿主。没有修改运行时源码。补充归档、内容哈希及还原证明见 `additional-project-output.json.gz`、`additional-round-baseline-restoration.json` 和 `round-boundary-guard.json`。常规文件基线 293 个文件也经检查，第二轮未复用首轮脚本。

| 项目 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 实际出站模型请求 | 20 | 20 |
| 已加载模型 | 仅 Ornith-1.5-35B-A3B-OptiQ-4bit | 同左 |
| 前后 scheduler active/waiting | 均 0/0 | 均 0/0 |
| 人工审批请求 | 0 | 0 |
| Skill 读取 | 4 次成功 | 4 次成功 |
| shell canonical 回执 | 11 成功、1 硬性阻止 | 21 成功、1 硬性阻止 |
| 文件动作 | 5 次创建成功；1 次覆盖预检失败后改用 patch 成功 | 3 次创建成功 |
| 产物 | AgentScripts 下 Player、Coin、ScoreManager、HUD、CollectorGame | Assets/Scripts 下 CollectorGame、Coin、Hud |
| 模型结束情况 | 780,000 ms 时仍在运行 | 同左 |
| 游戏场景、帧、输入、胜利/重开、HUD 截图 | 未保存 CollectorTest；未覆盖 | 同左 |
| 工具消息配对错误 | 0 | 0 |
| 主步骤内部协议码 | 0 | 0 |
| 最终保存 checkpoint | ledger-only | ledger-only |
| 持久化/清理错误 | 无 | 无 |
| 模型原始终态 / final | 未结束：0/0 | 未结束：0/0 |
| 测试取消收尾后 | 1 个父 Run、1 个 Turn、1 条 final，一致 canceled | 同左 |

这里的取消结论属于测试清理，不是模型自然完成。两轮原始 running 快照与后续 canceled 快照分列保存，没有将停止任务冒充成功。

两轮未触发持久暂停，因此实际模型回合的暂停静默字段为空，**不能把空值算作“暂停后零请求”通过**。该路径由三项生产 TS/Rust 集成及三主题冷恢复测试覆盖。

缓存按原设置保留，没有清缓存、卸载或切换模型。服务端累计 requests 为 101→118→134，cached tokens 为 1,675,786→1,951,060→2,250,338；与各轮出站 20 次是不同计数口径，未强行一一对应。原始 before/after、请求及响应记录均保留，诊断中偶然出现的认证字段已脱敏。

### Console 报错与独立编译诊断

较早副本中的 10 条 Console 错误，来自把 listing 参数作为命令调用，例如 `scene --detail`、`capture --tags`，随后更换参数位置重复尝试。属于命令发现错误，不是这十条都代表游戏 C# 编译错误。

最终第二轮又出现错误的 `UnityEngine.TextMeshPro.TextMeshPro` 类型探测及缺少分号的临时代码，stdout 明确返回编译失败，但整段 shell 退出码为 0。随后用同样错误完整类型名反射得到 `no TMP`，不能据此证明环境缺少 TMP。这是模型探测逻辑与工具语义反馈问题，不能归因为真实环境缺包。也不能仅凭这些退出码 0，推断已有“非零退出码误判成功”回归。

两轮结束后的独立原生复现确认：经真实 Rust 权限检查和执行函数，`false` 得到 `exitCode=1`，`false | head -20` 得到 `exitCode=0`，均无副作用。首次选择的嵌套 `sh -c` 被既有策略拒绝，未执行，拒绝证据也保留。该复现验证进程退出码通路与管道语义；Editor 主线程阻塞期间没有重放实际 C# eval，因此没有把具体 CLI 自身的退出状态与管道影响强行合并成唯一原因。证据分别为 `native-pipeline-exit-repro.json`、`native-pipeline-exit-repro-allowed.json`。

两轮结束时 Console 返回 0 error，并不证明新增 C# 已编译：模型没有完成刷新/编译验证。独立后处理显式请求编译后，实际 `TestCli/Logs/Editor.log` 记录四个 CS1061：`Keyboard.rightKey`、`leftKey`、`upKey`、`downKey` 不存在。第一轮 Player 源码反而使用了正确的 `rightArrowKey` 等名称，但位于 Assets 外，未进入该次 Unity 编译。两轮失败路径不同。

同次日志报告 API Updater 的 `1 modified`。随后逐文件哈希核对证明，项目中的三个 C# 内容仍与模型最终输出一致；不能把这条日志当作升级已写回项目的证据。后处理归档保存了当时的源码及新生成的 meta。随后 Editor 主线程请求 504，Console 的 groundTruth 快照过期并停留在 compiling，55 次有界状态查询未能确认编译结束。这属于模型验收之后的独立诊断阻塞，不能改写此前模型结果，也不能把旧 `compilationFailed=false` 当作成功。

Unity 界面读取被工具明确拒绝：`Computer Use was not approved to use Unity`。未通过其他 UI 自动化绕过该限制。已请求用户确认现有 Editor 是否有弹窗；在确认前，不把 API Updater 日志推断成已证实的某一种弹窗。

### 用户处理弹窗后的恢复验证

用户回复“已处理”后，原 TestCli Editor 恢复响应。首次新鲜状态确认编译已结束但失败，报 Coin.cs、Hud.cs 文件不存在。此时快照发现 CollectorGame.cs 重新出现；与已归档模型源码逐字比较，唯一差异为 `rb.velocity = move;` 改为 `rb.linearVelocity = move;`，与 API 升级一致。此前独立编译后快照没有这次源码变化，不能混淆两个采样时点。

已保存处理弹窗后的完整项目快照，核对该文件在原基线不存在、确属此前已归档并清理的测试产物、其他文件没有变化，再移除这一残留。该现象暴露测试清理时序缺口：文件还原时哈希一致，不能保证仍挂起的编译或升级没有后续回写。恢复过程没有删除或覆盖其他人工改动。

对还原后的实际文件仅发起一次新的 refresh/recompile。初始 CLI 回执虽然 `success=true`、`failed=false`、errors 为空，却还带有 `compilationFailed=true`；未据此判为通过。待实际构建及域重载完成，Editor.log 记录 Tundra build success、成功重载 assemblies；独立 `recompile_status` 随后为 completed、failed=false、compilationFailed=false。Console 的新鲜采样 ageMs=13、compilationFailed=false、compiling=false，实际 Console 的 error/warning/log 均为 0。CLI 日志池仍保留早前一条 CS2001 历史记录，未通过清空日志掩盖错误。

编译后再次检查，原 293 个文件及目录与基线完全一致，原 Editor PID 19708 仍保持打开。778 个验证版本源码文件的哈希未变。新证据位于最终两轮目录的 `post-dialog-delivery-verification.json`、`project-restoration-after-dialog.json`、`project-comparison-after-restored-compile.json`、`editor-recovery-log-excerpt.log` 及对应状态/Console 回执。该恢复验证解决 Editor 阻塞与清理残留，没有重新执行模型任务，也没有改变两轮游戏验收失败的结论。

## 剩余系统修复方案

| 责任层 | 已证实的问题 / 复现 | 修复边界 | 回归条件 |
| --- | --- | --- | --- |
| 工具契约、插件适配与有限验证 | shell 退出码 0 可同时包含 CLI 业务失败；管道/复合命令还可能抹去前驱退出码 | 保留真实进程退出码；对已注册 CLI/MCP 契约返回独立、可信的业务结果。优先 argv 执行或保留逐段状态，任务验证不能仅以 shell 0 作为依据。不按任意 stderr/源码里的 error 字样判失败 | 直接退出 6、失败命令接 head、前段失败后末段成功、已知 CLI nested failure、合法输出含 error/JSON false 均分类正确；失败副作用不重放 |
| 验证证据与 Editor/Pipeline | 未导入源码时 Console 0；刷新后出现四个编译错误；主线程挂起后旧快照继续返回 | 验证回执绑定最后源码变更的版本/摘要及实际编译 epoch；新修改使旧通过证据失效。检查 sampledUtc/age、域重载与最终编译结果。缓存和过期状态不续租、不授权成功；等待由有界 native job/state 观察承担 | 写入新脚本后旧 Console 0 不能通过；真实完成编译才可进入 Play；旧快照、未完成 domain reload、主线程 504 和 API 更新阻塞均不能报成功或重放未知副作用 |
| Skill/能力上下文及模型任务质量 | 第一轮 runtime 脚本放在 AgentScripts；第二轮错误 Input System 字段、错误 TMP 类型探测；大量请求用于帮助探测 | 按任务实际产物提供最小能力事实和相关 Skill 资源，区分独立 Editor builder 与需导入的 runtime 脚本位置；使用当前包/API 事实及真实命令 schema，限制帮助输出并给继续游标。保持模型无关，不增加猜测工具别名、强制 reasoning 开关或裸重试上限 | 同原任务达到可编译、持久场景及实际输入验收；错误类型名不被解释为缺包；重复命令描述不构成新的进度证据；两轮均满足原标准才宣称稳定 |
| mutation 预检结果 | 首轮覆盖既有新建文件的预检被标为 tool.failed，实际上没有进行第二次写入 | 在预检拥有层输出明确 attempted=false / blocked，不让展示层猜测；保留必须 patch 的保护与既有副作用禁止重放 | 预检未执行不计真实文件写入失败；实际执行失败仍计入，策略拒绝与依赖未执行分别结算 |
| 生产 SessionStore 初始化 | 空库并发初始化 20 次有 16 次 database locked；仅预初始化的对照全过 | 在 `SessionStore::open`/WAL/迁移边界建立一次初始化协调和有限 busy 处理，保留 revision CAS。不用重试保存覆盖竞争，不只在测试宿主绕过 | 多进程/多连接空库并发初始化及迁移无锁失败；真实 CAS 冲突仍拒绝；损坏库仍保留结构化错误 |
| 测试宿主与验收覆盖 | 固定备份前缀漏掉 AgentScripts，本轮已以 canonical diff 手工补充；强制中断曾遗留 Vite；挂起编译/升级在文件还原后仍发生测试源码回写；当前 oracle 只走 R 重开 | 初始记录全部非缓存项目文件与自建文件归属，按 hash 拒绝覆盖并发人工改动；清理前等待已发起的编译/升级进入终态，未结算时保留阻塞状态，后续再核对残留；追踪自己启动的服务并优雅终止。支持原要求中的 R 或真实按钮输入，补方向键及原生文件 IPC 覆盖 | 任意新顶层源码目录均可独立还原；两轮会话与文件无串用；延迟更新不得在已确认完成的清理后复活测试文件；中断不遗留自有服务、不关闭原 Editor；按钮、方向键及 cold restart 的未覆盖项明确验证 |

真实模型使用实际 provider、Skill 包、生产 Runtime 和 Rust shell/权限/SessionStore；普通文件 I/O 仍通过测试的有界 Node 文件桥。PTY、浏览器能力显式不可用。不能把这些结果扩展成完整桌面原生文件 IPC 或所有能力均已覆盖。

## 清理与交付状态

依照用户要求，已将 15 份自有测试目录中的工程证据压缩保留，删除重复 Library、Temp 等生成目录，移除文件按目录占用统计约 **13.78 GiB**。这不是整个磁盘净空闲空间增量。最终两轮期间 OMLX SSD 推理缓存由 5.78 增至 14.74 GiB，按此前设置保留，没有清缓存或卸载模型；其他进程和文件系统共享块也影响磁盘净值。最后一次磁盘检查可用约 425 GiB。原项目缓存、已安装 MAIN/Unity/CLI 均保留。清理明细和压缩校验见 `test-results/ornith-unexecuted-regressions-20261023/cleanup-receipt.json`，缓存分轮数值见最终证据目录的 `cache-size-comparison.json`。

最终第二轮的三个 C#、三个脚本 meta 和新 Scripts 目录 meta 已在模型原始产物及独立编译后快照分别归档后清理。还原先因新生成的目录 meta 触发保护拒绝；核对目录及源码在原基线中均不存在、目录内容全为 canonical 已证明的新建测试文件后，再完成还原。未忽略其他任意文件变化。`project-restoration-after-validation.json` 证明 TestCli 的 293 个基线文件哈希完全一致。SampleScene 保留，没有关闭或替换原 Editor。

文件还原与 Editor 状态验证分开：用户处理弹窗后，主线程阻塞已解除；延迟回写的测试文件已归档清理，还原项目的新一轮编译与域重载通过，当前 Console 为 0 错误。未强制退出 Editor 或绕过 UI 权限。实际游戏完整验收仍未通过，两轮原始失败证据和结论保持不变。

未打包、发布或替换已安装 MAIN。工作区源码及回归测试保留；`.MAIN` 存储设计仅做分析，未执行迁移，详见 `WORKSPACE_STORAGE_DESIGN_2026-10-23_ZH.md`。
