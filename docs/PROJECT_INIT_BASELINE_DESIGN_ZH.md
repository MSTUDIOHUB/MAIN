# `/规则`、计划访谈与项目基线

更新时间：2026-11-06

## 用户入口

Composer 的 `/` 菜单只展示 `/计划` 与 `/规则`。`/rules` 与旧 `/init` 是 `/规则` 的兼容别名，可跟自然语言要求；旧 `--refresh` 仍可解析，但不再触发本地确定性事实快照流程。

`/规则` 会创建正常的用户 Turn 与 Plan Run：先调查当前项目及根目录 `AGENTS.md`，再通过 ExecutionCapsule 询问会影响规则的关键约束，随后由模型起草规则文档。访谈结束保存草稿，并打开可编辑正文及 diff 的审阅窗口。只有确认保存才通过固定目标的 CAS IPC 写入根目录 `AGENTS.md`。

普通 `/计划` 同样至少经过一次任务相关的结构化确认，可以多轮追问。用户可确认本轮交付为计划文档，或在项目会话中形成另行审批的实施计划。概念方案无需编造文件目标、命令或验收步骤；可执行 WorkPlan 仍须满足原有源码、依赖、验收及独立执行审批边界。访谈确认不是执行许可。

## 问题、答案与恢复

`UserQuestionnaire` 定义稳定的问题和选项 ID，支持单选、多选、自由文本及选择数量约束。UI 提交 `UserChoiceAnswer`，包含完整 request ID、问题 revision 和逐题答案，不把多选拼成一个单值。运行时在同一 owner、Session epoch、Turn、Run、request 和问题定义上校验答案，拒绝缺题、重复题、外来选项、过期 revision 与重复提交。

问题通过 canonical `run.paused` 保存；验证后的答案通过 `run.decision_recorded` 持久化，成功保存后才恢复原 Run。重启不会新建一个访谈 Run，也不会将确认转换成 WorkPlan 批准。admission 后尚未开始 Run、已提问未回答、已回答尚未恢复等边界都从同一 ledger 恢复。

前轮可见对话从当前 Session 的已有 durable conversation 投影进入同一模型 messages；当前 Run 的工具回执、问题与答案从 ledger 恢复。所有内容继续使用现有 provider 上下文预算，没有另一份 modelContext 状态。safe reads 在调查及追问期间保持可用；必要子任务须真实 join。

## 计划文档

概念方案、规则草稿与可执行 WorkPlan 的 Markdown 均通过 `savePlanDocument` 保存，不使用通用 `write_file` 代写运行时文档。每份文档有不可变 owner（workspace、Session key/epoch、原始 Turn）、document ID、revision、精确 UTF-8 内容 SHA-256 及路径。

项目文档保存于 `.MAIN/plans/<documentId>/rev-N.md`；无项目会话使用应用数据目录中的会话计划根。不同计划有不同 ID，不覆盖同一个 `plan.md`。`PlanDocumentRef` 可读取指定版本，Rust 验证 owner、hash、元数据、CAS 和符号链接边界，丢失确认后的同内容重试幂等。

计划文档会附上从 canonical 问题与答案生成的完整“用户选择”记录，包括题目、单选／多选／自由文本答案和 request/revision 追溯信息。严格 WorkPlan 的 runtime-owned `decisionJournal` 同时参与 digest、Markdown 和 projection hash；旧计划无该字段时保持原字节与哈希。规则草稿不附访谈记录，以免将记录本身混入 AGENTS.md。

新的严格 WorkPlan review commit 与审批请求绑定同一 documentRef、正文和 projection hash；没有真实保存回执不能封存新文档计划，缺失或漂移的 ref 不能批准。旧无 documentRef 的已持久化 WorkPlan 仅保留原有 `.MAIN/plans/plan.md` 精确审批契约，不能把 Markdown 重新提升为执行权威。

## 规则草稿的写入边界

在开始规则调查时，运行时捕获根目录 `AGENTS.md` 的 canonical workspace、固定目标、原文和 base content version，并写入同一 ledger。多轮访谈和冷恢复复用该版本；若中断发生在捕获之前，恢复先补齐检查再继续。

模型保存的 `rules_draft` 只是草稿。审阅 UI 可编辑全文并同步 diff，允许清空后继续输入，空稿不能保存。编辑始终保留原 inspection 和 base version。确认时由现有专用 IPC 再核对 workspace、target 与 base version；并发修改、目标变化或工作区切换返回 stale，要求重新调查或审阅，不会静默覆盖。

现有 `AGENTS.md` 的人工内容是调查依据，模型须保留尚未被用户改变的规则。新流程不按旧 managed marker 猜测可替换片段，也不新增嵌套 AGENTS 的发现或加载策略；本次写入目标始终是根文件。

## 指令、知识与事实仍分层

每个 Workspace Turn 继续读取 live workspace instructions 和确定性项目 baseline。已接纳 Run 的 `workspaceInstructionContext`（包括显式空字符串）封存在 admission 事实中，多轮 Plan、父执行与 child 使用同一快照；后续新 Turn 才读取新规则。

baseline 包含 canonical workspace、manifest/lockfile/config 的路径与 hash、声明脚本及有界浅层拓扑；不包含模型推断、源码全文或验证成功结论。它为调查提供事实，不是规则、权限或源码修改租约。

个人知识库只来自当前消息显式选用的版本化引用，独立保存在 `knowledgeContext`。Plan 可用知识检索工具扩读原 scope；空、过期或错误 scope 不回退到整个知识库。引用与完整有界 JSON 一起保留，知识结果只记为参考工具观察，不成为工作区源码租约、执行审批或验收证据。

## 核心回归

- `plan-interview-production.test.mjs`：真实 Plan producer、结构化回答、同 Run 多轮与 JSON 冷恢复、无项目文档、规则原版本捕获、独立 WorkPlan 审批、admit-only 中断恢复、前文与冻结规则。
- `user-questions.test.mjs` / `runtime-v2-user-questionnaire.test.mjs`：稳定 ID、基数、自由文本、过期和非法答案、canonical replay。
- `runtime-v2-plan-production.test.mjs`：严格 WorkPlan 工具与源码证据、子任务、协议恢复、完整终态及知识 scope；历史核心场景显式使用原 pre-interview checkpoint，不关闭新 admission 门禁。
- `project-init.test.mjs`：兼容命令、可编辑草稿、空稿、原始 CAS、并发 stale；保留旧 managed-block 纯 helper 的兼容覆盖，生产入口已不使用该 helper。
- Rust `plan_documents` 及原 `project_init` 测试：版本、owner、lost-ack 幂等、CAS、hash、路径、符号链接与目标复核。
