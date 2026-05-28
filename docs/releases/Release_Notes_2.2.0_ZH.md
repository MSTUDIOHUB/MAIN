# MAIN 2.2.0 中文 Release Note

版本跨度：2.1.9 -> 2.2.0  
整理日期：2026-05-28

MAIN 2.2.0 是在 2.1.9 之后的一轮重要版本升级。本次更新聚焦于进一步夯实大任务链路的稳定度与自治能力，核心改动收敛于四大主线：“计划断点续推与会话自动重构”“引入多级执行恢复与兜底防跑偏机制”“Agent 运行周期安全栅栏（Loop Safety）与失败归档”以及“执行恢复下的上下文强力压缩与卡片折叠展示优化”。相比 2.1.9 版本在交互和生成多模态上的拓展，2.2.0 更关注于代理在极端/恶劣执行场景下的自我修正、容错与阻断能力，极大提升了对真实工程场景中多轮长任务的承载与交付表现。

## 主要更新

### 亮点 1：支持计划断点续推与会话自动重构

- **工作区计划自动重构（Rehydrate Plan Sessions）：** 新增空会话/新会话启动时的自动重构机制。系统会自动识别当前工作区已有的计划工件（如 `.MAIN/plans/tasks.md` 等），自动解析并将历史已批准的任务状态重构至当前内存，快速进入可继续执行（resumable）的状态，免除人工重新指引的繁琐。
- **暂停/非活跃执行一键恢复（Resume Plan Action）：** 重构了计划面板（Plan Panel）与右侧控制面板（Right Panel）中的状态扭转逻辑。即便在执行被暂停（paused）或由于执行报错进入非活跃（idle/error）状态时，一键恢复按钮与快捷指令依然可见且可用。无需重新规划审批即可直接热唤醒执行状态。
- **拓展自然语言恢复意图识别（RESUME_PLAN_SEMANTIC_PATTERNS）：** 重构了意图分析与提取逻辑（`runIntent.ts` / `planStateHydration.ts`），显著增强了对如“继续完成计划方案”“恢复执行剩余任务”等中英文自然语言变体的识别率与匹配精度，使得断点恢复的语义连贯性更加智能。

### 亮点 2：首创多级执行恢复机制，阻断只读探索打转与盲目修改

- **仅限验证的恢复模式（`validation_only` 模式）：** 针对模型频繁“盲目修改不验证”的顽疾，当监测到模型针对同一目标文件连续进行多次修改（如 3 次以上）但从未进行运行验证时，强制将工具调用范围限制在纯验证工具（如 `run_command`、`browser_evaluate`），严禁继续写入或修改文件，并弹出强制性的中文警告，逼迫模型完成运行/测试验证。
- **补丁不匹配精准只读对齐（`patch_recovery_read` 模式）：** 当遇到 `apply_patch` 或 `replace_in_file` 补丁匹配失败（如 `search_text not found`）的异常时，系统会自适应限制工具范围：**仅允许且只能调用一次** `read_file` 重新读取该错误文件以拉取最新上下文，杜绝在旧上下文中反复发起注定失败的盲目重试。
- **只读探索额度预警与引导切换（`repeated_cached_read` 机制）：** 自动侦测模型的只读循环行为。如果模型在复杂任务中过度消耗只读工具（如 `read_file`、`grep_search` 等）而长时间未发起实际修改，系统将自动触发额度拦截，禁用无意义的文件探索，并强制引导模型切换至“写入/验证”或在对话状态下自动暂停以直接回答用户，有效避免 Token 的无效空转与死循环。

### 亮点 3：全面升级 Agent 运行周期安全栅栏与失败证据归档

