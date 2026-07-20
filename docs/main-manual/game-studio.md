---
title: "Game Studio"
sidebarTitle: "Game Studio"
description: "使用游戏工作室、slash 命令、专业 Agent 和模板。"
category: "platforms-integrations"
order: 60
status: "draft"
sourceFeature: "Game Studio、slash commands、49 agents、protocol package"
---

# Game Studio

Game Studio 是 MAIN 面向游戏开发的工作中枢，整合 slash 工作流、专业 Agent、模板、规则和引擎相关协议。

## 适用场景

- 启动一个新游戏概念。
- 编写 GDD、UX、系统设计或 sprint 计划。
- 组织设计、程序、美术、QA、发布等跨职能工作。
- 连接 Unity MCP 或其他引擎工具。

## 前置条件

- 已打开目标游戏项目工作区。
- 已切到 `游戏工作室` 场景。
- 如需引擎操作，先启动对应 MCP 服务。

## 初始化

切换到游戏工作室不会立即写入工作区。初始化是显式动作，常见入口包括点击 `初始化 Game Studio`、发送 `/start`，或进入需要 Studio 协议包的工作流。

初始化后，MAIN 会把 Studio 支持资产写入当前工作区，例如协议包、模板、规则、hooks 配置和 Studio 状态文件。这些资产只属于当前工作区。

## Slash 命令

输入 `/` 或点击命令按钮可以打开命令面板。常见命令包括：

```text
/start
/brainstorm
/setup-engine
/design-system
/create-epics
/create-stories
/dev-story
/story-done
```

专业 Agent 通过下面格式选择：

```text
/agent creative-director
/agent unity-specialist
/agent qa-lead
```

使用 `/auto` 可以回到自动编排。

## 步骤

1. 打开游戏项目工作区。
2. 切换到 `游戏工作室` 场景。
3. 根据 onboarding 初始化 Game Studio，或先发送 `/start`。
4. 输入 `/` 打开命令面板。
5. 选择工作流命令，或通过 `/agent <slug>` 指定专业 Agent。
6. 补充项目背景、引擎、目标平台和验收标准。
7. 审阅 MAIN 输出的计划、模板内容或实现步骤。

## 结果确认

- 游戏工作室 onboarding 显示初始化和命令入口。
- 输入框支持 Studio slash 命令搜索。
- 当前专家会以 chip 显示在输入区。
- 初始化后，工作区出现 Studio 协议、模板和规则资产。
- 本地快速 slash 的成功、错误或取消都会显示一条最终结论。如果执行期间原 Turn 身份已改变，MAIN 会用隔离的恢复 Turn 显示该结论，不会改写原 Turn 或重跑命令。若应用在结论落盘前中断，冷恢复会按 at-most-once 原则显示隔离错误，而不会自动重复可能已经发生的本地副作用；请用一条新指令明确重试。

## 常见问题

**Game Studio 是独立应用吗？**  
不是。它仍由 MAIN 主 Agent 和编排器执行，只是加载了游戏开发协议包和专家路由。

**49 个 Agent 会影响其他场景吗？**  
不会。专业 Agent 属于游戏工作室二级专家层，不会污染通用协作、工程实现或研究分析。

**可以移除初始化资产吗？**  
可以。Game Studio onboarding 提供移除入口，用于清理当前工作区中的 Studio 隐藏资产。

## 下一步

- 阅读 [MCP 服务器](mcp.md)，连接 Unity 等外部工具。
- 阅读 [计划模式](plan-mode.md)，为复杂游戏任务先做计划。
- 阅读 [技能与协议包](skills-and-protocols.md)，理解 Game Studio 资产结构。
