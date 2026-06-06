---
title: "云端模型"
sidebarTitle: "云端模型"
description: "连接 OpenAI Compatible、Anthropic、Gemini 和其他云端网关。"
category: "platforms-integrations"
order: 20
status: "draft"
sourceFeature: "Settings Cloud Setup、cloudProtocol、Responses API、toolProtocol"
---

# 云端模型

MAIN 支持多个云端服务器配置，可以连接 OpenAI Compatible、Anthropic、Gemini 以及企业或聚合模型网关。

<!-- screenshot: docs/main-manual/assets/cloud-models-settings.png -->

## 适用场景

- 使用云端高能力模型处理复杂工程任务。
- 通过 OpenRouter、企业网关或其他 OpenAI 兼容服务接入模型。
- 需要在不同云端模型之间切换。

## 前置条件

- 已准备 API Endpoint。
- 已准备 API Key 或实验登录所需账号。
- 确认服务使用的协议：OpenAI Compatible、Anthropic 或 Gemini。

## 协议说明

OpenAI Compatible 适合大多数聚合网关和 OpenAI 风格接口。它可以选择 Chat Completions 或 Responses API。

Anthropic 适合 Claude 原生 Messages API。

Gemini 适合 Gemini API Key 或实验性的 Google 登录通道。

高级兼容项可以调整工具协议、Responses API 推理强度、响应存储和自定义请求头。

## 步骤

1. 打开 `Settings > Cloud Setup`。
2. 新增服务器。
3. 填写服务器名称。
4. 选择 API Protocol。
5. 填写 Endpoint 和 API Key。
6. 点击刷新模型列表，或手动填写模型名。
7. 点击测试，确认模型能返回有效响应。
8. 保存并设为当前配置。

## 结果确认

- 顶部模型状态显示云端服务器名和模型。
- 设置页测试返回连接成功。
- 如果服务不支持某种 API format，MAIN 会提示切换或自动兼容。

## 常见问题

**OpenAI Compatible 应该选 Chat Completions 还是 Responses API？**  
普通聚合网关先试 Chat Completions。明确支持 Responses API 或需要 Codex 风格兼容时再切换 Responses API。

**工具协议 Auto / Native / XML 怎么选？**  
默认 Auto。网关不支持 native tools 时，切 XML；明确支持函数调用时可用 Native。

**Anthropic 协议测试失败怎么办？**  
确认 Endpoint 是 Anthropic 根地址，并检查该服务是否真的支持 `/v1/messages`。

## 下一步

- 阅读 [本地模型](local-models.md)，准备本地备用模型。
- 阅读 [工具参考](tools-reference.md)，理解不同工具协议的影响。
- 阅读 [故障排查](troubleshooting.md)，处理云端连接失败。
