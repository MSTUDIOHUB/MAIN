# Steering Files — 项目规则与最佳实践

## 这是什么？

Steering 文件是 Markdown 格式的规则文件，用于指导 AI Agent 遵循你项目的约定、最佳实践和技术标准。
Agent 在每次交互前会自动读取这些文件，确保所有生成和建议都符合你的项目规范。

## 目录结构

```
.MAIN/steering/
├── README.md                    ← 你正在读的文件
├── product.md                   ← 产品概述（基础文件）
├── tech.md                      ← 技术栈（基础文件）
├── structure.md                 ← 项目结构（基础文件）
├── project_conventions.md       ← 通用编码规范（基础文件）
├── unity_physics.md             ← Unity 物理最佳实践（领域文件）
├── memory_management.md         ← 内存管理最佳实践（领域文件）
└── assembly_definitions.md      ← 模块隔离标准（领域文件）
```

## 基础文件 vs 领域文件

- **基础文件**（product.md, tech.md, structure.md）：每次交互都会加载，定义项目核心上下文。
- **领域文件**（如 unity_physics.md）：仅在任务与该领域相关时加载，避免浪费上下文。

## 如何添加你自己的规则

1. 在此目录下创建新的 `.md` 文件。
2. 使用自然语言描述规则和标准。
3. 在文件顶部添加 front matter 控制加载模式：

```yaml
---
inclusion: always          # 每次交互都加载
---
```

```yaml
---
inclusion: fileMatch
fileMatchPattern: "**/*.cs"  # 仅在操作匹配文件时加载
---
```

```yaml
---
inclusion: manual          # 用户在对话中用 #文件名 手动引用
---
```

```yaml
---
inclusion: auto
name: api-design
description: REST API 设计模式和约定，在创建或修改 API 端点时使用。
---
```

## 编写规范

- **一个文件一个领域** — 不要把 API 规范和测试规范混在一起。
- **解释原因** — 不仅写「怎么做」，还要写「为什么这样做」。
- **提供示例** — 用代码片段和前后对比来展示标准。
- **不要包含密钥** — Steering 文件是代码库的一部分，禁止存放敏感信息。
- **定期维护** — 在架构变更时更新相关文件。
