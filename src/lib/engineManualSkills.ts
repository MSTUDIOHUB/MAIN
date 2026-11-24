import type { SkillCatalogEntry } from "./agentSkills";

export type EngineManualPresetId = "unity6" | "tuanjie" | "ue6_verse";

interface BuiltinEngineSkillSpec {
  readonly presetId: EngineManualPresetId;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly content: string;
}

const BUILTIN_ENGINE_NAVIGATOR_SKILLS: Record<EngineManualPresetId, BuiltinEngineSkillSpec> = {
  unity6: {
    presetId: "unity6",
    id: "builtin:engine-manual:unity6-navigator",
    name: "unity6-manual-navigator",
    description:
      "Unity 6 (6000.x) 版本红线与代码手册协同导航：规范 Awaitable、FindFirstObjectByType、linearVelocity、URP RenderGraph 用法，指导按需调用 knowledge_search 与 Unity MCP 工具。",
    triggers: ["unity", "unity6", "6000", "monobehaviour", "awaitable", "urp", "rendergraph", "csharp"],
    content: `---
name: unity6-manual-navigator
description: Unity 6 (6000.x) 代码规范、版本红线与知识库/MCP工具协同路由指南
---

# Unity 6 (6000.x) 开发规范与工具协同准则

## 1. 知识库、Skill 与 MCP 工具职责边界（省 Token 与防干扰纪律）
- **查静态 API 签名/用法 → 用 \`knowledge_search\`**：
  - 当前已绑定 **Unity 6 代码手册知识库**（采用零首轮预塞模式保护 KV Cache）。
  - 编写或修改涉及不确定的 Unity 6 API、新包接口（如 InputSystem、UI Toolkit、Netcode、RenderGraph、Awaitable）时，**先调用 \`knowledge_search({ query: "类名或方法名" })\`**。
  - 优先核对已安装的包版本。打开网络搜索时，可用 \`allow_web_fallback: true\` 让本地正文和官方目录未命中的查询走搜索服务。
- **查/改实时工程场景与日志 → 用 Unity MCP 工具**：
  - 使用已绑定的 \`unity_mcp_scene\` 和 \`unity_mcp_console\` 观察实时场景与报错。需要其他编辑器能力时，用 \`tool_search\` 查看已准入的工具和参数。
  - 纯 C# 脚本逻辑编写直接用 \`read_file\` / \`replace_in_file\` / \`write_file\`，不要无故轮询 MCP。

## 2. Unity 6 强制版本红线（严禁混用旧版过时 API）
1. **对象查找**：
   - 严禁使用已废弃的 \`Object.FindObjectOfType<T>()\` 和 \`Object.FindObjectsOfType<T>()\`。
   - 必须使用 \`Object.FindFirstObjectByType<T>()\`、\`Object.FindAnyObjectByType<T>()\` 或 \`Object.FindObjectsByType<T>(FindObjectsSortMode.None)\`。
2. **刚体物理**：
   - 使用 \`rigidbody.linearVelocity\` 替代过时的 \`rigidbody.velocity\`；使用 \`linearDamping\` / \`angularDamping\` 替代 \`drag\` / \`angularDrag\`。
3. **异步与协程**：
   - 优先使用 Unity 6 原生 \`Awaitable\`（\`Awaitable.NextFrameAsync\`、\`Awaitable.WaitForSecondsAsync\`、\`Awaitable.FixedUpdateAsync\`），并始终传入 \`destroyCancellationToken\`。
4. **URP 17 渲染管线**：
   - 自定义 \`ScriptableRenderPass\` 必须实现 \`RecordRenderGraph(RenderGraph renderGraph, ContextContainer frameData)\`，不要编写已废弃的 \`Execute(ScriptableRenderContext, ref RenderingData)\`。
`,
  },
  tuanjie: {
    presetId: "tuanjie",
    id: "builtin:engine-manual:tuanjie-navigator",
    name: "tuanjie-manual-navigator",
    description:
      "团结引擎 (Tuanjie Engine) 版本红线与代码手册协同导航：规范微信小游戏 (WeChatWASM)、OpenHarmony 鸿蒙、HMI 车机及 Tuanjie GI 接口，指导按需调用 knowledge_search 与 MCP 工具。",
    triggers: ["团结引擎", "tuanjie", "微信小游戏", "wechatwasm", "openharmony", "鸿蒙", "车机", "hmi"],
    content: `---
name: tuanjie-manual-navigator
description: 团结引擎 (Tuanjie Engine) 代码规范、平台专属 API 与知识库/MCP工具协同路由指南
---

# 团结引擎 (Tuanjie Engine) 开发规范与工具协同准则

## 1. 知识库、Skill 与 MCP 工具职责边界
- **查团结引擎专属 API / 平台手册 → 用 \`knowledge_search\`**：
  - 当前已绑定 **团结引擎代码手册知识库**。
  - 涉及微信小游戏、OpenHarmony、HMI、Auto Streaming 或 Tuanjie GI 时，核对当前项目版本、已安装包或匹配版本的官方签名。
- **查/改实时工程场景与日志 → 用 MCP 工具**：
  - 仅在需要检视场景、Prefab 或读取编辑器日志时调用 MCP 工具；不要将国际版 Unity 6 独有 API（如 \`UnityEngine.Awaitable\`）混入团结引擎 2022 LTS 基线工程。

## 2. 团结引擎强制版本与平台红线
1. **与 Unity 6 的基线区分**：
   - 团结引擎基于定制 2022 LTS 演进，默认**不包含** Unity 6 的 \`UnityEngine.Awaitable\`；异步逻辑应使用 \`Coroutine\`、\`Addressables\` 异步句柄、\`UniTask\` 或平台 SDK 回调。
2. **微信小游戏 (Instant Game / WebGL) 红线**：
   - 严禁使用阻塞式同步文件 IO 或多线程 \`System.Threading.Thread\`；资源加载必须使用异步流式接口（\`Addressables\` / \`AssetBundle.LoadFromFileAsync\` / \`UnityWebRequest\`）。
   - 微信专属代码先核对当前安装版本支持的子平台宏。团结 1.11 手册列出 \`MINIGAME_SUBPLATFORM_WEIXIN\`，\`UNITY_WEBGL\` 覆盖通用 Web 平台。
3. **OpenHarmony (开源鸿蒙) 红线**：
   - 鸿蒙原生桥接使用 \`OpenHarmonyJSClass\` / \`OpenHarmonyJSObject\`，并使用 \`#if TUANJIE_OPENHARMONY || UNITY_OPENHARMONY\` 宏保护。
`,
  },
  ue6_verse: {
    presetId: "ue6_verse",
    id: "builtin:engine-manual:ue6-verse-navigator",
    name: "ue6-verse-navigator",
    description:
      "UE6 / UEFN Verse 语言红线与代码手册协同导航：规范 <decides><transacts> 失败上下文、sync/race/rush 并发原语及 creative_device API，指导按需调用 knowledge_search。",
    triggers: ["verse", "ue6", "uefn", "unreal", "creative_device", "decides", "suspends", "transacts"],
    content: `---
name: ue6-verse-navigator
description: UE6 / UEFN Verse 语言规范、并发/失败语义红线与知识库协同路由指南
---

# UE6 / UEFN Verse 开发规范与工具协同准则

## 1. 知识库与工具协同边界
- **查 Verse 语法与模块 API → 用 \`knowledge_search\`**：
  - 当前已绑定 **UE6 / UEFN Verse 代码手册知识库**。
  - 在调用 \`/Fortnite.com/Devices\`、\`/Fortnite.com/Characters\`、\`/Verse.org/Simulation\`、\`/Verse.org/SpatialMath\`、\`/Verse.org/SceneGraph\` 中的类、事件或方法前，**必须先调用 \`knowledge_search\` 核对精确签名与效果修饰符（Effect Specifiers）**。
  - 遇到新发布的 UEFN 设备或 SceneGraph 接口时，可传 \`allow_web_fallback: true\` 穿透 Epic 官方文档抓取最新定义并沉淀入库。

## 2. Verse 语言强制语法红线（严禁混入 C++/Python/蓝图臆造语法）
1. **变量声明与修改**：
   - 默认绑定不可变：\`Count : int = 0\` 或 \`Count := 0\`。
   - 可变变量必须加 \`var\`，且赋值修改必须加 \`set\`：\`var Score : int = 0\` → \`set Score = Score + 1\`（或 \`set Score += 1\`）。
2. **失败上下文 (\`<decides><transacts>\`)**：
   - 数组索引 \`Arr[Index]\`、Map 查找 \`Map[Key]\`、可空解包 \`MaybeVal?\`、比较运算都是可失败表达式，**必须放在 \`if (...)\`、\`for (...)\` 或声明了 \`<decides>\` 的函数内**，严禁在普通语句中直接写 \`Item := Arr[0]\`。
3. **结构化并发 (\`<suspends>\`)**：
   - 调用 \`Sleep()\` 或 \`.Await()\` 的函数必须标注 \`<suspends>\`。
   - 区分并发原语：\`sync:\`（等待全部分支完成）、\`race:\`（任一完成即取消其余分支）、\`rush:\`（任一完成即继续，其余分支后台继续）、\`branch:\`（派生非阻塞协程）、\`spawn{ Func() }\`（从非异步函数启动异步任务）。
`,
  },
};

function stableSkillHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getBuiltinEngineNavigatorSkills(
  activePresetIds: readonly string[],
): SkillCatalogEntry[] {
  const seen = new Set<string>();
  const entries: SkillCatalogEntry[] = [];
  for (const rawId of activePresetIds) {
    const presetId = String(rawId || "").trim().toLowerCase() as EngineManualPresetId;
    if (!presetId || seen.has(presetId) || !(presetId in BUILTIN_ENGINE_NAVIGATOR_SKILLS)) {
      continue;
    }
    seen.add(presetId);
    const spec = BUILTIN_ENGINE_NAVIGATOR_SKILLS[presetId];
    entries.push(
      Object.freeze({
        id: spec.id,
        name: spec.name,
        description: spec.description,
        source: "panel" as const,
        content: spec.content,
        entryPath: null,
        basePath: null,
        triggers: Object.freeze([...spec.triggers]),
        version: stableSkillHash(spec.content),
        allowImplicitInvocation: true,
        supportingFiles: Object.freeze([]),
      }),
    );
  }
  return entries;
}
