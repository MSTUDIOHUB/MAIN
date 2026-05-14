# MAIN Runtime 架构规则（必须遵守）

## 不允许

- 重写整个项目
- 推翻现有 UI
- 推翻现有 Session
- 推翻现有 Plan/Execute
- 单文件巨大模块
- sync blocking runtime

## 必须

- async-first
- tokio-based
- event-driven
- replayable
- repository-aware
- testable
- modular

## Runtime 优先级

优先：

- reliability
- verification
- orchestration

而不是：

- prompt tricks
- chain-of-thought hacks

## Codex 工作方式

每次：

1. 只实现一个 Phase
2. 提交 diff
3. 运行 tests
4. review architecture
5. 再进入下一阶段

## MAIN 的长期定位

MAIN = Local Agent Runtime Platform

不是：

AI Chat App

未来方向：

- Coding
- GameDev
- Browser automation
- Desktop workflows
- MCP orchestration
- Autonomous execution