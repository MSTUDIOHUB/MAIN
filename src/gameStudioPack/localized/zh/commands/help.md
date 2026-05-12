---
name: help
description: "分析当前已完成内容和你的问题，判断下一步该做什么；适合“我该做什么”“卡住了”“不知道下一步”。"
argument-hint: "[可选：你刚完成的内容，例如 'finished design-review' 或 'stuck on ADRs']"
user-invocable: true
allowed-tools: Read, Glob, Grep
context: |
  !echo "=== Live Project State ===" && echo "Stage: $(cat production/stage.txt 2>/dev/null | tr -d '[:space:]' || echo 'not set')" && echo "Latest sprint: $(ls -t production/sprints/*.md 2>/dev/null | head -1 || echo 'none')" && echo "Session state: $(head -5 production/session-state/active.md 2>/dev/null || echo 'none')"
model: haiku
---

# Studio 帮助 — 下一步做什么？

此技能为只读：它只报告发现，不写入文件。

此技能会判断你在游戏开发流水线中的当前位置，并告诉你下一步该做什么。它是**轻量级**定位，不是完整审计。若需要完整缺口分析，请使用 `/project-stage-detect`。

---

## 步骤 1：读取目录

读取 `.claude/docs/workflow-catalog.yaml`。这是所有阶段的权威清单，包含每个阶段的步骤顺序、必需/可选状态，以及用于判断完成情况的产物 glob。

---

## 步骤 1b：查找未进入目录的技能

读取目录后，使用 Glob 扫描 `.claude/skills/*/SKILL.md`，取得完整的已安装技能列表。对每个文件，提取 frontmatter 中的 `name:` 字段。

将这些名称与目录中的 `command:` 值对比。任何没有出现在目录命令中的技能都是**未编入目录的技能**：它仍然可以使用，但不属于阶段门控工作流。

把这些内容收集到步骤 7 的输出页脚中：

```markdown
### 也已安装（不在工作流中）
- `/skill-name` — [来自 SKILL.md frontmatter 的 description]
- `/skill-name` — [description]
```

只有在至少发现一个未编入目录的技能时才显示这块内容。最多展示 10 个，并按用户当前阶段挑选最相关的技能，例如生产阶段优先 QA 技能，生产/打磨阶段优先团队技能。

---

## 步骤 2：判断当前阶段

按以下顺序检查：

1. **读取 `production/stage.txt`**：如果文件存在且有内容，它就是权威阶段名。将它映射到目录阶段 key：
   - "Concept" → `concept`
   - "Systems Design" → `systems-design`
   - "Technical Setup" → `technical-setup`
   - "Pre-Production" → `pre-production`
   - "Production" → `production`
   - "Polish" → `polish`
   - "Release" → `release`

2. **如果缺少 stage.txt**，则从产物推断阶段（取最靠后的匹配）：
   - `src/` 有 10 个以上源码文件 → `production`
   - `production/stories/*.md` 存在 → `pre-production`
   - `docs/architecture/adr-*.md` 存在 → `technical-setup`
   - `design/gdd/systems-index.md` 存在 → `systems-design`
   - `design/gdd/game-concept.md` 存在 → `concept`
   - 什么都没有 → `concept`（新项目）

---

## 步骤 3：读取会话上下文

如果 `production/session-state/active.md` 存在，读取它并提取：

- 最近正在处理什么
- 进行中的任务或未解决问题
- STATUS 区块中的当前 epic/feature/task（如果存在）

这能告诉你用户刚完成了什么，或卡在什么地方，用于个性化输出。

---

## 步骤 4：检查当前阶段的步骤完成度

对当前阶段中的每个步骤（来自目录）进行判断。

### 基于产物的检查

如果步骤有 `artifact.glob`：

- 使用 Glob 检查是否存在匹配文件
- 如果指定了 `min_count`，确认匹配数量不少于该值
- 如果指定了 `artifact.pattern`，使用 Grep 确认匹配文件中存在该模式
- **完成** = 满足产物条件
- **未完成** = 缺少产物或未找到模式

如果步骤只有 `artifact.note`（没有 glob）：

- 标记为 **MANUAL**：无法自动判断，需要询问用户

如果步骤没有 `artifact` 字段：

- 标记为 **UNKNOWN**：无法追踪完成情况，例如可重复执行的实现工作

