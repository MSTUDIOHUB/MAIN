---
title: "更新日志"
sidebarTitle: "更新日志"
description: "查看 MAIN 公开版本说明归档。"
category: "reference"
order: 40
status: "draft"
sourceFeature: "docs/releases、公开 Release Notes、About update"
---

# 更新日志

MAIN 的公开版本说明保存在 `docs/releases/`，网站手册可以把这里作为更新日志索引页。

<!-- screenshot: docs/main-manual/assets/changelog-release-notes.png -->

## 适用场景

- 想了解某个版本新增了什么。
- 需要在官网展示公开更新说明。
- 想把应用内更新提示和网站文档关联起来。

## 前置条件

- 访问 MAIN 网站手册或仓库文档。
- 需要下载新版本时，打开公开 GitHub Releases 页面。

## 版本说明归档

当前仓库已有这些公开版本说明：

- `docs/releases/Release_Notes_2.2.4_ZH.md`
- `docs/releases/Release_Notes_2.2.3_ZH.md`
- `docs/releases/Release_Notes_2.2.2_ZH.md`
- `docs/releases/Release_Notes_2.2.1_ZH.md`
- `docs/releases/Release_Notes_2.2.0_ZH.md`
- `docs/releases/Release_Notes_2.1.9_ZH.md`
- `docs/releases/Release_Notes_2.0.8_ZH.md`
- `docs/releases/Release_Notes_2.0.6_ZH.md`
- `docs/releases/Release_Notes_2.0.3_ZH.md`
- `docs/releases/Release_Notes_1.6.7_ZH.md`
- `docs/releases/Release_Notes_1.6.6_ZH.md`
- `docs/releases/Release_Notes_1.6.5_ZH.md`
- `docs/releases/Release_Notes_1.6.3_ZH.md`
- `docs/releases/Release_Notes_1.6.2_ZH.md`
- `docs/releases/Release_Notes_1.6.1_ZH.md`
- `docs/releases/Release_Notes_1.6.0_ZH.md`
- `docs/releases/Release_Notes_1.5.9_ZH.md`
- `docs/releases/Release_Notes_1.5.8_ZH.md`
- `docs/releases/Release_Notes_1.5.7_ZH.md`
- `docs/releases/Release_Notes_1.5.5_ZH.md`
- `docs/releases/Release_Notes_1.5.0_ZH.md`

## 步骤

1. 在网站中把本页作为 Release Notes 索引。
2. 将每个版本说明映射成可点击页面或外链。
3. 应用内 `Settings > About` 继续作为检查更新入口。
4. 新版本发布时，同步新增 release note 文件，并更新本索引。

## 结果确认

- 用户能从手册找到历史版本说明。
- 下载入口仍指向公开 Releases。
- 手册不暴露私有构建流程、签名密钥或内部发布 token。

## 常见问题

**为什么本页不直接提供安装包？**  
安装包应由公开 Releases 或官网下载入口承载，手册只负责解释和索引。

**版本说明和应用内更新哪个更准确？**  
下载和更新以公开 Release 清单和应用内 About 为准。手册用于阅读历史变化。

**是否要写开发者发布流程？**  
不在用户手册第一版中展开。开发者发布流程继续保留在内部或现有发布文档中。

## 下一步

- 阅读 [安装与更新](install-and-update.md)，了解如何获取新版本。
- 阅读 [设置参考](settings-reference.md)，找到 About 和更新入口。
- 阅读 [故障排查](troubleshooting.md)，处理更新失败。
