---
title: "知识库"
sidebarTitle: "知识库"
description: "导入资料并让 MAIN 在需要时按需检索。"
category: "use-main"
order: 60
status: "draft"
sourceFeature: "KnowledgeModal、knowledge_import_source、knowledge_import_url、knowledge_search"
---

# 知识库

知识库用于保存参考资料，并在你发送任务时按需检索相关片段，而不是把全文直接放进上下文。

<!-- screenshot: docs/main-manual/assets/knowledge-base-modal.png -->

## 适用场景

- 需要让 MAIN 参考产品文档、API 文档、规范或研究资料。
- 文档很长，不适合直接粘贴到输入框。
- 希望多个会话复用同一批资料。

## 前置条件

- 使用 MAIN 桌面应用。
- 准备本地文件或网页 URL。
- 资料内容适合被索引和检索。

## 步骤

1. 点击侧边栏知识库入口。
2. 新建知识库，填写名称和可选描述。
3. 导入本地资料，或输入 URL 导入网页。
4. 等待索引完成。
5. 启用需要使用的知识库。
6. 在测试检索框输入问题，确认能搜到相关片段。
7. 回到聊天，发送需要引用资料的任务。

## 结果确认

- 知识库列表显示已创建的库。
- 来源列表显示导入的文件或网页。
- 每个来源显示状态、大小和分块信息。
- 对话中出现 `knowledge_search` 或摘录读取时，说明 MAIN 正在使用知识库。

## 常见问题

**启用知识库后会不会每次都塞入全文？**  
不会。MAIN 会按需搜索，并只取相关片段。

**网页导入失败怎么办？**  
检查 URL 是否可访问、是否需要登录、是否被站点限制抓取。必要时先保存为本地文档再导入。

**知识库和附件有什么区别？**  
附件适合一次性上下文；知识库适合长期复用和按需检索。

## 下一步

- 阅读 [上下文与记忆](context-and-memory.md)，理解知识库如何进入上下文。
- 阅读 [研究分析场景](main-modes.md)，选择适合资料分析的入口。
- 阅读 [故障排查](troubleshooting.md)，处理导入或检索问题。
