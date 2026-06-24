# MAIN 2.2.9 中文 Release Note

版本跨度：2.2.8 -> 2.2.9  
整理日期：2026-06-05

MAIN 2.2.9 是一轮聚焦于"会话体验优化"与"发布流程自动化"的更新版本。本次更新对会话持久化逻辑进行了简化与重构，使会话状态管理更加轻量高效；同时，将原有的 TopIsland 组件全面替换为 ExecutionCapsule，提升了执行过程的可视化与交互体验。此外，还引入了会话运行时同步中间件，改进了 Agent 编排逻辑与错误处理机制；新增了 macOS 和 Windows 发布的自动化版本验证功能，进一步完善了发布流程的可靠性保障。这一版本在用户体验与工程效率上均实现了显著提升。

## 主要更新

### 亮点 1：会话持久化逻辑简化与聊天进度 UI 优化

- **会话持久化重构 (Session Persistence Refactor)**：对会话持久化逻辑进行了全面简化与重构，移除了冗余的状态跟踪变量与复杂的同步机制，使会话状态的保存与恢复更加轻量高效。重构后的逻辑减少了内存占用，同时保持了数据完整性与一致性。
- **聊天进度 UI 简化 (Chat Progress UI Simplification)**：优化了聊天区域的进度显示逻辑，移除了过度复杂的进度指示器，采用更简洁直观的加载状态提示，使用户能够更清晰地感知执行进度而不会被冗余信息干扰。

### 亮点 2：ExecutionCapsule 组件全面替换 TopIsland

- **ExecutionCapsule 组件升级 (ExecutionCapsule Replacement)**：将原有的 TopIsland 组件全面替换为 ExecutionCapsule 组件。新的 ExecutionCapsule 采用更现代化的卡片式设计，支持折叠/展开、进度条显示、操作按钮集成等功能，显著提升了执行过程的可视化效果与交互体验。
- **相关引用与配置更新 (Related References Update)**：同步更新了所有引用 TopIsland 的组件、测试用例与配置文件，确保替换后的功能完整性与行为一致性。

### 亮点 3：会话运行时同步中间件与 Agent 编排改进

- **运行时同步中间件 (Runtime Synchronization Middleware)**：新增了会话运行时同步中间件，确保前端 UI 状态与后端 Agent 执行状态保持实时同步。该中间件能够自动处理状态变更、错误传播与恢复逻辑，减少了状态不一致导致的 UI 异常。
- **Agent 编排逻辑优化 (Agent Orchestration Logic)**：改进了 Agent 编排逻辑，使任务调度更加智能与高效。新增了对复杂任务链的自动分解与并行执行能力，提升了多步骤任务的完成效率。
- **错误处理机制增强 (Error Handling Enhancement)**：完善了错误处理机制，新增了更细粒度的错误分类与恢复策略。当执行过程中出现异常时，系统能够自动判断错误类型并选择最合适的恢复路径，减少了用户干预的需求。

### 亮点 4：发布流程自动化与签名优化

- **自动化版本验证 (Automated Version Verification)**：新增了 macOS 和 Windows 发布的自动化版本验证功能。在构建与打包过程中，系统会自动检查版本号一致性、文件完整性与签名状态，确保发布产物符合质量标准。
- **签名密码解析改进 (Signing Password Resolution)**：改进了签名密码的解析与注入逻辑，支持从环境变量、密钥链等多种来源获取签名凭据，提升了多环境构建的兼容性与安全性。

## 修复与稳定性

- **未使用变量清理 (Unused Variable Cleanup)**：移除了 AgentOrchestrator 中未使用的前缀状态跟踪变量，减少了代码冗余与潜在的混淆风险。
- **版本合规统一**：项目配置、应用描述及包配置文件中的版本号已统一校准更新至 `2.2.9`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.2.9_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.2.9_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.2.9_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.2.9_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.2.9_macOS_universal.zip`；
- 解压后把 `MAIN.app` 拖到 `Applications`；
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`；
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`；
- 如果看到 "damaged and can't be opened" 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。