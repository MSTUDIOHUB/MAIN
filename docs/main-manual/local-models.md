---
title: "本地模型"
sidebarTitle: "本地模型"
description: "配置 LM Studio、Ollama 和 OMLX。"
category: "platforms-integrations"
order: 10
status: "draft"
sourceFeature: "Settings Local Setup、LM Studio、Ollama、OMLX、modelDiscovery"
---

# 本地模型

MAIN 可以连接本机运行的 LM Studio、Ollama 或 OMLX，让项目数据尽量留在本地推理环境中。

<!-- screenshot: docs/main-manual/assets/local-models-settings.png -->

## 适用场景

- 想使用本地大模型完成代码和文档任务。
- 想降低云端 API 依赖。
- 需要在不同本地服务之间切换。

## 前置条件

- 已安装并启动本地模型服务。
- 已下载或加载可用模型。
- 本地服务 Endpoint 可从 MAIN 访问。

## Provider 说明

`LM Studio` 通常使用 OpenAI 兼容接口，适合运行支持工具调用或文本工具格式的本地模型。

`Ollama` 使用 Ollama 服务地址，MAIN 会保持更适合 Ollama 的文本工具协议。

`OMLX` 面向 Mac 上的 MLX 推理服务，可按服务要求填写 Endpoint、模型和可选 API Key。

## 步骤

1. 打开 `Settings > Local Setup`。
2. 选择 Provider。
3. 填写 API Endpoint。
4. 如果服务需要鉴权，填写 API Key。
5. 点击扫描模型。
6. 从模型列表选择模型，或手动填写模型名。
7. 需要时打开高级兼容项，选择工具协议。
8. 回到对话区发送只读任务验证。

## 结果确认

- 顶部模型状态显示当前本地 Provider 和模型。
- 扫描模型后能看到可选模型数量。
- 发送任务后，MAIN 能正常流式返回并调用只读工具。

## 常见问题

**本地模型不支持 native tools 怎么办？**  
MAIN 会尽量使用 XML / Text Tools 兼容模式。Ollama 默认就会走文本工具模式。

**模型很慢或中途失败怎么办？**  
降低上下文窗口、选择更小模型，或减少一次任务需要读取的文件量。

**Endpoint 应该填什么？**  
以本地服务实际监听地址为准。常见形式是 `http://127.0.0.1:1234/v1` 或 Ollama 的本地地址。

## 下一步

- 阅读 [上下文与记忆](context-and-memory.md)，调整本地模型上下文。
- 阅读 [云端模型](cloud-models.md)，配置备用云端模型。
- 阅读 [故障排查](troubleshooting.md)，处理连接和模型列表问题。
