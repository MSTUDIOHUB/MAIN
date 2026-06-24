# 调试分析：聊天区模型自言自语 & Capsule 不更新问题

## 一、问题症状

1. **ChatArea 显示模型自言自语**：大量模型内部推理/思考文字出现在聊天界面
2. **ExecutionCapsule 不更新**：在模型生成过程中，Capsule 没有显示任何进展内容

## 二、根因分析

### 问题 1：模型自言自语泄漏到 ChatArea

**数据流梳理：**

```
模型生成 → streamChatCompletion → fetchLLMStream → callbacks.onStreamToken(token)
  → workflowEngine.onStreamToken → streamBuffer.append(token)
    → thinkingInterceptor.feed(token)  [仅过滤 <thinking/> 等标签]
    → 累积 agent buffer 写入 taskFlow agent block
  → onStreamDone → thinkingInterceptor.flush() → 写入 taskFlow
  → onAssistantFinalText → 最终写入 agent block content
```

**泄漏路径：**

1. **StreamingThinkingInterceptor** 只能识别 XML 标签（`<thinking>`、`<thought>` 等），遇到**裸文本推理**（无前缀标签）时全部作为 "agent content" 放行
2. `onStreamToken` 将拦截后的文本直接写入 `taskFlow` agent block
3. `AgentContentBlock` 渲染时用 `sanitizeAssistantDisplayContent()` 处理，但该函数仅剥除 XML 标签、工具块、残留协议，**不检测泄漏推理**
4. `normalizeAssistantTurn` 虽有 `extractLeakedReasoningPrelude` / `extractLeakedReasoningTail` 的检测逻辑，但**仅在流结束后**用于后端决策（如 `reasoning_dominated_recovery`），不回流更新 `taskFlow`

**日志证据：**
- `agent.stream_done: visibleChars: 8740, providerReasoningChars: 8740` — 全部为推理
- `agent.normalized_turn: visibleChars: 8738, hiddenThoughtChars: 8255` — 归一化后仍保留 8738 可见字符

**核心问题：流式输出过程中缺少泄漏推理检测/清理**

### 问题 2：Capsule 无内容更新

**数据流：**

```
Capsule 显示文本 = deriveDynamicFirstPersonText(turn, blocks, agentStatus, language)
```

`deriveDynamicFirstPersonText` 按优先级检查：
1. 是否有运行中的工具 → 生成动态说明
2. 是否等待审批 → 生成静态模板
3. 是否有用户选项 → 生成提示
4. 是否有流式 thought 块 → 提取最后一句话
5. 是否有流式 agent block → 生成静态模板 `"我正在为您整理详细的执行进展说明..."`
6. **均无 → 返回空字符串 `""`**

**根因：** 模型全部输出推理内容（进入 `reasoning_content`），未产生任何工具调用，也未生成 agent block（或内容为空）。上述所有条件都不满足，函数返回空字符串。

同时，`store.normalizedStreamState.hiddenThought` 虽积累了 8255 字符的推理内容，但 `deriveDynamicFirstPersonText` **完全未检查** hidden thought 中的数据。

**日志证据：**
- `store.reasoning_suppressed: chars: 8255` — 推理被折叠/隐藏
- `agent.reasoning_suppressed: chars: 8740` — 推理内容全部被隐藏

**核心问题：Capsule 文本生成忽略了 hiddenThought 中的推理信息**

## 三、修复方案

### Fix 1: ChatArea 泄漏推理过滤

在 `AgentContentBlock` 渲染逻辑中，对 `sanitizeAssistantDisplayContent` 的输出增加泄漏推理检测：

1. **新增函数** `stripLeakedReasoning(text)` — 复用 `normalizedTurn.ts` 中的 `LEAKED_REASONING_MARKERS` 和 `LEAKED_REASONING_TAIL_MARKERS` 检测并剥离泄漏推理段落
2. **修改 `AgentContentBlock`** — 在渲染前调用 `stripLeakedReasoning(sanitizeAssistantDisplayContent(rawContent))` 进行二次过滤

### Fix 2: Capsule 支持 hiddenThought 回退

修改 `deriveDynamicFirstPersonText` 函数：

1. 新增参数 `hiddenThought: string`（从 store 传入 `currentTurnState.hiddenThought`）
2. 在现有条件全部不满足时，检查 `hiddenThought` 是否有内容
3. 如有，调用 `cleanAndExtractLastThoughtSentence` 从隐藏推理中提取一句话作为 Capsule 展示文本

### Fix 3: ChatArea 传入 hiddenThought

在 `ChatArea.tsx` 中，将 `currentTurnState.hiddenThought` 通过 props 传递给 Capsule 相关组件，确保 `deriveDynamicFirstPersonText` 能获取到隐藏推理数据。

## 四、关键改动文件

| 文件 | 改动 |
|------|------|
| `src/lib/normalizedTurn.ts` | 新增 `stripLeakedReasoning` 函数，复用现有正则 |
| `src/components/ChatArea.tsx` | `AgentContentBlock` 增加泄漏推理过滤；传递 `hiddenThought` |
| `src/lib/capsuleStagingHelper.ts` | `deriveDynamicFirstPersonText` 新增 `hiddenThought` 参数及回退逻辑 |
