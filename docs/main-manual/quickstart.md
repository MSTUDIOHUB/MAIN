---
title: "快速开始"
sidebarTitle: "快速开始"
description: "从安装、连接模型到发送第一条任务的最短路径。"
category: "getting-started"
order: 20
status: "draft"
sourceFeature: "设置页、本地模型、云端模型、工作区、Composer"
---

# 快速开始

这篇文档带你完成 MAIN 的最短可用路径：安装应用、连接模型、打开工作区，然后让 MAIN 完成一次真实任务。

<!-- screenshot: docs/main-manual/assets/quickstart-first-task.png -->

## 适用场景

- 第一次安装 MAIN。
- 已经有本地模型或云端 API，想尽快开始使用。
- 想确认 MAIN 能读取项目并给出可验证的结果。

## 前置条件

- 已下载并安装 MAIN。
- 本地模型用户需要先启动 LM Studio、Ollama 或 OMLX。
- 云端模型用户需要准备 API Endpoint、模型名和 API Key。
- 准备一个可以安全试用的项目文件夹。

## 步骤

1. 打开 MAIN。
2. 点击顶部模型状态按钮，进入模型设置。
3. 如果使用本地模型，选择 `Local Setup`，设置 Provider、Endpoint，并点击扫描模型。
4. 如果使用云端模型，选择 `Cloud Setup`，新增服务器，填写协议、Endpoint、API Key 和模型。
5. 回到主界面，点击左侧工作区区域添加或选择项目文件夹。
6. 在输入框中发送一个低风险任务，例如：

   ```text
   请阅读这个项目的结构，告诉我它是做什么的，并列出最重要的入口文件。
   ```

7. 观察 MAIN 是否自动读取目录、搜索文件并输出总结。

## 结果确认

一次成功的快速开始通常会出现：

- 模型状态显示已选择的本地或云端模型。
- 左侧显示当前工作区和新会话。
- 对话区出现 MAIN 的工具读取记录和总结。
- 如果任务只要求分析，MAIN 不会写入文件。

## 常见问题

**模型列表扫描不到怎么办？**  
确认本地服务已启动、Endpoint 正确，并检查服务是否暴露 OpenAI 兼容的 `/models` 或 Ollama 模型列表接口。

**云端测试失败怎么办？**  
先确认协议类型。聚合网关通常选择 OpenAI Compatible；Anthropic 原生接口选择 Anthropic；Gemini API Key 选择 Gemini。

**第一次任务应该让 MAIN 修改文件吗？**  
建议先让 MAIN 做只读分析。确认模型、工作区和工具链稳定后，再尝试修改和验证任务。

## 下一步

- 阅读 [第一个工作区](first-workspace.md)，理解工作区和会话。
- 阅读 [本地模型](local-models.md) 或 [云端模型](cloud-models.md)，完成更细的模型配置。
- 阅读 [代码工作流](coding-workflows.md)，开始让 MAIN 处理真实开发任务。
