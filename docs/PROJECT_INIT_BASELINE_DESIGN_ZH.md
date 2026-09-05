# `/init` 与项目基线：设计与落地状态

更新时间：2026-09-04
状态：已接线

## 当前决策

`/init` 已实现，但“人维护的项目规则”和“机器可重建的项目事实”仍是两个不同层级：

1. `/init` 是 Composer 在模型提交前截获的本地工作区命令。它生成根目录 `AGENTS.md` 的确定性托管区块和可审阅 diff；只有用户确认后才写入。
2. 每个 Workspace Turn admission 会用同一组 read-through 读取同时解析 live instructions 与 typed `projectBaselineContext`。baseline 在本 Run 内冻结并传给 Plan、Execute、Goal 和 child，不进入 Session 持久化，也不授予指令、写入或验收权威。

这避免了每次新会话先做全仓扫描，也不会把一次模型总结提升为永久事实。

## `AGENTS.md` 托管区块

托管区块只包含确定性项目事实：

- 检测到的语言、runtime 与包管理器；
- manifest 中声明的脚本调用名；这些命令只是“已声明”，不代表已经执行或验证通过；
- 有界、稳定排序的关键目录与 baseline anchors；
- 专用于初始化快照的 fingerprint。

人工规则必须写在 marker 外。MAIN 只替换唯一、完整的托管区块，并原样保留区块前后的人工内容。重复、残缺、逆序或版本不明的 marker 会 fail closed，不猜测可覆盖范围。

普通 `/init` 在已有合法托管区块时只报告“已经初始化”。`/init --refresh` 会重新扫描并打开重建预览，但仍需用户确认；它不会直接写文件。初始化扫描排除目标 `AGENTS.md` 自身，防止 fingerprint 自引用导致每次 refresh 都产生新 diff。

## Deterministic baseline

baseline 包含：

- schema/parser version、canonical workspace 与可选 VCS root identity；
- manifest、lockfile、项目规则和顶层关键配置的路径、hash、大小与 provenance；
- manifest 中可解析的语言、runtime、package manager 和 scripts；
- 有界、稳定排序的浅层目录拓扑；
- omissions、diagnostics、截断状态与分层 fingerprints。

它不包含源码全文、全仓索引、模型推断的架构、会话摘要、失败历史、当前 diff、validation receipt、secret/env 值、构建产物或任何写入授权。渲染进模型上下文时会再次声明“不是指令、权限、mutation 或 validation evidence”。

## 生命周期与失效

- baseline 每个 Workspace Turn 重新构建，不依赖 mtime，也不作为 Session 真值持久化。
- 同一次 admission 的 instructions 与 baseline 共享读取；规则 source 的原始 hash 不一致时保留 instructions，只丢弃 baseline。
- 编辑普通源码正文不会自动重写 `AGENTS.md`；新增、删除或移动浅层路径及 anchor 变化会反映在下一 Turn 的内存 baseline。
- 项目文件 mutation 后仍以版本化源码读取、mutation receipt 和 validation receipt 为准；baseline 不能替代任务证据。
- 需要更新人类可读托管区块时，用户显式运行 `/init --refresh` 并审阅确认，避免额外 dirty diff、循环写入和并发覆盖。

## 命令与写入边界

- 只严格接受 `/init` 与 `/init --refresh`，不会误匹配 `/initial` 或带额外参数的文本。
- 必须存在当前有效工作区；目标固定为该工作区根目录 `AGENTS.md`。
- 打开预览、取消或按 Escape 都不创建 user message、Turn、Run，不调用 provider，也不写文件。
- 确认写入绑定 canonical workspace、固定 target 与审阅时的 base content version；工作区切换、目标变化或并发编辑都会返回 stale，要求重新生成预览。
- Rust 边界拒绝符号链接、非普通文件、非 UTF-8 和超限内容，并在替换前再次复核目标。
- 写入使用专用、固定目标的 CAS IPC，不向模型或 `/init` 流程开放通用文件写权限。
- 无变化时 no-op；成功写入后刷新 instructions，下一 Turn 重新建立 typed baseline。

## 已验证入口

- Composer `/` 菜单的“工作区命令”末项，以及直接输入 `/init` / `/init --refresh`。
- Game Studio 风格的审阅 Panel，覆盖 light、dark、black 三种主题。
- Node 核心/adapter/admission/runtime 测试、Rust CAS/路径测试及 Playwright 零 Turn、取消、确认、stale、工作区切换与主题测试。
