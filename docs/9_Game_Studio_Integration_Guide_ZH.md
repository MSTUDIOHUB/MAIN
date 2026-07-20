# Game Studio 深度融合说明

## 目标

`游戏工作室 / Game Studio` 是 MAIN 的第 5 个 `MAIN 场景`。它不是把外部仓库原样塞进工作区，而是把上游能力重新映射到 MAIN 自己的中枢、规则、模板、hooks 和协议包体系里。

## 上游来源

- 来源仓库：[Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios)
- 参考版本：`v1.0.0-beta`
- 许可：`MIT`
- 当前 MAIN 打包版本：`ccgs-v1.0.0-beta-main-nexus-v1`

## 为什么不是直接照搬

MAIN 采用的是“深度缝合，而不是机械复刻”策略：

- 保留上游高价值能力
- 交互压平为一个更容易理解的 Studio 中枢
- 使用 MAIN 自己的工作区协议层和 slash 路由层驱动
- 不伪造 Claude Code 专属事件或实验性多会话团队编排

这样做的原因很简单：用户需要的是“更清楚、更稳定、更容易开始”，而不是把另一套复杂系统原封不动搬进来。

## 用户怎么用

### 1. 切到 `游戏工作室`

只有在 `nexus_game_studio` 下，输入框才会启用完整的 Studio slash 命令能力。

### 2. 输入 `/` 或点击命令按钮

输入框左侧会出现可见的 Studio 命令入口。点击它，或直接输入 `/`，会打开同一套命令面板。

命令面板分两层：

- `工作流命令`
- `专业 Agent`

### 3. 工作流命令

常见入口包括：

- `/start`
- `/brainstorm`
- `/setup-engine`
- `/design-system`
- `/create-epics`
- `/create-stories`
- `/dev-story`
- `/story-done`

面板默认高亮常用入口，但仍保留完整搜索能力。

### 4. 专业 Agent

49 个 Agent 统一走：

```text
/agent <slug>
```

例如：

```text
/agent creative-director
/agent unity-specialist
/agent qa-lead
```

选择之后，输入区会出现当前专家 chip。后续普通消息会默认继续路由给该专家。

如果要回到自动编排：

```text
/auto
```

## Game Studio 的初始化

Studio 包不会在用户只是“切换到模式”时就污染工作区。

初始化属于显式动作，典型入口有：

- 点击 `初始化 Game Studio`
- 在输入框中补全并发送 `/start`
- 进入需要 Studio 协议包的工作流命令或专家驱动流程

初始化完成后，MAIN 会把打包好的版本化工作室资产写入当前工作区。

`MAIN GAME STUDIO` onboarding 卡片只负责两类事情：

- 初始化工作区
- 把 `/start`、`/brainstorm`、`/setup-engine` 写成草稿，等待用户继续补充内容后手动发送

它不会自动代发 slash 命令，因此不会因为缺少上下文而立刻触发错误或大体量背景压缩。

当用户从其他 `MAIN 场景` 切回 `游戏工作室` 时，onboarding 会再次弹出，方便用户重新找到初始化、引擎设置和工作流入口。用户也可以手动关闭它。

## 写入到工作区的内容

### 1. `.protocols/game-studio/*`

这是 Studio 协议包层，包含：

- `SKILL.md`
- 命令协议文档
- 49 个 Agent profile
- 上游整理后的 docs
- 来源与许可信息

### 2. `.MAIN/templates/game-studio/*`

这是 MAIN 模板层，包含可直接复用的模板，例如：

- GDD
- ADR
- Sprint
- HUD / UX
- 内容与美术规范模板

这些模板会保留在工作区里，但不会在每一轮 system prompt 中自动内联。Game Studio 工作流需要时，主 Agent 会按协议和命令文档按需读取对应模板。

### 3. `.MAIN/rules/game-studio/*`

这是 MAIN scoped rules 层，用于把 Studio 场景约束映射到当前工作区规则系统。

### 4. `.MAIN/hooks.json`

这里会用“非破坏式 merge”方式并入 MAIN 兼容 hooks，不覆盖用户已有 hooks。

