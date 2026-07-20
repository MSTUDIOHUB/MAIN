# 为 MAIN 做贡献

感谢你帮助 MAIN 成为更可靠、更易扩展的本地 Agent 工具。我们欢迎 Bug 修复、Provider 兼容、工具协议、测试、文档、无障碍与性能改进。

参与项目前请遵守 [行为准则](CODE_OF_CONDUCT.md)。安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，不要创建公开 Issue。

## 开始之前

1. 搜索现有 Issue 和 Pull Request，避免重复工作。
2. 小型修复可以直接提交 PR；较大的功能或架构调整请先开 Issue 说明目标、用户价值和边界。
3. 一次 PR 聚焦一个问题，不顺带重构无关模块。
4. 不要提交 API Key、Token、个人会话、真实用户数据、签名材料、构建产物或本机绝对路径。

## 本地开发

需要 Node.js 20+、Rust stable 和对应平台的 [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/MSTUDIOHUB/MAIN.git
cd MAIN
npm ci
npm run tauri dev
```

提交前至少运行：

```bash
npm run lint
npm run build
npm run test:workflow-assets
```

如果变更涉及 Rust、桌面交互或端到端流程，请再运行适用的验证：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:e2e
```

无法运行某项验证时，请在 PR 中说明命令和原因。

## 架构约束

- TypeScript 生产工作流负责用户意图、计划、模型循环、恢复策略和可见状态。
- Rust 负责已经接入统一边界的文件、Shell、PTY、网络、进程与持久化机制校验。
- `src-tauri/src/runtime/` 和 Harness 当前用于 Trace、Replay、Eval 与一致性验证，不是第二套生产 Agent 循环。
- UI 不应从助手措辞或 stderr 猜测生命周期状态。
- 保持 Provider 中立：不要只为单一模型名、语言或端点硬编码策略。
- 权限、路径、破坏性范围、外部授权和真实完成证据是硬边界，不能为了提高成功率而跳过。

更详细的所有权规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [docs/TRUSTED_EXECUTION.md](docs/TRUSTED_EXECUTION.md)。

## 测试要求

- 在拥有缺陷的最低一致边界增加回归测试。
- 不要为了让新实现通过而静默修改原有期望；若契约确实改变，请在 PR 中解释。
- Provider 改动应考虑本地 OpenAI-compatible 服务、原生工具调用、文本回退、流式与非流式响应。
- UI 改动应检查 light、dark 和 black 三种主题，以及 hover、disabled、selected、focus、Diff、终端和弹窗状态。

## 使用 AI 辅助贡献

允许使用 Codex 或其他 AI 工具协助开发。提交者仍需：

- 理解并能解释最终改动；
- 人工检查安全、许可证和敏感信息；
- 运行与风险相称的验证；
- 对提交内容和后续维护负责。

请不要把未经审阅的大规模生成代码直接提交到项目。

## Pull Request 清单

- [ ] PR 说明了问题、解决方式和明确的不在范围内事项。
- [ ] 变更保持在正确的架构所有权边界内。
- [ ] 已增加或更新必要测试与文档。
- [ ] 已运行并记录相关验证。
- [ ] 没有提交密钥、个人数据、本地状态或构建产物。
- [ ] 用户可见变化包含截图或其他可核验证据（如适用）。

提交贡献即表示你同意按照项目的 [Apache-2.0 许可证](LICENSE) 提供该贡献。