- **模式专属的运行周期上限（Configurable Loop Iterations）：** 将聊天对话（Chat Respond，默认 25 步）和计划执行（Plan Execute，默认 50 步）的迭代周期限制进行了深度分离，并支持精细化限制配置，更加契合不同的工作流程强度。
- **最大迭代终点保护（`MAX_STEPS_FINAL_TEXT` 机制）：** 在达到最大步数上限（如 25 或 50 步）的最后一轮，系统会自动注入强约束提示，切断所有工具调用，并强制引导模型输出清晰的“收尾说明”，向用户完整陈述哪些任务已完成、哪些尚未完成，实现优雅降级与完美收卷。
- **本地模型空响应暂停（Empty Model Response Pause）：** 自动监控并侦测模型生成结果。针对本地模型可能偶发、反复输出空内容（Empty Completion）的情况，当连续发生多次空响应时，主动触发暂停并向用户输出友好说明，避免无休止的无效请求。
- **精准的失败证据归档（Failed Evidence Reconcile）：** 细化了对失败执行的证据溯源（`failedEvidenceResults`），全面追踪首个失败步骤的工具名称、调用目标、当前生命周期状态以及底层报错根因，为后续的自动恢复与排错提供了坚实的数据支撑。

### 亮点 4：上下文智能精准压缩与轮次进度折叠体验优化

- **强力上下文压缩算法（Aggressive Context Compaction）：** 针对进入执行恢复（Execute Recovery）的长对话场景，设计了专用的上下文裁剪逻辑（`compactContextForExecuteRecovery`）。在严格限制 Token 预算的前提下，智能裁剪掉历史中过于庞大的冗余输出，并保证每一组“助手调用 - 工具反馈”的成对完整性，坚决避免出现“孤立的 Tool 消息”或上下文溢出。
- **折叠轮次下的有效进度保持：** 优化了 `ChatArea.tsx` 的折叠与展示逻辑。在复杂回合的长任务中，即便轮次已折叠，展开的面板依然能实时渲染清晰的高可读性执行进度条（Turn Progress Items），降低了视觉干扰，提升了整体的信息层级。

## 修复与稳定性

- **Ollama 兼容性与加载兜底：** 完善了 Ollama 模型 `/v1` 接口加载失败时的退避回退逻辑与 Capsule UI 的状态更新。
- **语言匹配度纠正（Response Language Policy）：** 引入了更灵敏的回复语言失配检测与强制覆盖解析，能针对诸如“请用英文回复”等显式语言切换指令，在后续多轮对话中保持精准的语言偏好，并智能忽略纯代码内容的干扰。
- **路径与资源解析增强：** 优化了跨平台构建（Tauri CLI / Vite / TS）在 Node 环境下的执行健壮性，提升了本地脚本对环境签名 Key 和应用图标资源的解析稳定性。
- **审批逻辑稳定性（Approval Flow）：** 改进并稳定了混合工具调用回复下的审批流逻辑，防止在特定的复杂分支中出现状态丢失。

## 验证覆盖

- **核心单元与集成测试（Unit & Integration Tests）：**
  - 新增 `tests/node/plan-state-hydration.test.mjs`：全面覆盖工作区计划状态重构、空会话自动载入及自然恢复语言提取。
  - 新增 `tests/node/execute-recovery.test.mjs`：深入覆盖 `validation_only` 验证模式、`patch_recovery_read` 补丁匹配对齐、只读额度预警拦截及上下文智能裁剪算法。
  - 新增 `tests/node/workflow-models.test.mjs`：覆盖多语言匹配政策、轮次有效进度状态计算、证据链对齐与去重。
  - 新增与更新 `tests/node/runtime-progress-ledger.test.mjs` 等进度账本测试。
- **版本合规统一：** package.json 与 tauri.conf.json 内部版本号及跨平台打包构建配置已同步校准至 `2.2.0`。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.2.0_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.2.0_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.2.0_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.2.0_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.2.0_macOS_universal.zip`。
- 解压后把 `MAIN.app` 拖到 `Applications`。
- Finder 中对 `MAIN.app` 点击右键，选择 `Open`。
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`。
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
