# MAIN 2.2.2 中文 Release Note

版本跨度：2.2.1 -> 2.2.2  
整理日期：2026-05-29

MAIN 2.2.2 是在 2.2.1 之后发布的一轮快速迭代优化版本。本次更新在继续夯实 2.2.1 稳定特性的基础之上，聚焦于 Agent 实时执行状态（心流胶囊）的弹性可控性、Git 极速项目骨架解析、本地大模型 Token 阶梯消耗深度优化，以及智能快捷回复（Quick-Reply）推断逻辑的精准度跃升。这一版本不仅赋予了用户更自由的心流视觉控制力，还在底层性能与工程稳定性上完成了关键的调优收敛。

## 主要更新

### 亮点 1：全新 Agent 实时心流胶囊与个性化开关控制

- **动态可隐藏心流胶囊 (Toggleable Explanation Capsule)**：在会话主界面引入可动态隐藏与展开的 Agent 实时心流胶囊。用户可实时监控 Agent 执行期间的思考过程与心流动作，支持在界面中一键收起或展开，确保阅读与调试视域两不误。
- **个性化胶囊启用开关 (Enable Capsule Toggle)**：系统设置面板 (Settings Modal) 新增“启用心流胶囊 (Enable Capsule)”全局硬开关。用户可以自由关闭该胶囊的拦截和展示渲染，将界面还原至最精简的消息列表状态。
- **胶囊视觉微调与极简滚动条 (Custom Scrollbars)**：胶囊排版容器深度重构，引入了专属的细窄渐微动滚动条 (Thin Custom Scrollbar Track)，在保留长文字流平滑阅读性的同时，最大化消除了传统滚动条的视觉噪声。

### 亮点 2：基于 Git 索引的极速项目骨架生成

- **Git 极速扫描树构建 (Git-based Skeleton Generation)**：升级了 `get_project_skeleton` 接口。项目加载时优先执行底层的 `git ls-files`，通过 Git 暂存区索引来极速构建项目目录文件树，对于大型复杂项目，骨架图渲染耗时呈数量级缩短。
- **智能原生兜底与超长安全裁剪**：若检测到当前工作区非 Git 仓库或 Git 指令执行异常，系统会自动平滑回退至原生 Native Walker；并支持按深度及 32KB 大小智能缩略（如 `[... +X files]` 标识），完美防范 Token 暴涨和界面白屏。

### 亮点 3：本地大模型 Token 阶梯分配优化与轻量化恢复

- **本地模型递增智能约束 (Local Model Token Escalation)**：优化了针对本地私有大模型 (Local Models) 的 Token 限制主动阶梯递增机制。新版只有当 Agent 产生真实的活跃工具调用（Active Tool Calls）时，才会按需扩充 Token 上限，普通自然语言闲聊时严禁无谓升级，极大降低了本地设备 CPU/GPU 内存溢出概率并节省了计算带宽。
- **轻量级恢复执行模式 (Validation Recovery Optimization)**：调优了故障恢复链路（Recovery Mode），非 normal 级别的测试恢复流程（如 validation 模式）下自动屏蔽多余的只读探测动作，同时将主动恢复预算 (`proactiveTriggerBudget`) 强力压缩至 16,000 Token，确保在极端断点恢复时的极速响应与稳定度。

### 亮点 4：交互式智能快捷回复（Quick-Reply）语义净化

- **开放式问题智能识别 (Open-ended Heuristics)**：升级了快捷推荐的语义判断机制，自动检测并屏蔽诸如“哪个”、“为什么”等开放式疑问句式，防止产生不具操作性的“幽灵快捷按钮”。
- **自然语言选项人性化重构 (Option Normalization)**：优化了推荐动作按钮的文本翻译过滤算法，自动去除以 Assistant 视角叙述的赘言前缀（如“您是否希望我...”、“想让我...”），直接转译为高产品感的、用户第一视角的行动词（如“直接执行...”、“切换到...”）。
- **多端飞书 IM 适配协议升级 (Feishu Card Schema 2.0)**：实现了飞书多端互动卡片 2.0 规格兼容（`schema: "2.0"`），并封装了专门的 `buildFeishuMarkdownCard` 函数，使得远程卡片的图文展示更具现代感与可读性。

## 修复与稳定性

- **图标资源升级 (App Icon Update)**：重新打包并替换了 macOS 应用内外图标资源（`icon.icns`），保证了高分辨率 Retina 屏幕下的精致视觉质感。
- **只读探测优化 (Read-Only Activity Suppressing)**：非标准恢复模式下探测深度自适应设为无穷，完全跳过了冗余的目录巡检步骤。
- **快捷回复自动化覆盖 (Test Coverage Extension)**：补齐了针对 `replyOptions` 模块的 30 余项高难度集成单元测试，完美覆盖了 Gemma 卡片转译、二进制/枚举自动推断及长逻辑链条的准确性校验。

## 验证覆盖

- **集成与回归测试强化**：
  - 补充了针对 `replyOptions` 快捷推断、本地模型 Token Escalation 及 `get_project_skeleton` Git 检索流的分支校验测试；
  - 扩展了在不同恢复执行模式（Recovery Mode）下的主动触发预算控制与只读探测抑制拦截测试；
  - 670 项自动化集成与单元测试（PASS 670/670）完美通过，无任何回归故障。
- **版本合规统一**：
  - 项目配置、应用描述及包配置文件中的版本号已统一校准更新至 `2.2.2`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.2.2_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.2.2_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.2.2_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.2.2_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.2.2_macOS_universal.zip`。
- 解压后把 `MAIN.app` 拖到 `Applications`。
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`。
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`。
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
