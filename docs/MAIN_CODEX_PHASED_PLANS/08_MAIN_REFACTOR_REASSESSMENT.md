# MAIN 与 Game Studio 重构计划复审

## 结论

Phase 1 和 Phase 2 的核心方向仍然正确：类型边界、store 依赖方向、submit
决策与副作用分离都产生了真实维护价值。

Phase 3 的价值也存在，但继续按“拆出更多模块、继续降低 execute 行数”推进已经
不再准确。`AgentOrchestrator` 的结构拆分应在当前状态停止，转入行为验收与收尾。
Phase 4 Game Studio 应在该验收门通过后开始，不再等待 `execute` 继续缩短。

这次复审不撤销已经完成的拆分，也不要求为了减少文件数量立刻合并模块。先证明
行为等价和运行时价值，再决定是否有必要做一次有指标约束的合并。

## 复审证据

当前工作树的关键指标：

| 指标 | 当前结果 | 判断 |
| --- | ---: | --- |
| 原 `AgentOrchestrator.ts` | 7,919 行 | 原文件确实需要拆分 |
| 当前 `AgentOrchestrator.ts` | 542 行 | 已达到高层协调器形态 |
| 当前 `execute` AST 范围 | 501 行 | 行数不再是主要风险 |
| `orchestrator/loop` | 62 个模块、16,745 行 | 已冻结，不再继续拆分 |
| loop 内部相对导入 | 179 条 | 依赖面需要冻结，不能继续增长 |
| 顶层 phase 调用参数 | 22 / 31 / 43 / 57 项 | 剩余问题是契约宽度，不是代码仍未搬完 |
| 小于 120 行的 loop 模块 | 15 个 | 需要按职责判断，不能按尺寸机械合并 |
| 新增 Phase 3 node 测试 | 40 个、5,229 行 | 覆盖投入充分，但结构耦合偏重 |
| 新增测试读取源码文本 | 40 / 40 | 不能作为行为等价的唯一证据 |
| 包含逻辑执行或源码转换 | 29 / 40 | 并非全是表面测试，但仍需 harness 场景测试 |
| `useAppStore.sendMessage` | 649 AST 行 | Phase 2 已到合理停止点 |
| `useAppStore.ts` | 6,990 行 | public store 仍大，但不以总行数强拆；决策/副作用边界已外移 |
| `src/lib` 反向依赖 store | 仅 `src/lib/e2e.ts` | Phase 1 边界目标基本达成 |
| Game Studio canonical domain | 7 个文件、2,099 行 | catalog/pack/detection/onboarding/service 已内聚 |
| 旧 Game Studio 顶层入口 | 5 个 shim、共 5 行 | 只保留发布兼容，无生产代码直接导入 |
| `Composer.tsx` | 2,386 行 | 三个独立 UI ownership 边界已完成，不设行数目标 |
| e2e scenario ownership | 入口 6,847 行 + 首个 registry 283 行 | 稳定 bridge 保留，按 scenario 渐进迁移 |

`AgentOrchestrator.execute` 现在已经表达出稳定的高层顺序：turn 准备、iteration
准备、stream 调用、assistant phase、tool phase、max-iteration boundary。继续拆分
setup 或单个 recovery 分支，只会继续增加模块与参数搬运。

独立架构审阅还确认了两个残余风险：`OrchestratorCallbacks` 混合了状态读取、UI、
Plan、hooks、approval 和 tool execution 等多类能力；部分 phase 返回新 state，另一些
phase 通过闭包 setter 更新 state。这些问题真实存在，但不是继续拆更多文件的理由，
也不应阻止 Phase 3S 完成。

重构本身不会直接提高模型执行任务的速度。真正影响 MAIN 任务效率的是首个有效
写入前的只读轮次、重复读取、无行动停止、context 实际裁剪和 provider fallback
次数。结构重构的价值是让这些行为更容易修复、测试和观察。

## Phase 3S 完成记录

Phase 3S 于 2026-07-10 完成，Phase 3 正式结束。

- `src/lib/orchestrator/loop` 保持 62 个模块，没有新增 phase/recovery/state 文件。
- 删除 `AgentOrchestrator` 中未使用的 `prepareTurn`、`invokeStream`、
  `evaluateResults` 占位方法。
- forced context reason 与实际 `droppedMessageCount`、`microCompactionKind` 现在由
  同一个可测试 telemetry builder 生成。
- `executeAgentLoop` 的 awaiting-choice 和 abort outcome、max-iteration 的
  stop -> idle -> turn.completed 顺序已有运行时行为测试。
