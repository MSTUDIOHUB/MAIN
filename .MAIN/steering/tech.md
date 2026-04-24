---
inclusion: always
---

# Technology Stack

## 运行时与框架
- 桌面容器：Tauri 2
- 前端应用：React 19 + Vite 7
- 状态管理：Zustand
- 后端宿主：Rust（Tauri command / IPC）
- Hook / 模板辅助：Node.js 脚本 + 工作区 Markdown 模板
- 终端能力：portable-pty + xterm.js
- 图表/文档渲染：React Markdown + Mermaid

## 语言版本
- TypeScript 5.x
- Rust stable（随 Tauri 2 工具链）
- HTML / CSS
- Node.js（前端构建与开发）

## 关键依赖
- `@tauri-apps/api` / `@tauri-apps/cli`
- `@tauri-apps/plugin-dialog`
- `@tauri-apps/plugin-opener`
- `zustand`
- `react-markdown`
- `remark-gfm`
- `mermaid`
- `@xterm/xterm`
- `@xterm/addon-fit`
- `react-syntax-highlighter`

## 开发工具
- 包管理：npm
- 前端构建：Vite
- 类型检查：TypeScript (`tsc`)
- 桌面构建：Tauri CLI
- Rust 构建：Cargo
- 推荐 IDE：VS Code + rust-analyzer + Tauri 插件

## 技术约束
- 前端与 Rust 通过 IPC 协作，工作区内文件操作默认走 Rust 命令，避免浏览器端文件权限问题；
- 工作区读写存在路径安全约束，项目内写入与“导出到任意路径”的能力需要明确区分；
- Hook 命令必须由 Rust 后端启动，并以工作区为当前目录执行，避免前端直接执行本地命令；
- 本地模型可能只支持文本工具调用回退，不一定稳定支持原生 tool calling；
- 计划面板、Diff、终端、文件查看共用同一套前端状态，状态同步错误会直接影响 Agent 执行体验；
- 长上下文任务依赖上下文压缩策略，复杂任务需要谨慎控制工具结果与提示词长度。
