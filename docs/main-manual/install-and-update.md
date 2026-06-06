---
title: "安装与更新"
sidebarTitle: "安装与更新"
description: "在 macOS 和 Windows 上安装 MAIN，并通过 GitHub Releases 或应用内更新保持最新。"
category: "getting-started"
order: 30
status: "draft"
sourceFeature: "公开 Releases、应用内检查更新、About 设置页"
---

# 安装与更新

MAIN 的公开安装包通过 GitHub Releases 分发，应用内也提供手动检查更新入口。

<!-- screenshot: docs/main-manual/assets/install-update-about.png -->

## 适用场景

- 第一次在 macOS 或 Windows 上安装 MAIN。
- 想确认当前版本是否为最新公开版本。
- 下载失败或系统拦截安装包时需要排查。

## 前置条件

- 访问 MAIN 的公开下载页面或官网入口。
- macOS 用户需要允许安装来自开发者或下载来源的应用。
- Windows 用户建议下载面向 Windows 11 x64 的安装包或便携包。

## 步骤

1. 打开 MAIN 官网或公开 GitHub Releases 页面。
2. 下载与你系统匹配的安装包。
3. macOS 用户将应用拖入 Applications，首次打开时根据系统提示确认。
4. Windows 用户运行安装包，或解压便携包后启动 MAIN。
5. 打开 MAIN 后进入 `Settings > About`。
6. 点击检查更新，等待 MAIN 获取公开 Release 清单。
7. 如果发现新版本，按界面提示安装并重启。

## 结果确认

- `About` 中显示当前应用版本。
- 检查更新后显示“已是最新版本”或可安装的新版本。
- 更新安装完成后，MAIN 会重启并进入新版本。

## 常见问题

**macOS 提示无法打开应用怎么办？**  
在系统设置的隐私与安全区域允许打开，或从右键菜单选择打开。只从 MAIN 官方下载入口获取安装包。

**检查更新失败怎么办？**  
确认网络可以访问公开 Releases。也可以打开 GitHub Releases 页面手动下载最新安装包。

**文档中的版本和应用内版本不同怎么办？**  
以应用内 `About` 和公开 Release 页面为准。手册中的截图可能滞后于最新 UI。

## 下一步

- 阅读 [快速开始](quickstart.md)，完成模型连接。
- 阅读 [故障排查](troubleshooting.md)，处理安装、更新或网络问题。
- 阅读 [更新日志](changelog.md)，了解版本变化。
