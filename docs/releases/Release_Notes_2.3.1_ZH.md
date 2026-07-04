# MAIN 2.3.1 中文 Release Note

版本跨度：2.3.0 -> 2.3.1  
整理日期：2026-07-04

MAIN 2.3.1 是一轮聚焦于"思考型模型收敛"、"截断恢复机制"与"只读循环拦截"的轻量高能更新版本。本次更新针对思考型模型引入了思维链收敛规范与长输出截断恢复桥接（Truncated Reasoning Recovery Bridge），彻底解决了因推理过程过长消耗 Output Token 导致工具调用缺失的问题；优化了只读工具重复限制与观察检查点机制，防止 Agent 陷入无意义的循环读取；规范了 Shell 工作目录处理与只读校验；同时为 `read_file` 引入了文件体积门控保护，并为 `DiffReviewPanel` 带来了浅色模式支持。这一版本显著提升了模型执行的连贯性与交互稳定性。

## 主要更新

### 亮点 1：思考型模型思维链收敛与长输出截断恢复机制

- **思考链收敛规范 (Reasoning Chain Convergence Rule)**：在系统提示词中新增思考型模型收敛规范，要求在进入代码修改或命令执行阶段时快速收敛思维链（1-3 句公开说明内总结），并立即输出工具调用，防止因长篇推演消耗 Token 导致回复截断。
- **长输出截断恢复桥接 (Truncated Reasoning Recovery Bridge)**：新增 `truncated_reasoning_bridge` 恢复机制。当模型因 Token 达到上限导致输出截断且未产生工具调用时，自动注入桥接提示词，引导模型无需重新从头分析，直接输出结论并发送工具调用 JSON/XML。

### 亮点 2：只读工具重复限制与观察检查点机制

- **只读工具重复限制优化 (Read-Only Repeat Limit Optimization)**：优化了只读工具（如文件读取、目录查看）的重复调用限制与拦截机制，防止 Agent 在缺乏新证据时陷入死循环读取。
- **通用观察检查点提示 (Generic Observation Checkpoint Prompt)**：引入通用观察检查点提示词，在检测到连续只读分析后强制引导 Agent 转换视角，转向下一步实质性代码编写或命令执行。

### 亮点 3：Shell 工作目录归一化与只读校验改进

- **Shell 工作目录规范化 (Shell CWD Normalization)**：规范化 Shell 命令的 `cwd` 目录处理，确保在不同操作系统环境与相对路径下命令执行稳健可靠。
- **日志文件过滤与权限提示优化 (Log File Filtering & Permission Prompts)**：在只读校验中自动排除日志文件干扰，并优化权限请求提示词的语义表达，减少不必要的交互打扰。

### 亮点 4：大文件读取保护与 UI 视觉改进

- **read_file 文件大小门控保护 (read_file Size-Gate Protection)**：对 `read_file` 工具增加文件体积门控保护，防止误读超大文件导致内存暴涨与 Token 浪费。
- **DiffReviewPanel 浅色模式支持 (DiffReviewPanel Light Mode Support)**：为 `DiffReviewPanel` 代码对比面板新增浅色模式（Light Mode）视觉样式支持，提升不同色彩主题下的对比度与阅读体验。

### 亮点 5：Token 上下文管理与写入限额提升

- **上下文 Token 管理调优 (Token Context Management Tuning)**：精细化调优 Token 上下文管理策略，优化恢复阶段的文件读取启发式判断。
- **文件写入上限提升 (Write File Size Limit Expansion)**：提升文件写入与 Patch 编辑的单次处理容量上限，改善大型文件与多重修改场景下的吞吐效能。

## 修复与稳定性

- **重复读取与命令恢复修复 (Repeated Tool Recovery Fixes)**：改进了重复读取与命令执行时的恢复逻辑，调整工具阈值并精细化 Artifact 噪点检测。
- **只读校验日志忽略 (Read-Only Validation Log Filter)**：修正在只读验证过程中对日志文件的误判，避免日志变动触发不必要的校验拦截。
- **版本合规统一**：项目配置、应用描述及包配置文件中的版本号已统一校准更新至 `2.3.1`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.3.1_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.3.1_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.3.1_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.3.1_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.3.1_macOS_universal.zip`；
- 解压后把 `MAIN.app` 拖到 `Applications`；
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`；
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`；
- 如果看到 "damaged and can't be opened" 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。

