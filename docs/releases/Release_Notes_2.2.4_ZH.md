# MAIN 2.2.4 中文 Release Note

版本跨度：2.2.3 -> 2.2.4  
整理日期：2026-05-31

MAIN 2.2.4 是在 2.2.3 之后发布的一轮以“核查与防护”为主题的重点优化版本。本次更新在继续夯实 2.2.3 实时网络搜索的基础之上，引入了革命性的“Web Research Guard 网络实时核查与防幻觉机制”，实现了对高时效性外部知识的强制搜索与交叉校验。此外，这一版本还精细重构了本地打包产物收集工具的可靠性，并大幅拓宽了核心 UI（如聊天渲染与侧边栏目标联动）在极端长交互场景下的端到端测试覆盖，全面守卫用户在使用 Agent 执行高风险任务时的交互准确性与运行可信度。

## 主要更新

### 亮点 1：全新 Web Research Guard 网络核查与防幻觉安全卫士

- **智能时效性核查判定 (Smart Fact Heuristics)**：引入了专门的事实判定引擎。当用户 prompt 中提及或隐式包含需要实时/近期外部事实验证的信息（如最新软件版本、最新变更日志、官网 API 说明、实时价格、新闻或天气等），系统会自动识别出该高时效性核查特征。
- **阻断预训练记忆盲答与强制搜索核验 (Forced Fact Verification)**：一旦触发核验机制，系统会自动阻断大模型的预训练记忆盲答（杜绝模型凭借过时知识或幻觉胡乱拼凑答案），强制在第一轮中发起高精度的网络搜索，确保所有的时效性知识均源于最新的在线可信证据。
- **智能链路深度追溯与 URL 强引用 (Deep Trace & Citation)**：在搜索到结果后，若涉及官方发布日志或 GitHub 归档，系统会进一步强制模型使用网页深度抓取进行内容精读，并在最终答案中必须清晰、准确地列出引用的来源 URL；若线上信息不足，模型必须明确警示用户“证据不足，无法盲目断言”，极大提升了信息回复的严谨性。

### 亮点 2：核心 UI 在极端交互场景下的高稳定性重构

- **聊天面板渲染性能长效稳固 (ChatArea Render Stability)**：对长会话、流式排版、海量气泡卡片共存的极长交互情景，优化了渲染机制，防止由于极速追加内容引发的 DOM 重绘抖动，保障了全天候连续运行下的视觉平稳度。
- **侧边栏状态联动深度校准**：精细优化了侧边栏（Sidebar）在多目标工作区频繁切换、快速激活等高频操作下的状态反馈，彻底消除了极端场景下可能出现的“幽灵激活项”与状态不一致。

### 亮点 3：本地打包分发脚本与产物收集工具可靠性提升

- **严密的 HEAD 对齐度验证**：在本地执行一键自动化打包上传时，发布工具会智能验证当前工作区的清洁度与本地 main 分支与远端 HEAD 的对齐状态，防范因代码版本冲突或未同步导致打包了“带病”或“过期”版本。
- **打包签名与发布附件极速整理 (Optimized Artifact Collection)**：深度重构了发布阶段打包二进制文件的自动收集与签名校验流，处理 Universal 应用、updater 更新包和最新 manifest 时更加安全流畅，减少由于平台环境差异引发的流程挂起。

## 修复与稳定性

- **工作流卡片状态融合**：精细打磨了在极度复杂计划树场景下 WorkflowEngine 执行块的自我去重算法，使得步骤转换更加干练。
- **思考过程折叠去噪**：继续隐藏了多处不必要的全局滚动条和视觉边框噪声，界面进一步精简扁平。
- **高覆盖自动化 UI 校验**：新增了完整的端到端 Playwright UI 稳定度与侧边栏连通性自动化测试。

## 验证覆盖

- **集成与端到端测试强化 (E2E & Integration Tests)**：
  - 新增 `tests/e2e/chat-area-render-stability.spec.ts`：专项模拟极高频消息流追加，确保 ChatArea 绝无渲染白屏或状态崩溃故障；
  - 新增 `tests/e2e/sidebar-active-target.spec.ts`：全面覆盖工作区在多目标切换、多层激活状态下 Sidebar 的渲染联动鲁棒性；
  - 新增 `tests/node/web-research-guard.test.mjs`：覆盖事实特征匹配、递增搜索查询重构及强制防幻觉提示词组装的分支校验；
  - 新增 `tests/node/workflow-runtime-state.test.mjs`：覆盖 WorkflowEngine 在极端长任务恢复下的执行流扭转测试。
- **版本合规统一**：
  - 项目配置、应用描述及包配置文件中的版本号已统一校准更新至 `2.2.4`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.2.4_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.2.4_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.2.4_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.2.4_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.2.4_macOS_universal.zip`。
- 解压后把 `MAIN.app` 拖到 `Applications`。
- Finder 中对 `MAIN.app` 点击言，选择 `Open`。
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`。
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
