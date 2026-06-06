---
title: "设置参考"
sidebarTitle: "设置参考"
description: "对照说明设置页中的每个标签页。"
category: "reference"
order: 10
status: "draft"
sourceFeature: "SettingsModal tabs、General、Local、Cloud、Context、MCP、IM、Data、Debug、About"
---

# 设置参考

设置页集中管理 MAIN 的语言、主题、模型、上下文、MCP、飞书、数据、调试日志和更新。

<!-- screenshot: docs/main-manual/assets/settings-reference.png -->

## 适用场景

- 找不到某个配置项。
- 想理解设置项会影响什么。
- 排查模型、MCP、更新或调试日志问题。

## 前置条件

- 已打开 MAIN。
- 点击主界面设置入口。

## 标签页说明

`General` 管理显示语言、回复语言策略、主题色、深色/黑色/浅色模式、聊天字号、会话记录和 Capsule 相关开关。

`Local Setup` 管理本地模型 Provider、Endpoint、模型列表、API Key 和本地工具协议。

`Cloud Setup` 管理多个云端服务器、协议、Endpoint、API Key、模型列表、连接测试和高级兼容项。

`Context` 管理上下文窗口、压缩触发阈值和预估显存占用。

`MCP Servers` 管理外部 MCP 服务器、连接测试和工具扫描。

`IM Adapters` 管理飞书远程控制、配对用户、sidecar 状态和远程审批。

`Data Management` 管理本地设置、会话索引和清理操作。

`Debug Log` 管理调试日志、完整回合过程记录、复制、导出和清空日志。

`About` 显示应用版本、应用图标偏好、检查更新和 GitHub Releases 入口。

## 步骤

1. 打开设置。
2. 在左侧选择标签页。
3. 修改配置后保存或完成。
4. 如果模型正在运行，部分模型相关配置会被锁定，等待当前任务结束后再改。
5. 修改模型、MCP 或飞书后，发送低风险任务验证。

## 结果确认

- 设置保存后，顶部状态或界面语言应立即反映关键变化。
- 模型配置成功后，可以扫描模型或通过测试连接。
- Debug Log 可用于导出排查信息。
- About 可确认当前版本和更新状态。

## 常见问题

**为什么运行中不能切换模型？**  
为了避免当前模型请求被中途破坏，MAIN 会在模型运行时锁定当前执行模型。

**重置设置会删除协议包吗？**  
重置设置不会彻底删除已解压到工作区的协议包文件。需要清理时按对应功能的移除入口或手动清理工作区资产。

**调试日志会暴露密钥吗？**  
MAIN 会自动隐藏常见密钥字段，但导出日志前仍建议人工检查敏感内容。

## 下一步

- 阅读 [本地模型](local-models.md) 或 [云端模型](cloud-models.md)，完成模型配置。
- 阅读 [MCP 服务器](mcp.md)，配置外部工具。
- 阅读 [故障排查](troubleshooting.md)，按症状定位问题。