- 修复失败的 command/browser validation 被固定工具名集合二次标记为执行证据的
  问题；失败验证不再清除 recovery 或绕过 completion guard。
- 云端正常请求不再被无条件按 32K 本地管理；context error 优先使用 provider
  报告窗口，未知窗口按当前估算保留 30% headroom。clamp telemetry 的比较顺序也已
  修复。
- stream recovery 的最终用户错误按 `getPreferredLanguage()` 输出；
  `plan_unsupported_tool_call_suppressed` 的核心日志字段已对齐。
- `scripts/analyze-agent-runtime-log.mjs` 提供零依赖、可重复的运行时效率基线分析。

当前真实日志基线包含两个 loop：

| runtime intent | 最大轮次 | read_file | mutation | 首次 mutation | no-action | provider retry | forced context | 实际丢弃消息 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| plan | 5 | 5 | 1 | 5 | 1 | 0 | 0 | 0 |
| execute | 17 | 9 | 5 | 3 | 0 | 0 | 5 | 20 |

这份基线描述历史运行，不宣称本轮结构重构已经改善性能。后续阶段应使用同一脚本
对比首个 mutation、重复读取、no-action、provider retry 和实际 context 变化。

验收结果：

- `npx tsc --noEmit --pretty false`、`npm run lint`、`git diff --check` 通过；
- `npm run build` 通过；
- 全部 1,093 个 node tests 和 `npm run test:workflow-assets` 通过；
- 5 个 Phase 3 focused Playwright 场景通过，覆盖 awaiting choice、native -> XML
  fallback、approved plan no-tool checkpoint、approved plan repeated reads 和普通 execute
  repeated-read recovery pause。

已识别但不在 Phase 3S 强行迁移的剩余项：local/cloud no-tool 与 read-loop 阈值仍
散落在多个 recovery 模块，现有 `ExecutionPolicy` 只覆盖部分 prompt/response policy。
这属于 Phase 3C 候选；只有后续维护证据证明值得统一时才进入，不能直接选择一组
数字替换现有策略。

## Phase 4 完成记录

Phase 4 于 2026-07-10 完成。Game Studio 的产品定位不变：MAIN 继续覆盖普通与
单次游戏开发任务；Game Studio 保留为长期游戏项目的生命周期、阶段门、专家角色、
引擎上下文和 workspace-local workflow pack。

- catalog、command docs、intent detection、pack、onboarding 和 runtime service 的
  canonical ownership 已迁移到 `src/lib/gameStudio/`。
- 五个旧顶层模块只保留一行 compatibility re-export；生产源码对旧路径导入为 0。
  shim 的删除条件是发布兼容审计确认没有外部/历史消费者，而不是继续按行数清理。
- `GameStudioRuntimeService` 的初始化、引擎配置、slash resolution、local help、turn
  envelope 和模式切换已有直接行为测试。
- installable pack 已去除 `.claude` 路径、Claude 专属工具 frontmatter、上游 README、
  本地设置模板和 MAIN 不支持的 hook schema；MIT 许可证与来源归属保留。
- 修复 `pretool-command-guard.sh` 只识别 `execute_command` 的硬编码，当前同时保护
  `run_command`，并由 shell 行为测试覆盖。
- onboarding 现在能回答“为什么用、会创建什么、下一步做什么”，并明确 MAIN 与
  Game Studio 的适用边界。

Phase 4 验收结果：

- `npm run lint`、`npm run build`、`git diff --check` 通过；
- 全部 1,100 个 node tests 和 `npm run test:workflow-assets` 通过；
- onboarding、plan shortcuts、tool grouping 13 个 Game Studio Playwright 场景通过；
- cloud Game Studio execute-reply Playwright 场景通过。

## Phase 5 完成记录

Phase 5 于 2026-07-10 完成受控切片。

- `GameStudioOnboardingPanel`、`GameStudioSlashMenu` 和 `MainModeSwitcher` 已从
  `Composer` 提取；业务状态、键盘/过滤逻辑和隔离模式切换仍由原 owner 管理。
- onboarding 的全部双语流程文案由 `src/lib/gameStudio/onboarding.ts` 统一提供。
- 13 个 Composer/Game Studio focused Playwright 场景通过。
- `ChatArea` 的 turn/scroll/Plan/transcript 以及 `SettingsModal` 的 Cloud/Local/Context
  controller 都是高耦合状态边界；本阶段评估后明确推迟整体拆分。
- 三个 Cloud Settings seed 已迁移到 `src/lib/e2e/scenarios/cloudSettings.ts`；入口仍同步
  建立 `window.__CODELY_E2E__`，并注入最小 store facade，避免扩大 Zustand 反向依赖。
