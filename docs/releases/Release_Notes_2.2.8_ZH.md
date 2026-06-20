# MAIN 2.2.8 中文 Release Note

版本跨度：2.2.6 -> 2.2.8  
整理日期：2026-06-05

MAIN 2.2.8 是一轮聚焦于"执行可靠性提升"与"架构优化"的更新版本。本次更新实现了 XML 工具执行恢复机制，确保在模型返回非可操作文本时仍能正确恢复工具调用；新增了历史读取证据重建功能，大幅提升了 Agent 在只读工具循环中的容错能力；同时，对 orchestrator 架构进行了模块化重构，改善了代码可维护性与扩展性。此外，还修复了 Gemma 模型暂停问题、改进了意图路由逻辑，并引入了平台特定条件编译以优化多平台构建体验。这一版本在执行稳定性与架构质量上实现了显著跃升。

## 主要更新

### 亮点 1：XML 工具执行恢复机制

- **非可操作文本响应恢复 (XML Tool Execution Recovery)**：新增了针对模型返回非可操作文本（如纯描述性文字、解释性内容）时的工具执行恢复机制。当 Agent 未能正确生成工具调用时，系统会自动识别并重建工具调用请求，确保执行流程不中断。
- **摘要卡片 UI 更新 (Summary Card UI Update)**：更新了执行摘要卡片的视觉呈现，使其更清晰地展示工具调用状态、执行结果与下一步建议，提升了用户对执行流程的可观测性。

### 亮点 2：历史读取证据重建与恢复模式优化

- **历史读取证据重建 (Historical Read Evidence Reconstruction)**：新增了历史只读工具调用证据的重建能力。当 Agent 需要参考之前的文件读取结果时，系统会自动从缓存中恢复相关证据，避免了重复读取相同文件导致的 Token 浪费与延迟。
- **恢复模式工具约束收紧 (Recovery-Mode Tool Constraints)**：收紧了恢复模式下的工具使用约束，限制在恢复阶段只能使用安全的只读工具和必要的执行工具，防止恢复逻辑被滥用或误用。

### 亮点 3：Orchestrator 架构模块化重构

- **模块化目录结构 (Modular Directory Structure)**：对 orchestrator 核心模块进行了全面重构，将 types（类型定义）、policies（策略逻辑）、loop logic（循环控制）等核心组件提取到独立的目录结构中，提升了代码的可维护性与可扩展性。
- **自动化重构脚本 (Automated Refactoring Scripts)**：新增了自动化重构脚本，支持在构建过程中自动验证模块化结构的完整性，确保重构后的代码行为与重构前保持一致。

### 亮点 4：意图路由与会话处理改进

- **意图路由优化 (Intent Routing Improvement)**：改进了用户意图识别与路由逻辑，使系统能够更准确地判断用户是想"聊天"、"执行"还是"进入计划流程"，并自动选择最合适的处理路径。
- **活跃会话处理增强 (Active Session Handling)**：优化了多会话场景下的活跃会话管理，确保用户切换会话时上下文能够正确恢复，避免状态混乱或数据丢失。

### 亮点 5：多平台构建优化

- **平台特定条件编译 (Platform-Specific Conditional Compilation)**：引入了平台特定的条件编译机制，将非 Windows 和 macOS 专属模块隔离到独立代码路径中，减少了跨平台构建时的兼容性问题。
- **未使用变量清理 (Unused Variable Suppression)**：清理了构建过程中产生的未使用变量警告，使编译输出更加清晰，便于定位真实问题。

## 修复与稳定性

- **Gemma 暂停问题修复 (Gemma Pause Fix)**：修复了使用 Gemma 模型时可能出现的暂停响应问题，确保模型能够正常生成完整回复。
- **运行时锁清理修复 (Runtime Lock Cleanup)**：修复了运行时锁在某些异常场景下未能正确释放的问题，避免了潜在的死锁与资源泄漏。
- **版本合规统一**：项目配置、应用描述及包配置文件中的版本号已统一校准更新至 `2.2.8`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.2.8_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.2.8_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.2.8_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.2.8_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.2.8_macOS_universal.zip`；
- 解压后把 `MAIN.app` 拖到 `Applications`；
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`；
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`；
- 如果看到 "damaged and can't be opened" 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。