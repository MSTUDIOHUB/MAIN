# MAIN 场景兼容与迁移说明

## 当前场景模型

MAIN 已将旧的 Persona、Nexus 场景和 Game Studio 模式收敛为两个用户可选入口：

- `main_mode`：问答、研究、代码、文档、游戏开发和 MCP 工具调用的统一入口。
- `image_studio`：图片生成的独立入口。

游戏开发不再需要专用场景。Unity、Godot、Unreal 或其他引擎任务直接进入 MAIN 的同一套
Turn、Plan、Execute、权限和验证流程；引擎能力由当前已连接的 MCP Server 提供。

## 为什么归并旧 Nexus 场景

旧的 `nexus_general`、`nexus_create`、`nexus_build`、`nexus_research` 和 Persona key
主要表达工作风格，而不是不同的执行能力。继续把它们作为顶层模式会让用户在描述目标前
先猜测分类，也会让相同任务走出多套 admission 与运行路径。

现行 MAIN 改为在每个 Turn 内根据目标选择 respond、analyze、plan、execute、report 或
goal 等策略。模型能力会影响结果质量，但所有模型面对相同的工具权限、执行循环和完成
契约。

## 旧值读取迁移

读取旧设置或 Session snapshot 时使用以下规则：

| 旧值 | 当前值 |
| --- | --- |
| `game_studio`、`nexus_game_studio` | `main_mode` |
| `nexus_general`、`nexus_create`、`nexus_build`、`nexus_research` | `main_mode` |
| `role_architect`、`role_debugger`、`role_uidesigner`、`role_dataanalyst` | `main_mode` |
| 其他未知旧值 | `main_mode` |
| `image_studio` | `image_studio` |

这些 key 只在读取边界用于兼容。新状态不再写入 Nexus 或 Game Studio 模式值，也不再
生成 `selectedNexusModeKey` 兼容投影。

## 场景与工作方式

- `MAIN 场景` 决定使用通用 agent 工作流还是图片生成入口。
- Chat、Plan、Fast 等工作方式决定一个 MAIN Turn 的执行节奏。
- Skill、MCP 和内置工具是能力来源，不是额外顶层场景。

例如：

- 游戏功能实现：`MAIN + Execute`，按需调用引擎 MCP。
- 大型重构：`MAIN + Plan`，审阅方案后继续实施。
- 资料比较：`MAIN + Analyze`。
- 图片生成：切换到 `image_studio`。

## 工作区遗留资产

旧版本可能曾向项目写入已停用模式的隐藏资产。升级不会静默删除用户工作区文件；如需
清理，应先备份项目并核对精确路径和 hooks 条目。遗留文件本身不会重新启用已删除模式。
