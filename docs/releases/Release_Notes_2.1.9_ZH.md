# MAIN 2.1.9 中文 Release Note

版本跨度：2.0.8 -> 2.1.9  
整理日期：2026-05-27

MAIN 2.1.9 是在 2.0.8 之后的一轮大版本整理发布。这一段时间的改动范围很大，因此这份说明不再按细项展开，而是按“亮点”收束：重点聚焦在“Plan / Execute 主链路重做”“聊天区解释与过程展示明显变清楚”“图像生成能力正式接入”“本地发布与桌面构建流程更完整”这四条主线上。相比 2.0.8 主要围绕计划恢复、过程归档和工具结果反馈的继续收敛，2.1.9 更接近一次可感知的阶段升级。

## 主要更新

### 亮点 1：Plan / Execute 主链路经历了一轮真正的重做

- Plan 模式、批准后执行、恢复继续执行、只读收敛、真实失败判断和计划收尾逻辑都做了系统性整理，整体执行链路比 2.0.8 明显更稳。
- `design.md`、计划证据、runtime 任务状态和恢复提示之间的关系被重新梳理，长任务、多轮任务和中断恢复时更不容易跑偏。
- 新增 repo map、`browser_evaluate`、计划起草写文件、patch 执行流等能力，代理在“理解项目结构 -> 形成方案 -> 落地修改 -> 验证结果”这条链上更完整。

### 亮点 2：聊天区的解释、进度和工具反馈终于更像一个成型产品

- 新增 explanation capsule、进度叙述、工具分组与内容预览，复杂回合里“现在在做什么”“为什么这么做”“结果是什么”更容易一眼看懂。
- ChatArea、转录分组、block 可见性抑制、tool summary 和 Markdown 渲染都做了较大重构，明显减少了长日志、重复 narration 和信息层级混乱的问题。
- 文件大纲、多语言代码阅读辅助和文档读取能力同步增强，聊天区对真实工程内容的承载能力更强。

### 亮点 3：图像生成能力正式进入主线

- 新增 Hugging Face Space 图像生成引擎支持，图像能力不再只是占位入口，而是进入可用状态。
- 支持远程输出保存、图像提示词编辑和生成冷却控制，图像生成从“能触发”提升到“能反复使用”。
- 对应的设置与工作流体验也一起补齐，方便后续继续扩展更多生成后端。

### 亮点 4：本地发布、桌面构建和跨平台脚本补齐了关键缺口

- 本地构建脚本逐步改为直接走 Node / 本地 CLI 路径，减少 shell 环境差异带来的失败。
- 补齐 macOS / Windows 的本地发布脚本、Windows 便携发布自动化、跨平台图标生成和签名 key 解析改进。
- 对外发布这条链路已经更适合持续迭代，后续继续做桌面发版时阻力会比 2.0.8 小很多。

## 修复与稳定性

- 改进 Ollama `/v1` 加载失败回退、provider compatibility、streaming 行为和本地模型阈值策略，日常对话与执行更稳。
- 收紧 orchestrator safety gating、intent history tracking 和工具能力过滤，降低错误工具调用、上下文漂移和计划跑偏风险。
- 优化 session restore、approval flow、plan evidence recovery 与 read file sanitization，恢复后继续执行的连贯性更好。
- 持续压缩聊天噪声与过程冗余，让复杂任务里的关键信息更集中。

## 验证覆盖

- 新增或更新 Node 测试，覆盖 `planMaterialization`、`planExecutionRecovery`、`planReadOnlyConvergence`、`executeRecovery`、`chat display`、`harness gating`、`workflowModels`、`replyOptions`、`repoMapTools`、`imageStudio` 相关链路。
- 新增或更新 E2E 测试，覆盖 `plan-flow`、`real-omlx-plan-flow`、`cloud-tool-protocol`、`read-context-segmented`、`capsule-process-folding`、`stream-error-recovery` 等关键场景。
- 版本号与桌面端 bundle 配置已同步到 `2.1.9`，便于沿当前公开下载仓库和 UpdateFeed 仓库流程继续发布。

## 下载说明

- macOS Apple Silicon 用户：下载 `MAIN_2.1.9_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_2.1.9_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_2.1.9_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

### macOS 未签名版本下载与打开方法

- 当前 macOS 版本仍属于未完成 Apple Developer 正式签名 / notarization 的分发状态，下载后首次打开时系统可能拦截。
- Apple Silicon 机型优先下载并解压 `MAIN_2.1.9_macOS_apple_silicon.zip`；不确定机型时下载并解压 `MAIN_2.1.9_macOS_universal.zip`。
- 解压后把 `MAIN.app` 拖到 `Applications`。
- 在 Finder 里对 `MAIN.app` 点击右键，选择 `Open`。
- 如果系统仍拦截，到 `System Settings > Privacy & Security` 里点击 `Open Anyway`。
- 如果看到 “damaged and can't be opened” 一类提示，可在终端运行 `xattr -dr com.apple.quarantine /Applications/MAIN.app` 后再尝试打开。
