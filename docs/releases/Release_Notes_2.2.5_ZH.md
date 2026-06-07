# MAIN 2.2.5 中文 Release Note

版本跨度：2.2.4 -> 2.2.5  
整理日期：2026-06-04

MAIN 2.2.5 是在 2.2.4 之后发布的一轮重量级更新版本。本次更新在继续深化网络核查机制的基础之上，引入了全新的“会话亲和性系统与独立图像工作室 (Image Studio) 会话管理”，并重构了其设置向导 UI；同时，实现了面向 **Unity、Godot、Unreal** 三大游戏引擎的“Game Studio MCP 智能路由”；另外，还在置顶控制台 (Top-Island) 中融合了精准的“待审阅工具联动”与“修改目标解析”，并创新性地引入了“只读工具重复限制 (READ_ONLY_REPEAT_LIMIT)”以扼制大模型死循环。这一版本在多模态工作流、多引擎开发适配及执行防护上均完成了里程碑式的跃升。

## 主要更新

### 亮点 1：独立图像工作室 (Image Studio) 会话与 Affinity 亲和性系统

- **会话亲和性分类归属 (Session Mode Affinity)**：引入了全新的会话类型亲和性归纳系统。所有新建或加载的会话将自动根据所属功能区域（如通用聊天、图像工作室、游戏工作室等）进行分类和恢复，切换会话时自动绑定 Affinity，确保在不同功能模块间无缝切换，上下文精准恢复。
- **图像生图会话彻底隔离 (Isolated Image Sessions)**：实现了图像生成/编辑会话与常规开发/代码会话的独立物理隔离与专属状态管理，避免不同任务类型的消息流和状态在同一窗口中发生混杂。
- **图像工作室设置向导大修 (Image Studio Setup UI Overhaul)**：重构并美化了 Image Studio 的设置面板。支持对“本地图片服务 (Local Image Service)”与“HiDream 网页托管 (Web Fallback)”进行精细化配置；支持一键复制导入 MAIN 的本地模型配置；具备一键测试连接、扫描发现可用生图模型（如 Ollama、OMLX、OpenAI Compatible 图像模型）等功能，极大提升了多模态配置的易用性。

### 亮点 2：Game Studio 多引擎 MCP 智能路由与异步安全确认

- **Unity / Godot / Unreal MCP 优先路由 (Game Studio MCP Routing)**：将原有的 Unity 独占路由重构为多引擎智能路由。根据 `gameStudioRoutingContext` 自动感知当前的游戏引擎类型，并在向大模型呈现可用工具时，精准评分并优先注入对应引擎的 preferred/required MCP 专属工具集。
- **异步安全确认弹窗 (Async Safe Confirm)**：重构了本地打包、高敏感操作及自动审查等环节的系统二次确认。改用 Tauri 异步 dialog 确认组件 (`safeConfirmAsync`)，全面替换了会导致前端界面同步阻塞假死的传统同步 confirm，带来了更流畅的交互体验。

### 亮点 3：置顶控制台 (Top-Island) 待审阅工具联动与修改目标智能提取

- **置顶待审阅任务卡片 (Top-Island Approval UI Integration)**：针对需要用户审批的高敏感操作（如代码修改或终端命令执行），将其作为强交互待审核任务置顶到 App 控制台 (Top-Island) 中，便于用户直观把控。
- **修改目标智能提取 (deriveReviewToolTarget)**：新增了 Unified Diff 智能提取算法 (`summarizePendingPatchTarget`)。在审批代码修改（如 `apply_patch`）时，系统会自动解析 Diff 文本，自动提取出被修改的文件名称（如 `src/App.tsx +2`），并在置顶卡片上精准呈现目标标签，让用户的每一次“允许”或“拒绝”都清晰明了。

### 亮点 4：只读工具循环调用强力限制与聊天流视觉净化

- **只读工具防无限循环 (READ_ONLY_REPEAT_LIMIT)**：升级了 Repetition Guard 机制。当 Agent 在 `edit/chat/plan` 等模式下对同一个只读工具（如 `read_file`、`grep_search` 等）使用相同参数连续调用达到 **8 次**以上时，系统会自动拦截并强行触发 `READ_ONLY_REPEAT_LIMIT`，使用缓存数据注入的同时向大模型发出强力警示，要求其立即转向真实写操作、命令运行或给出明确的阻塞结论，彻底避免了因局部故障引发的死循环和 Token 暴涨。
- **阶段性分析块智能保留 (Substantive Conclusion Visibility)**：在 ChatArea 消息流中，若 Agent 产生多条中间只读反馈且 `enableCapsule` 开启时，系统会自动合并隐藏重复只读动作，但能智能识别并保留那些字符数较长或富含“阶段性总结/结论/根因分析/修复方案/阻塞/Risk”等实质性分析内容的 agent block，确保用户不会漏掉关键的排障心流。

## 修复与稳定性

- **Diff 实时改动视图优化**：优化了 `toolDiff` 及 Diff 视图的呈现流，修复了在实时修改代码期间 Diff 块预览可能短暂丢失或失效的潜在不连通现象。
- **更致密的自动化测试覆盖**：新增了 `tests/node/image-studio-sessions.test.mjs` 以及 `tests/e2e/top-island-execution-progress.spec.ts` 等专项测试。全量自动化集成测试已扩充至 699 项且完美通过（PASS 699/699）。
- **版本合规统一**：
  - 项目配置、应用描述及包配置文件中的版本号已统一校准更新至 `2.2.5`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.2.5_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.2.5_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.2.5_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.2.5_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.2.5_macOS_universal.zip`；
- 解压后把 `MAIN.app` 拖到 `Applications`；
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`；
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`；
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
