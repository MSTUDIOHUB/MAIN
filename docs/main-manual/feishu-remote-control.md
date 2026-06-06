---
title: "飞书远程控制"
sidebarTitle: "飞书远程控制"
description: "通过飞书机器人发送任务并远程审批。"
category: "platforms-integrations"
order: 50
status: "draft"
sourceFeature: "IM Adapters、FeishuAdapterPanel、persistent approval"
---

# 飞书远程控制

飞书远程控制允许你通过飞书机器人向 MAIN 发送任务，并在移动端或飞书会话中审批敏感操作。

<!-- screenshot: docs/main-manual/assets/feishu-remote-control.png -->

## 适用场景

- 离开电脑后继续给本地 MAIN 派发任务。
- 在飞书私聊中批准或拒绝工具操作。
- 为远程协作保留独立会话上下文。

## 前置条件

- 已在飞书开放平台创建企业自建应用。
- 已启用机器人能力，并把机器人加入你的飞书账号。
- MAIN 保持运行，并打开目标工作区。
- 本机可运行飞书适配器 sidecar 所需的 Node.js。

## 步骤

1. 打开 `Settings > IM Adapters`。
2. 启用飞书适配器。
3. 填写 App ID、App Secret 和飞书域名。
4. 根据面板说明启动长连接。
5. 在 MAIN 中生成配对码。
6. 在飞书私聊机器人发送 `/pair 配对码`。
7. 配对成功后，在飞书中发送任务。
8. 当 MAIN 需要审批时，在飞书卡片中批准或拒绝。

## 结果确认

- 设置页显示飞书适配器运行状态。
- 配对用户列表出现你的飞书用户。
- 飞书消息进入当前工作区，并按用户维护会话。
- 审批状态会同步回 MAIN，批准后任务继续执行。

## 常见问题

**MAIN 关闭后飞书还能执行任务吗？**  
不能。飞书远程控制依赖本机 MAIN 和适配器保持运行。

**审批卡片没有出现怎么办？**  
检查飞书事件订阅、机器人权限、长连接状态和 MAIN 调试日志。

**飞书任务会进入哪个项目？**  
消息会进入当前打开的工作区。发送远程任务前，确认 MAIN 当前工作区正确。

## 下一步

- 阅读 [权限与审批](permissions-and-approval.md)，了解审批机制。
- 阅读 [工作区与会话](workspaces-and-sessions.md)，管理远程任务上下文。
- 阅读 [故障排查](troubleshooting.md)，排查适配器和远程审批问题。
