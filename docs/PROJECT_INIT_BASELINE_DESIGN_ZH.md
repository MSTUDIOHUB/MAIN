# `/init` 与项目基线设计评估

更新时间：2026-09-02

## 决策

增加 `/init` 是合理的，但必须把“人维护的项目规则”和“机器生成的项目基线”分开。不要让模型在每次源码修改后自动重写一份 Markdown 总结，也不要把易过期的架构推断当成权威指令注入每个 Turn。

推荐两层设计：

1. `/init` 在用户显式触发时创建或提议一份精简的 `AGENTS.md`。它只记录稳定约束、已核实的 build/test/lint 命令、重要目录约定和用户希望长期遵守的规则。
2. MAIN 在独立的 typed、deterministic `projectBaselineContext` 中维护可重建的项目事实缓存。它不属于 `workspaceInstructionContext`，不自动写入人类 Markdown，也不具备指令权威。

## 为什么不能自动更新 `AGENTS.md`

- `AGENTS.md` 是用户维护的规则，不是缓存；MAIN 会在每个 Turn 将它作为指令加载。
- 模型生成的项目概览可能过期或错误，把它放进指令层会将推断升级为权威约束。
- 每次源码 mutation 后再改 Markdown 会制造额外 dirty diff、并发竞争、循环触发和审阅噪音。
- 对上下文较小的本地模型，长篇项目百科会在每个 Turn 重复占用宝贵 token。

已有 `AGENTS.md` 时，`/init` 只能展示可审阅 diff 或建议，不能静默覆盖。任何带架构推断的人类可读 overview 只允许在 `/init --refresh` 或用户批准后更新。

## Deterministic baseline 应包含

- schema/parser version、canonical workspace/VCS root identity；
- manifest、lockfile、项目规则和顶层关键配置的路径、hash、大小与 provenance；
- manifest 中真实声明的语言、runtime、package manager、scripts；
- 有界、稳定排序的关键目录浅层拓扑；
- instruction source 的身份与 hash。

不应包含源码全文、全仓索引、模型推断的架构、会话摘要、失败历史、当前 diff、validation receipt、secret/env 值、构建产物或任何写入授权。

## 失效与更新

- fingerprint 只覆盖 anchor：manifest、lockfile、规则、顶层关键配置和有界目录拓扑。
- 普通源码变化不重写 `AGENTS.md`，也不重建全局 baseline；当前任务仍必须读取目标文件的最新版本并依赖 mutation receipt。
- anchor 变化只把机器 baseline 标记 stale，在下一个 Turn admission 或安全边界确定性重建。
- 重建必须幂等；文件枚举顺序和 mtime 变化不能改变结果。
- parent、Plan、Execute、Goal 和 child 应共享同一冻结 baseline snapshot，但它必须与 user-maintained instructions 保持独立字段。

## `/init` 命令边界

`/init` 应是确定性的本地 workspace command，而不是模型 intent：

- 必须存在有效工作区；
- 菜单选择只打开审阅流程，不直接发送或写文件；
- 新建 `AGENTS.md` 或更新建议都要展示 diff，并绑定 canonical workspace identity、目标 realpath 与审阅时的 base hash/version；
- 批准写入前必须重新读取目标并复核 base hash；文件被并发修改、替换或审阅已过期时应 fail stale 并重新生成 diff，不能覆盖新内容；
- 目标必须经过现有工作区路径、symlink/realpath 与写权限审批边界，拒绝越界路径、链接逃逸和任何绕过普通 mutation preflight 的写入；
- 连续运行无变化必须 no-op；
- 严格解析 `/init` 与可选的 `--refresh`，不能误匹配 `/initial`；
- 用户取消后不得留下文件或 Runtime 状态。

## 建议实施顺序

1. 先定义 baseline schema、anchor fingerprint、大小/时间上限和 secret/ignore 规则。
2. 在 Turn admission 增加独立 `projectBaselineContext`，并贯穿 Plan、Execute、Goal、child。
3. 增加可审阅、幂等的 `/init` workspace command。
4. 最后在 MAIN 引导面板中展示 `/init`；在功能真正上线前不要预告为可用命令。
