---
title: "MAIN 场景"
sidebarTitle: "MAIN 场景"
description: "理解 MAIN 通用工作流与图像工作室的边界。"
category: "core-concepts"
order: 10
status: "draft"
sourceFeature: "MAIN_MODE_KEYS、selectedMainModeKey、Image Studio"
---

# MAIN 场景

底部 `MAIN` 菜单用于选择当前工作场景。现行版本保留两个入口：通用 `MAIN` 与
`图像工作室`。问答、研究、代码修改、文档整理、游戏开发和 MCP 工具调用都由同一套
MAIN agent loop 处理；只有图片生成进入独立的图像工作室。

## 适用场景

- 普通问答、总结、研究、代码和文档任务使用 `MAIN`。
- Unity、Godot、Unreal 等游戏项目仍使用 `MAIN`，并按需调用已配置的 MCP 工具。
- 图片生成任务使用 `图像工作室`。

## 前置条件

- 已打开 MAIN。
- 已创建全局聊天或工作区会话。
- 需要外部工具时，已在设置中连接并扫描对应 MCP Server。

## 场景说明

- `MAIN`：通用协作、研究分析、工程实现、游戏开发、MCP 调用和文档整理。
- `图像工作室`：图片生成、本地图片服务和 HiDream Web fallback。

## 步骤

1. 普通任务直接留在 `MAIN`，用自然语言说明目标。
2. 需要明确执行节奏时，使用 Chat、Plan 或 Fast 等工作方式。
3. 需要引擎或外部系统能力时，确认 MCP 已连接，再要求 MAIN 使用对应工具。
4. 只有目标是生成图片时才切换到 `图像工作室`。

## 结果确认

- 当前场景在菜单中高亮。
- MAIN 中的工具调用继续受工作区范围、权限和审批策略约束。
- 图像工作室进入图片生成流程，不与普通 agent Turn 混用。

## 兼容迁移

旧版本保存的 `game_studio` 或 `nexus_game_studio` 会在读取时迁移为 `main_mode`。
迁移不会重新启用旧模式，也不会向新状态写回 Studio key。旧的 Nexus/persona key 同样
归并到 MAIN；`image_studio` 保持不变。

## 常见问题

**MAIN 场景和 Chat / Plan / Fast 是一回事吗？**  
不是。场景说明能力入口；Chat / Plan / Fast 说明本轮采用什么执行节奏。

**游戏开发还需要切换专用模式吗？**
不需要。直接在 MAIN 中描述游戏任务；已配置的 Unity、Godot 或 Unreal MCP 工具仍可由
同一套 Plan / Execute 流程调用。

**不确定选哪个怎么办？**  
先留在 MAIN 描述目标。只有明确需要图片生成时再切换到图像工作室。

## 下一步

- 阅读 [Chat / Plan / Fast](run-modes.md)，选择执行方式。
- 阅读 [MCP 服务器](mcp.md)，连接 Unity 等外部工具。
- 阅读 [图像工作室](image-studio.md)，了解图片生成入口。
