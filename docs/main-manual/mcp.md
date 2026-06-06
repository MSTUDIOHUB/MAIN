---
title: "MCP 服务器"
sidebarTitle: "MCP"
description: "通过 MCP 连接 Unity 等外部工具和引擎。"
category: "platforms-integrations"
order: 30
status: "draft"
sourceFeature: "Settings MCP、mcpClient、DEFAULT_MCP_SERVERS、executeMcpTool"
---

# MCP 服务器

MCP 让 MAIN 可以发现并调用外部工具，例如 Unity 编辑器、浏览器、Git 服务或你自己的工具服务器。

<!-- screenshot: docs/main-manual/assets/mcp-settings.png -->

## 适用场景

- 让 MAIN 操控 Unity 或其他外部引擎。
- 把团队内部工具暴露给 MAIN。
- 扩展内置工具无法覆盖的能力。

## 前置条件

- MCP 服务器已经启动。
- 服务器支持 HTTP 传输。
- MAIN 可以访问服务器 URL。

## 默认配置

MAIN 默认包含一个 Unity MCP 配置入口：

```text
http://localhost:8080/mcp
```

这个默认项不会保证 Unity MCP 已经运行；它只是方便你启动服务后快速扫描工具。

## 步骤

1. 打开 `Settings > MCP Servers`。
2. 确认服务器名称、URL 和启用状态。
3. 点击测试连接，查看诊断信息。
4. 点击扫描工具。
5. 确认发现的工具列表。
6. 回到聊天中描述需要外部工具参与的任务。

## 结果确认

- 测试连接返回成功或明确诊断。
- 扫描工具后显示工具数量和来源服务器。
- MAIN 在任务中可以自动调用已发现的 MCP 工具。
- MCP 调用失败时，对话区会提示打开 MCP 设置。

## 常见问题

**连接成功但没有工具怎么办？**  
确认 MCP 服务器已经暴露 `tools/list`，并且外部引擎当前会话已连接。

**路由不匹配怎么办？**  
检查 URL 是否应该包含 `/mcp`，以及服务器要求的请求头是否兼容。

**MCP 工具安全吗？**  
MCP 工具能力取决于服务器实现。只连接可信服务器，并对高风险操作保留人工审批。

## 下一步

- 阅读 [Game Studio](game-studio.md)，了解 Unity 和游戏工作流场景。
- 阅读 [工具参考](tools-reference.md)，区分内置工具和 MCP 工具。
- 阅读 [故障排查](troubleshooting.md)，处理 MCP 错误。