### 5. `.MAIN/game-studio/studio.config.json`

用于持久化 Studio 工作状态：

- `packVersion`
- `engine`
- `engineLanguage`
- `reviewMode`
- `activeStudioAgent`

这些隐藏目录和文件都属于“当前工作区本地的 Studio 支持层”。如果你切换到另一个文件夹，那个工作区不会自动继承这里的 Game Studio 资产，而是需要单独初始化。

如果用户希望撤回这些 Studio 隐藏资产，`MAIN GAME STUDIO` onboarding 面板会提供移除按钮，用于删除当前工作区里的：

- `.protocols/game-studio/*`
- `.MAIN/templates/game-studio/*`
- `.MAIN/rules/game-studio/*`
- `.MAIN/game-studio/*`
- `.MAIN/hooks.json` 里由 Game Studio 合并进去的 hooks 条目

## slash 路由是如何工作的

MAIN v1 没有依赖缺失的 `execute_skill` 后端能力，而是采用了下面这条链路：

1. 输入并发送 slash 命令；工作区会话先把它接纳为一个 Turn
2. 前端做确定性解析
3. 标准化为 canonical command
4. 写入 `pendingSlashCommand`
5. 生成隐式 command envelope
6. 主 Agent 按需读取：
   - `.protocols/game-studio/SKILL.md`
   - 对应命令文件
   - 当前专家文件
   - `.MAIN/rules` / `.MAIN/templates` / `.MAIN/hooks.json`

所以，Game Studio 的执行入口仍然是 MAIN 自己的主 Agent 与编排器，只是被 Studio 协议包增强了。

本地快速命令也必须生成可见结论；成功、错误和取消均写入唯一 `assistant_final`，局部 slash command 失败不会产生应用级 failed 终态。bridge 只在开始时捕获的 Turn、receipt 和 user-block 身份仍精确匹配时原位修复；若异步执行期间 adoption 已漂移，它保留原 Turn 并新建隔离的 presentation-recovery Turn/Run 展示结论，不会重跑命令。final、runtime outcome、`run.completed` 与 `turn.completed` 作为同一投影进入有界持久化屏障；保存不可用时明确降级为 temporary 内存结论。冷恢复不会自动重放 unresolved local-fast，而会形成可见隔离结论，用户可用新 Turn 重试。完整状态语义见 [运行时生命周期](RUNTIME_LIFECYCLE.md)。

## `/agent` 的粘性逻辑

`/agent creative-director` 不是切换全局人格，而是设置当前会话里的 Studio 专家偏好：

- 普通消息默认继续走这个专家
- 当前专家会显示为输入区 chip
- `/auto` 可以清除

这意味着 49 个 Agent 只属于 `游戏工作室` 的二级专家层，不会污染其他 4 个 MAIN 场景。

## 能力映射矩阵

### v1 完整支持

- 上游 Agent profile
- 上游 skill 内容映射为命令协议文档
- 规则文件映射到 `.MAIN/rules`
- 模板映射到 `.MAIN/templates`
- MAIN-compatible hooks 适配
- slash 命令搜索、插入、专家切换

### v1 兼容降级

- Claude Code 专属 hook 事件不会被伪造
- commit / push / assets 等专属生命周期事件改写为 MAIN 工作流检查或文档限制
- 多会话实验性团队编排不做一比一复刻

## 当前集成规模

当前内置 Studio 包已经映射了：

- 49 个 agents
- 72 个 commands
- 11 个 rules
- 35 个 MAIN-mapped templates

这些资产来自上游公开仓库，并经过 MAIN 的协议层整理与路径改写。

## 推荐理解方式

最简单的心智模型可以只记住一句话：

`Game Studio = MAIN 的游戏开发中枢 + slash 工作流 + 49 个可切换专家`

如果用户不想记命令，也没关系：

- 可以点击输入框旁的 Studio 按钮
- 可以在空工作区用 onboarding 卡片启动
- 可以用搜索面板浏览完整目录

默认入口永远保持简单，深度能力按需展开。