- 新增 bridge contract 与 `src/lib` store import guard；相关 5 个 focused Playwright
  场景与 endpoint Node tests 通过。
- 顺手修复有测试证据的硬编码：OMLX 默认端点统一为 `8000/v1`，Cloud/Local 默认端点
  改为单一 registry，Context 设置页移除与真实 runtime 不一致的固定百分比承诺。

## Phase 6 集成结果

Phase 6 于 2026-07-10 完成当前重构范围的集成验收。

- 最终 `npm run build`、`npm run lint`、`npm run test:workflow-assets` 与全树
  `git diff --check` 通过；Node 结果为 1,102/1,102。
- 完整 Playwright 已实际执行：110 通过、2 个依赖真实 OMLX 的场景跳过、33 失败。
  其中 9 个是已关闭 Cloud OAuth lab 的陈旧测试，1 个是漏掉 `/image`、`/goal` 的旧
  catalog 断言；修正后 focused 结果为 18 通过、7 个因功能关闭而显式跳过。
- 剩余 23 个失败按 owner 归档：Cloud tool runtime 6、FilePanel 6、
  transcript/process display 7、Feishu 1、Plan refresh 1、session 2。它们不在 Phase 5
  被迁移的所有权范围内，需要单独做行为基线修复，不能混入本次结构重构。
- 架构目标以边界而非行数结算：`src/lib` 仅 e2e 入口依赖 Zustand；Game Studio
  canonical domain 完成；submit/orchestrator public orchestration 保留；ChatArea 与
  SettingsModal 没有被包装成参数转发壳。

## 修正版实施顺序

### Phase 3S: 冻结、验收与收尾

Owner: Integration Agent + Runtime Verification Agent

目标是结束 Phase 3，而不是继续延长 Phase 3。

- 冻结 `src/lib/orchestrator/loop` 的模块数量；默认不得新增 phase/recovery/state
  文件。
- 保留当前高层 phase 顺序，不再以 `AgentOrchestrator` 或 `execute` 行数作为目标。
- 删除 `prepareTurn`、`invokeStream`、`evaluateResults` 三个未使用 TODO 占位方法；
  不实现一套新的抽象来满足旧注释。
- 将 Phase 3 测试分成两类：少量架构守卫、运行时行为契约。源码正则测试只保留
  在真正需要保护导入方向或 public facade 的位置。
- 补齐 harness 级场景测试，至少覆盖：
  - `paused`、`stopped_no_action`、`execution_evidence_required` 的状态映射；
  - repeated-read / no-progress 从读取转向写入、验证或明确阻塞；
  - forced context reason 与实际 trim 结果同时可观测；
  - native tools、XML fallback、provider compatibility retry；
  - approved plan 执行证据与 remaining task 审计；
  - abort 和 max-iteration 的最终事件顺序。
- 建立运行时效率基线：首个 mutation 前 tool round 数、重复 read_file 次数、
  no-action stop 比例、实际 dropped message 数、provider retry 次数。

退出条件：

- build、TypeScript、全部 node tests 和 Phase 3 focused Playwright 通过；
- 上述六类行为契约都有非源码正则的测试或日志回放证据；
- `loop` 模块和内部依赖数不再增长；
- Phase 3 标记为完成，即使 `execute` 仍为约 501 AST 行。

### Phase 3C: 可选的依赖收敛

Owner: Architecture Audit Agent

该阶段默认不执行。只有 Phase 3S 发现真实维护阻塞时才进入。

- 只处理单一消费者、没有独立策略、没有独立行为测试价值的 wrapper。
- 若整理顶层 phase 契约，只能按生命周期分组为 immutable services、mutable
  loop state、iteration frame；不得创建可以访问任意依赖的 service locator。
- leaf policy 仍保持显式输入，不能把依赖全部藏进一个巨大 context。
- 只有出现实际复用或测试收益时，才把完整 `OrchestratorCallbacks` 收窄为 message、
  plan、tool、UI event 等 capability ports；不得为了接口数量好看批量改签名。
- 对同一个高层 phase 统一采用明确的 `control + statePatch + effects` 返回模型，或
  明确标记为 side-effect runner，避免返回 state 与闭包 setter 混用。
- 每个变更必须减少至少一项：模块数、内部依赖边、重复字段或调用参数搬运；
  同时不得增加行为变化。
- 不设置目标文件数或目标行数。

退出条件：目标指标实际下降且 Phase 3S 行为契约全部保持通过。否则跳过该阶段。

### Phase 4: Game Studio 领域边界（已完成）

Owner: Game Studio Agent

