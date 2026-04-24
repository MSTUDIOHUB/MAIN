# MAIN 场景体系说明

## 为什么从 Persona 升级为 MAIN 场景

旧的 `Persona / 角色` 心智更像“职业身份切换”，容易让用户误以为必须先决定自己要找的是架构师、设计师或调试专家。

对 MAIN 来说，这并不适合真实使用场景：

- 用户可能只是打开了一个空文件夹，想先聊思路。
- 用户可能只是来问问题、做头脑风暴、写文档或整理方向。
- 用户也可能准备直接实现代码，或者做系统化研究分析。

因此，MAIN 现在把原有的角色入口升级为 `MAIN 场景`。它代表的是“我现在想达成什么目标”，而不是“我现在要扮演哪种职业”。

## 5 个 MAIN 场景

### 1. 通用协作 `nexus_general`

适合最宽泛的场景：

- 空目录起步
- 提问答疑
- 轻量 brainstorm
- 文档整理
- 方向探索

这是默认入口。新会话不再默认把用户推进“架构师”视角。

### 2. 创意共创 `nexus_create`

适合：

- 概念发想
- 内容构思
- 交互方向
- 产品叙事
- 视觉和体验方向探索

重点是把灵感收束成可继续推进的结构化产物。

### 3. 工程实现 `nexus_build`

适合：

- 功能开发
- 调试修复
- 重构
- 代码落地
- 架构分析

它吸收了原先“架构师 + 调试专家”的高价值行为，但不再用职业角色名来限制用户心智。

### 4. 研究分析 `nexus_research`

适合：

- 文档研读
- 表格分析
- 数据总结
- 对比研究
- 风险与结论提炼

它继承了原数据分析 Persona 的优势，并保留数据/文档只读分析优先、失败自动降级等行为规则。

### 5. 游戏工作室 `nexus_game_studio`

适合：

- 游戏概念启动
- GDD / UX / 系统设计
- 引擎配置
- 跨职能游戏团队协作
- 使用 Studio slash 命令与 49 个专业 Agent

这是 MAIN 对 [Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) 的深度整合入口，但交互被压平成更易理解的单一 Studio 中枢。

## MAIN 场景 与 工作方式 的区别

MAIN 现在明确区分两层概念：

- `MAIN 场景`：你想做什么
- `工作方式 / Run Mode`：AI 怎么执行

工作方式仍保留原有三种执行行为：

- `Chat`
- `Plan`
- `Fast`

但这三项不再与 `MAIN 场景` 争夺“模式”心智。

一个典型组合例子：

- `研究分析 + Chat`：读资料、看表格、输出结论
- `工程实现 + Fast`：直接修改和实现
- `创意共创 + Plan`：先出方案再审阅
- `游戏工作室 + Chat / Fast / Plan`：根据当前 Studio 任务选择执行节奏

## 空目录/新工作区的默认体验

在空目录或近空目录里：

- 默认建议从 `通用协作` 开始
- 如果目标是做游戏项目，切到 `游戏工作室`
- `游戏工作室` 会显示 `MAIN GAME STUDIO` onboarding 卡片，帮助用户初始化 Studio 包，或把 `/start`、`/brainstorm`、`/setup-engine` 先写成草稿再继续补充上下文

这比旧 Persona 更符合“先开始做事，再逐步收敛”的真实心智。

## 兼容与迁移

旧值会自动迁移：

- `role_architect`、`role_debugger` -> `nexus_build`
- `role_uidesigner` -> `nexus_create`
- `role_dataanalyst` -> `nexus_research`
- 未知值 -> `nexus_general`

这保证了旧状态不会导致会话崩溃，同时把默认入口平滑迁移到新的 MAIN 场景体系。

## 命名与兼容

- 用户可见文案统一使用 `MAIN 场景`
- `游戏工作室` 的 onboarding 面板固定显示为 `MAIN GAME STUDIO`
- 内部兼容 key 仍保留 `NexusModeKey`、`selectedNexusModeKey` 与 `nexus_*`，避免破坏旧状态与迁移逻辑
