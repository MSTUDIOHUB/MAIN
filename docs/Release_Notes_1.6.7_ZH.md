# MAIN 1.6.7 中文 Release Note

版本跨度：1.6.6 -> 1.6.7  
整理日期：2026-05-12

MAIN 1.6.7 重点强化了“Game Studio 帮助文档本地化”“命令帮助展示质量”和“本地快路径边界收敛”。本版把 Game Studio 的 `/help` 升级为直接渲染内置 Markdown 命令文档，并为整套内置命令补齐中文静态缓存；同时将旧 `.claude` 文档路径自动改写为当前 `.protocols` / `.MAIN` 路径，减少帮助内容与现有目录结构脱节；为避免本地摘要与真实计划状态不一致，`/sprint-status`、`/story-readiness`、`/scope-check` 也重新回到模型工作流，仅保留 `/help` 作为本地快路径。

## 主要更新

### Game Studio 帮助文档改为本地 Markdown 渲染

- `/help` 不再输出简短 system pill，而是直接渲染完整 Markdown 卡片，支持展示命令说明、使用步骤、示例与相关路径。
- ChatArea 新增 `game_studio_local_markdown` 系统块样式，用于承载本地帮助文档内容。
- 本地帮助输出更接近真实命令文档本体，适合作为用户的直接查阅入口。

### 新增命令文档格式化与路径重写层

- 新增 `gameStudioCommandDocs` 模块，负责解析、清洗并格式化打包内置的命令 Markdown。
- 渲染时会去掉 frontmatter 和内部说明字段，避免把维护元信息直接暴露给用户。
- 内置 `.claude/docs`、`.claude/agents`、`.claude/skills/.../SKILL.md` 等旧路径会自动改写为当前 `.protocols/game-studio` 与 `.MAIN/templates/game-studio` 路径，帮助内容与现有仓库布局保持一致。

### 中文命令文档静态缓存补齐

- 新增 `src/gameStudioPack/localized/zh/commands`，为全部内置 Game Studio 命令提供对应中文 Markdown 文件。
- 帮助文档本地展示时会优先读取中文缓存，减少运行时即时拼装和中英混杂的情况。
- `help.md`、`dev-story.md` 等关键入口命令现在可直接在本地展示中文说明。

### 本地快路径进一步收敛

- Game Studio 的本地快路径从多命令收敛为仅 `/help`。
- `/sprint-status`、`/story-readiness`、`/scope-check` 恢复为模型工作流，避免本地派生摘要与真实计划/任务状态产生偏差。
- `gameStudioCatalog` 中的命令执行模式也随之调整，帮助类与执行/分析类命令的职责边界更清晰。

## 修复与稳定性

- 修复本地帮助内容仍引用旧 `.claude` 路径，导致用户复制路径后无法直接定位的问题。
- 改进 `/help <command>` 的可读性与一致性，减少说明文案和当前打包目录结构脱节的情况。
- 收敛本地快路径覆盖范围，降低“本地状态摘要正确但真实项目状态已变化”的误导风险。

## 验证覆盖

- 新增 Node 测试：`tests/node/game-studio-command-docs.test.mjs`
  - 覆盖命令 Markdown 格式化
  - 覆盖 `.claude` 路径展示重写
  - 覆盖中文命令缓存完整性检查
- 更新 Node 测试：`tests/node/game-studio-catalog.test.mjs`
  - 验证仅 `/help` 保留 `local_fast`
  - 验证 `sprint-status`、`story-readiness`、`scope-check` 回到 `model_workflow`
- 更新 E2E：`tests/e2e/game-studio-plan-shortcuts.spec.ts`
  - 验证 `/help /dev-story` 会本地渲染 Markdown 卡片，而不是 system pill

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_1.6.7_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.6.7_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.6.7_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件