### 特例：production 阶段读取 `sprint-status.yaml`

当前阶段是 `production` 时，在做任何基于 glob 的 story 检查前，先检查 `production/sprint-status.yaml`。如果它存在，直接读取它；它是权威来源。

- `status: in-progress` 的 Story → 作为“正在进行”展示
- `status: ready-for-dev` 的 Story → 作为“下一项”展示
- `status: done` 的 Story → 计为完成
- `status: blocked` 的 Story → 连同 `blocker` 字段作为阻塞项展示

这样能得到精确的逐 Story 状态，不需要扫描 Markdown。对于 `implement` 和 `story-done` 步骤，跳过 glob 产物检查，以 YAML 为准。

### 特例：`repeatable: true`（非 production）

对于 production 之外的可重复步骤，例如 “System GDDs”，产物检查只能说明“已经做过一些工作”，不能说明“完全结束”。这类步骤需要单独标注：展示检测到的内容，同时说明它可能仍在持续进行。

---

## 步骤 5：定位当前位置并识别下一步

根据完成度数据判断：

1. **最后一个确认完成的步骤**：最靠后的已完成必需步骤
2. **当前阻塞项**：第一个未完成的必需步骤，也就是用户下一步必须处理的事
3. **可选机会**：当前阻塞项之前或同时可以完成的未完成可选步骤
4. **后续必需步骤**：当前阻塞项之后的必需步骤，用“接下来会遇到”帮助用户预判

如果用户提供了参数，例如 “just finished design-review”，即使产物检查不够明确，也可据此推进到该步骤之后。

---

## 步骤 6：检查进行中的工作

如果 `active.md` 显示当前有活跃任务或 epic：

- 在顶部明显展示：“看起来你正在处理 [X]”
- 建议继续它，或确认它是否已经完成

---

## 步骤 7：输出结果

保持**简短直接**。这是快速定位，不是报告。

```markdown
## 当前位置：[阶段标签]

**进行中：** [来自 active.md，如果有]

### ✓ 已完成
- [已完成步骤名]
- [已完成步骤名]

### → 下一项（必需）
**[步骤名]** — [说明]
命令：`[/command]`

### ~ 也可处理（可选）
- **[步骤名]** — [说明] → `/command`
- **[步骤名]** — [说明] → `/command`

### 之后会遇到
- [下一个必需步骤名] (`/command`)
- [下一个必需步骤名] (`/command`)

---
接近 **[当前阶段] → [下一阶段]** 阶段门时，运行 `/gate-check`。
```

**格式规则：**

- `✓` 表示确认完成
- `→` 表示当前必需下一步（只显示一个，也就是第一个阻塞项）
- `~` 表示当前可选步骤
- 命令用行内反引号展示
- 如果某个步骤没有命令，例如 “Implement Stories”，说明该做什么，而不是强行展示斜杠命令
- 对 MANUAL 步骤，询问用户：“我无法判断 [step] 是否完成，它已经完成了吗？”

结论：**COMPLETE** — 已识别下一步。

---

## 步骤 8：阶段门提醒（接近时）

检查用户是否可能接近阶段门：

- 如果当前阶段的所有必需步骤都已完成或接近完成，添加：“你已经接近 **[当前阶段] → [下一阶段]** 阶段门。准备好后运行 `/gate-check`。”
- 如果仍有多个必需步骤未完成，跳过阶段门提醒，因为它暂时不相关。

---

## 步骤 9：升级路径

如果用户看起来卡住或困惑，在建议后添加：

```markdown
---
需要更多细节？
- `/project-stage-detect` — 完整缺口分析，列出所有缺失产物
- `/gate-check` — 正式检查是否可以进入下一阶段
- `/start` — 从头重新定位
```

只有当用户输入显示困惑时才展示这一段，例如 “I don't know”、“stuck”、“lost”、“not sure”。如果用户只是问 “what's next?”，不要展示。

---

## 协作协议

- **不要自动运行下一个技能。** 推荐它，让用户自己调用。
- **对 MANUAL 步骤要询问用户**，不要假设它完成或未完成。
- **匹配用户语气**：如果用户很焦虑，例如 “I'm totally lost”，要安抚并给一个动作，而不是列出六个选项。
- **只给一个主要建议**：用户离开时应该明确知道下一件该做的事。可选步骤和“之后会遇到”只是辅助上下文。
