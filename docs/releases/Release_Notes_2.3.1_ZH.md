# MAIN 2.3.1 中文 Release Note

版本跨度：2.3.0 -> 2.3.1  
整理日期：2026-07-05

MAIN 2.3.1 是一轮聚焦于"思考型模型收敛"、"本地模型 OOM 恢复"与"恢复模式稳定性"的重大功能与架构改进版本。本次更新针对思考型模型引入了思维链收敛规范与长输出截断恢复桥接（Truncated Reasoning Recovery Bridge），彻底解决了因推理过程过长消耗 Token 导致工具调用缺失的问题；针对本地模型引入了动态上下文限制计算与内存溢出（OOM）自动恢复机制；全面提升了恢复模式的稳定性，引入了迭代次数上限、自适应上下文注入与状态感知的缓存重置；同时优化了只读工具重复限制与 Shell 安全工具白名单，并为 `read_file` 引入了文件体积门控保护，为 `DiffReviewPanel` 带来了浅色模式支持。这一版本在模型连贯性、本地部署可靠性与系统故障自愈能力上均实现了显著跃升。

## 主要更新

### 亮点 1：思考型模型思维链收敛与长输出截断恢复机制

- **思考链收敛规范 (Reasoning Chain Convergence Rule)**：在系统提示词中新增思考型模型收敛规范，要求在进入代码修改或命令执行阶段时快速收敛思维链（1-3 句公开说明内总结），并立即输出工具调用，防止因长篇推演消耗 Token 导致回复截断。
- **长输出截断恢复桥接 (Truncated Reasoning Recovery Bridge)**：新增 `truncated_reasoning_bridge` 恢复机制。当模型因 Token 达到上限导致输出截断且未产生工具调用时，自动注入桥接提示词，引导模型无需重新从头分析，直接输出结论并发送工具调用 JSON/XML。
- **Shell 安全工具列表扩展 (Shell Tool Safety Expansion)**：扩展了 Shell 只读与安全工具指令白名单，提升命令执行与环境探查的流畅度与安全防线。

### 亮点 2：本地模型动态上下文限制与 OOM 自动恢复

- **动态上下文限制计算 (Dynamic Local Context Limit Calculation)**：新增本地模型（如 Ollama / LM Studio 等）的物理内存与显存限制动态计算，自动校准上下文 Window 预算，防止资源超载。
- **OOM 自动降级与恢复 (Automatic Local Model OOM Recovery)**：引入本地模型内存溢出（OOM）自动恢复机制。当本地模型遭遇 OOM 异常时，系统能自动调降上下文长度并安全重试，提升私有部署场景下的稳定连贯体验。

### 亮点 3：恢复模式稳定性与状态感知缓存重置

- **恢复模式迭代上限 (Recovery Mode Iteration Caps)**：为故障恢复逻辑引入严格的迭代次数上限，防止在极端异常下陷入无限自愈循环。
- **自适应上下文注入与缓存重置 (Adaptive Context Injection & State-Aware Cache Resetting)**：实现了自适应上下文注入与状态感知的缓存重置策略，确保 Agent 在触发恢复逻辑时上下文状态精准复原，大幅提升故障自愈成功率。

### 亮点 4：只读工具重复限制与观察检查点机制

- **只读工具重复限制优化 (Read-Only Repeat Limit Optimization)**：优化了只读工具（如文件读取、目录查看）的重复调用限制与拦截机制，防止 Agent 在缺乏新证据时陷入死循环读取。
- **通用观察检查点提示 (Generic Observation Checkpoint Prompt)**：引入通用观察检查点提示词，在检测到连续只读分析后强制引导 Agent 转换视角，转向下一步实质性代码编写或命令执行。

### 亮点 5：Shell CWD 规范化、大文件保护与 UI 视觉改进

- **Shell 工作目录规范化 (Shell CWD Normalization)**：规范化 Shell 命令的 `cwd` 目录处理，确保在不同操作系统环境与相对路径下命令执行稳健可靠。
- **read_file 文件大小门控保护 (read_file Size-Gate Protection)**：对 `read_file` 工具增加文件体积门控保护，防止误读超大文件导致内存暴涨与 Token 浪费。
- **DiffReviewPanel 浅色模式支持 (DiffReviewPanel Light Mode Support)**：为 `DiffReviewPanel` 代码对比面板新增浅色模式（Light Mode）视觉样式支持，提升不同色彩主题下的对比度与阅读体验。

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
