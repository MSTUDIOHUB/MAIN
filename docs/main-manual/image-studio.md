---
title: "图像工作室"
sidebarTitle: "图像工作室"
description: "使用本地图片服务或 HiDream Web fallback 生成图片。"
category: "use-main"
order: 70
status: "draft"
sourceFeature: "imageStudio、ImageGenerationCard、本地图片服务、HiDream Web fallback"
---

# 图像工作室

图像工作室是 MAIN 的独立图片生成工作区，支持本地图片服务优先，也可使用 HiDream Web fallback。

<!-- screenshot: docs/main-manual/assets/image-studio-empty-state.png -->

## 适用场景

- 生成产品图、概念图、界面灵感图或视觉草稿。
- 使用本地 OpenAI Images 兼容服务。
- 本地服务不可用时使用轻量 Web fallback。

## 前置条件

- 已进入图像工作室会话。
- 本地模式需要启动图片服务并填写 Endpoint 和模型。
- Web fallback 需要网络可访问 HiDream 服务。

## 步骤

1. 切到图像工作室。
2. 点击 Setup 设置 provider。
3. 选择本地图片服务或 Web fallback。
4. 设置比例、尺寸、steps、CFG、seed 等参数。
5. 点击检测 provider，确认状态可用。
6. 在输入框写图片提示词并发送。
7. 等待生成卡片完成，查看图片、复制提示词或重新生成。

## 结果确认

- 顶部状态显示图像工作室 provider 和当前模型。
- 生成卡片显示提示词、参数、进度和输出。
- 完成后可以打开保存的图片文件。
- 重新生成时可以编辑提示词。

## 常见问题

**图像工作室和普通聊天有什么区别？**  
图像工作室会把会话目标聚焦在图片生成，并显示专用 provider 状态和生成卡片。

**为什么 Web fallback 有冷却？**  
Hosted 服务可能有速率限制。冷却结束后再重新生成。

**是否支持 image-to-image？**  
当前手册第一版以 text-to-image 为主。以应用内 provider capability 显示为准。

## 下一步

- 阅读 [本地模型](local-models.md)，了解本地服务配置习惯。
- 阅读 [云端模型](cloud-models.md)，区分文本模型和图片服务。
- 阅读 [故障排查](troubleshooting.md)，处理 provider 不可用。
