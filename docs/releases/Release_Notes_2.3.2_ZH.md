# MAIN 2.3.2 中文 Release Note

版本跨度：2.3.1 -> 2.3.2  
整理日期：2026-07-06

MAIN 2.3.2 是一轮聚焦于"思考型模型输出扩容"、"截断自愈链路修复"与"聊天界面体验简化"的更新版本。本次更新彻底取消了本地模型 2048 Token 的初始限制并提升至 4096，同时优化了云端与本地模型的梯级扩容机制（本地最大支持 8192，云端最高支持 32768）；修复了因思维链过长导致响应触顶截断时被错误强杀的缺陷，全面启用了截断恢复桥接（Truncated Reasoning Bridge）自愈逻辑；此外，移除了旧版意图历史 UI，使聊天区域的视觉呈现更加清爽连贯。这一版本显著提升了思考型模型的任务完成率与交互流畅度。

## 主要更新

### 亮点 1：思考型模型输出容量提升与梯级扩容优化

- **初始 Token 上限提升 (Initial Token Limit Expansion)**：移除了本地模型初始 `2048` 的硬编码封顶，统一提升至 `4096` 初始输出额度，为 Qwen 3.6 35B、DeepSeek-R1 等本地思考型模型预留充足的思维链与工具调用空间。
- **本地与云端梯级扩容 (Tiered Output Token Escalation)**：优化了响应触顶（`finishReason === "length"`）时的自动扩容机制。本地模型支持由 4096 自动扩容至 `8192`，云端模型最高支持扩容至 `32768`，避免深层推演因 Token 不足导致中断。

### 亮点 2：截断自愈链路修复与思维收敛引导

- **拦截策略解耦修复 (Reasoning Truncation Fix)**：解除了当输出被思维链占满且发生截断时的误杀挂起逻辑。截断响应不再触发 `onNonActionableStop` 中断，而是顺畅进入自愈流程。
- **截断恢复桥接 (Truncated Reasoning Bridge)**：全面启用截断恢复桥接提示词，引导思维链过长的模型在 1-3 句内收束结论并立即输出工具调用；已生成的公开 Markdown 总结与阶段性结论实时保留在 ChatArea 中，提升用户感知与自愈成功率。

### 亮点 3：聊天区域 UI 简化与组件清理

- **旧版意图历史组件清理 (Legacy Intent History UI Cleanup)**：移除了 ChatArea 中冗余的意图历史标签与旧版状态展示逻辑，清理了不必要的 DOM 节点与样式积压。
- **流式视觉体验优化 (Streaming Visual Experience)**：优化了流式文本渲染与思考块（Thought Block）的折叠交互，使对话流展现更加纯粹规范。

## 修复与稳定性

- **云端与本地拦截逻辑解耦 (Cloud & Local Intercept Decoupling)**：修正在云端/本地大模型推演过程中因字符比例误判导致的误暂停问题。
- **版本合规统一**：项目配置、Tauri 桌面配置及包配置文件中的版本号已统一校准更新至 `2.3.2`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.3.2_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.3.2_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.3.2_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.3.2_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.3.2_macOS_universal.zip`；
- 解压后把 `MAIN.app` 拖到 `Applications`；
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`；
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`；
- 如果看到 "damaged and can't be opened" 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