Game Studio 的产品价值判断不变：MAIN 适合普通和单次游戏开发任务；Game Studio
适合长期项目、阶段门、专家角色、引擎上下文和 workspace-local workflow pack。

当前 `GameStudioRuntimeService` 主要是旧模块之上的 facade，因此 Phase 4 应以
import ownership 和用户工作流为目标，而不是继续增加 wrapper。

- 将 catalog、commands、pack、intent detection、turn envelope、onboarding/help
  的 canonical ownership 收敛到 `src/lib/gameStudio/`。
- 旧路径只保留薄 compatibility shim，并记录删除条件。
- store 通过 Game Studio public API 接入，不直接组合 catalog、pack 和 detection。
- UI 文案明确 MAIN 与 Game Studio 的适用边界、初始化副作用、引擎选择和下一步。
- bundled docs 统一使用 `.MAIN`、`.protocols/game-studio` 和 MAIN 实际 hook/tool
  模型，不暴露上游 `.claude` 路径。
- 保持 slash command、sticky agent、engine auto-config、remove flow 和 workspace
  local initialization 行为。

退出条件：

- store/UI 对旧 Game Studio 模块的新增直接导入为零；
- service/domain 行为有单元测试，而不是只验证源码位置；
- 全部 Game Studio focused Playwright 通过；
- onboarding 能回答“为什么用、会创建什么、下一步做什么”。

### Phase 5: UI 与 E2E 热点（已完成受控切片）

Owner: UI/Test Agent

- 先只拆 `Composer` 中和 Game Studio 直接相关的 onboarding、slash menu 和 mode
  switcher，以 Phase 4 public API 为边界。
- 完成并验证 Composer 后，再独立评估 `ChatArea` 和 `SettingsModal`；不得把三个
  大文件放在同一阶段批量拆分。
- `src/lib/e2e.ts` 按 scenario seed 拆分，但保留一个稳定 bridge API。
- 不设置组件行数目标；以职责、渲染隔离和 focused Playwright 为退出条件。

停止条件已触发：Composer 与首个 e2e registry 已形成稳定边界；ChatArea/SettingsModal
没有足以证明大拆分收益的独立 controller seam，因此不继续按文件大小推进。

### Phase 6: 集成与架构治理

Owner: Integration Agent

- 每个 PR 记录模块数、依赖边、public API、行为测试和 runtime 指标变化。
- 搬迁 PR 与行为修复 PR 分开；发现硬编码时，若有明确行为测试可以同阶段修复，
  否则登记为独立修复，避免隐藏语义变化。
- `src/lib/orchestrator.ts` 仍有 4,739 行，是独立热点，但不自动并入当前 Phase 3。
  只有 change-hotspot 或依赖审计证明其阻碍维护时，才建立单独计划。
- 全量 e2e 只在 Phase 3S、Phase 4 和实际 UI 拆分完成后运行。

## 多 Agent 分工

- Integration Agent：维护基线、停止条件、合并顺序和最终验收，不继续拆 loop。
- Runtime Verification Agent：负责 harness 场景、日志回放和运行时效率基线。
- Architecture Audit Agent：只读维护依赖指标；Phase 3C 获准前不提交结构变更。
- Game Studio Agent：Phase 3S 通过后执行 Phase 4，拥有 Game Studio domain 文件。
- UI/Test Agent：只在 Phase 4 public API 稳定后拆 Composer 和 e2e seed。

并行规则：Runtime Verification 与 Architecture Audit 可以并行；Game Studio Agent
可以准备测试清单，但在 Phase 3S 通过前不改 orchestrator/store callback contract；
UI/Test Agent 最后进入。

## 硬性护栏

- 不再使用“巨大文件”或“目标行数”单独证明重构合理。
- 不为一个调用点创建只转发参数的模块，除非它拥有独立策略或生命周期。
- 不把源码正则测试当作行为等价的唯一证据。
- 不为了减少参数数量引入全局可变 context 或 service locator。
- 不为 `execute` 设置新的 250 行、300 行或其他替代性行数终点。
- 不在同一 PR 混合大规模搬迁、运行时策略修改和 UI 重排。
- 未观察到 runtime 指标改善时，不宣称结构重构提升了 MAIN 执行效率。

## 下一步

Phase 3S、Phase 4、Phase 5 受控切片与 Phase 6 集成验收已完成，Phase 3C 继续保持
可选且默认跳过。当前重构计划在这里收口；剩余 23 个 Playwright 基线失败应作为
独立行为修复任务处理。后续只有具体维护阻塞或独立状态 owner 出现时，才重新开启
`ChatArea`、`SettingsModal` 或更多 e2e registry 迁移。
