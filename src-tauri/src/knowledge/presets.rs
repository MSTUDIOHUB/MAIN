use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TocSeedEntry {
    pub symbol: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinReferenceDoc {
    pub slug: String,
    pub title: String,
    pub source_url: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineManualPreset {
    pub preset_id: String,
    pub name: String,
    pub description: String,
    pub engine_family: String,
    pub entry_url: String,
    pub toc_urls: Vec<String>,
    pub seed_urls: Vec<String>,
    pub official_domains: Vec<String>,
    pub search_site_filter: String,
    pub documentation_version: String,
    #[serde(skip_serializing)]
    pub builtin_toc_entries: Vec<TocSeedEntry>,
    #[serde(skip_serializing)]
    pub builtin_docs: Vec<BuiltinReferenceDoc>,
}

pub fn list_engine_manual_presets() -> Vec<EngineManualPreset> {
    vec![unity6_preset(), tuanjie_preset(), ue6_verse_preset()]
}

pub fn find_engine_manual_preset(preset_id: &str) -> Option<EngineManualPreset> {
    let normalized = preset_id.trim().to_ascii_lowercase();
    list_engine_manual_presets()
        .into_iter()
        .find(|preset| preset.preset_id == normalized)
}

fn unity6_preset() -> EngineManualPreset {
    let base = "https://docs.unity3d.com/6000.0/Documentation/ScriptReference/";
    EngineManualPreset {
        preset_id: "unity6".to_string(),
        name: "Unity 6 代码手册 (ScriptReference)".to_string(),
        description: "Unity 6 (6000.0) 官方脚本 API 手册，涵盖 Awaitable、Object.FindFirstObjectByType、Rigidbody.linearVelocity、URP RenderGraph 及核心运行时 API。".to_string(),
        engine_family: "unity6".to_string(),
        entry_url: format!("{base}index.html"),
        toc_urls: vec![
            format!("{base}docdata/toc.json"),
            "https://docs.unity3d.com/6000.0/Documentation/Manual/docdata/toc.json".to_string(),
        ],
        seed_urls: vec![
            format!("{base}MonoBehaviour.html"),
            format!("{base}GameObject.html"),
            format!("{base}Transform.html"),
            format!("{base}Object.FindFirstObjectByType.html"),
            format!("{base}Object.FindObjectsByType.html"),
            format!("{base}Awaitable.html"),
            format!("{base}Rigidbody.html"),
            format!("{base}Physics.html"),
            format!("{base}Time.html"),
            format!("{base}Coroutine.html"),
        ],
        official_domains: vec!["docs.unity3d.com".to_string()],
        search_site_filter: "site:docs.unity3d.com/6000.0/Documentation".to_string(),
        documentation_version: "Unity 6000.0".to_string(),
        builtin_toc_entries: vec![
            TocSeedEntry {
                symbol: "UnityEngine.Awaitable".to_string(),
                title: "Awaitable - Unity 6 Async/Await Coroutine Replacement".to_string(),
                url: format!("{base}Awaitable.html"),
            },
            TocSeedEntry {
                symbol: "UnityEngine.Object.FindFirstObjectByType".to_string(),
                title: "Object.FindFirstObjectByType - Unity 6 Scene Object Lookup".to_string(),
                url: format!("{base}Object.FindFirstObjectByType.html"),
            },
            TocSeedEntry {
                symbol: "UnityEngine.Object.FindObjectsByType".to_string(),
                title: "Object.FindObjectsByType - Unity 6 Batch Object Lookup".to_string(),
                url: format!("{base}Object.FindObjectsByType.html"),
            },
            TocSeedEntry {
                symbol: "UnityEngine.Rigidbody.linearVelocity".to_string(),
                title: "Rigidbody.linearVelocity - Unity 6 Physics Linear Velocity".to_string(),
                url: format!("{base}Rigidbody-linearVelocity.html"),
            },
            TocSeedEntry {
                symbol: "UnityEngine.Rendering.RenderGraphModule.RenderGraph".to_string(),
                title: "RenderGraph - Unity 6 URP/HDRP RenderGraph API".to_string(),
                url: "https://docs.unity3d.com/6000.0/Documentation/Manual/urp/render-graph.html".to_string(),
            },
        ],
        builtin_docs: vec![BuiltinReferenceDoc {
            slug: "unity6_core_api_reference".to_string(),
            title: "Unity 6 (6000.0) 核心 API 速查与破坏性更新对照手册".to_string(),
            source_url: format!("{base}index.html"),
            content: r#"# Unity 6 (6000.0) 核心 API 手册与版本规范

## 1. 对象查找 API (替代已废弃的 FindObjectOfType / FindObjectsOfType)
- `Object.FindFirstObjectByType<T>(FindObjectsInactive.Exclude)`：按类型查找首个匹配的场景对象（确定性排序，替代旧版 `FindObjectOfType<T>()`）。
- `Object.FindAnyObjectByType<T>(FindObjectsInactive.Exclude)`：最快速度查找任意一个匹配实例（不保证顺序）。
- `Object.FindObjectsByType<T>(FindObjectsInactive.Exclude, FindObjectsSortMode.None)`：批量查找所有匹配组件，默认不排序以避免开销（替代旧版 `FindObjectsOfType<T>()`）。

## 2. 物理系统 API 更新 (Rigidbody / Rigidbody2D)
- `Rigidbody.linearVelocity`：读写刚体的线性速度向量 `Vector3`（Unity 6 中旧属性 `Rigidbody.velocity` 已标记过时，应统一使用 `linearVelocity`）。
- `Rigidbody.linearDamping` / `Rigidbody.angularDamping`：替代旧版 `drag` 与 `angularDrag`。
- `Rigidbody2D.linearVelocity`：2D 刚体线性速度 `Vector2`。

## 3. Awaitable 异步编程模型 (UnityEngine.Awaitable)
Unity 6 原生提供轻量化、零额外 GC 分配的 `Awaitable` 类型，可直接配合 C# `async / await` 在 `MonoBehaviour` 生命周期中使用：
```csharp
using System.Threading;
using UnityEngine;

public class PlayerController : MonoBehaviour
{
    private async Awaitable Start()
    {
        await Awaitable.NextFrameAsync(destroyCancellationToken);
        await Awaitable.WaitForSecondsAsync(1.0f, destroyCancellationToken);
        await Awaitable.FixedUpdateAsync(destroyCancellationToken);
        await Awaitable.BackgroundThreadAsync();
        // 后台线程计算后切回主线程：
        await Awaitable.MainThreadAsync();
    }
}
```
- 关键点：始终传入 `this.destroyCancellationToken` 防止对象销毁后继续执行引发 `MissingReferenceException`。

## 4. URP 17 RenderGraph (ScriptableRenderPass)
- Unity 6 URP 默认启用 RenderGraph 管线，不再推荐重写旧版 `Execute(ScriptableRenderContext, ref RenderingData)`。
- 自定义 `ScriptableRenderPass` 应重写 `RecordRenderGraph(RenderGraph renderGraph, ContextContainer frameData)`：
  - 使用 `frameData.Get<UniversalResourceData>()` 和 `frameData.Get<UniversalCameraData>()` 获取帧资源与相机数据；
  - 使用 `renderGraph.AddRasterRenderPass<PassData>(...)` 构建渲染通道并声明纹理读写依赖。
"#.to_string(),
        }],
    }
}

fn tuanjie_preset() -> EngineManualPreset {
    let script_base = "https://docs.unity.cn/cn/tuanjiemanual/ScriptReference/";
    let manual_base = "https://docs.unity.cn/cn/tuanjiemanual/Manual/";
    EngineManualPreset {
        preset_id: "tuanjie".to_string(),
        name: "团结引擎代码手册 (Tuanjie Engine)".to_string(),
        description: "团结引擎 (Tuanjie Engine) 官方手册与脚本 API，涵盖微信小游戏 (WeChat MiniGame)、OpenHarmony 开源鸿蒙、HMI 车机、Tuanjie GI 与虚拟几何体等专属 API。".to_string(),
        engine_family: "tuanjie".to_string(),
        entry_url: format!("{manual_base}index.html"),
        toc_urls: vec![
            format!("{script_base}docdata/toc.json"),
            format!("{manual_base}docdata/toc.json"),
        ],
        seed_urls: vec![
            format!("{manual_base}index.html"),
            format!("{script_base}MonoBehaviour.html"),
            format!("{script_base}GameObject.html"),
            format!("{script_base}Transform.html"),
            format!("{script_base}Application.html"),
            format!("{script_base}AssetBundle.html"),
        ],
        official_domains: vec!["docs.unity.cn".to_string(), "unity.cn".to_string()],
        search_site_filter: "site:docs.unity.cn/cn/tuanjiemanual".to_string(),
        documentation_version: "Tuanjie official rolling documentation".to_string(),
        builtin_toc_entries: vec![
            TocSeedEntry {
                symbol: "WeChatWASM.WX".to_string(),
                title: "团结引擎微信小游戏 (Instant Game / WeChatWASM) SDK 与生命周期 API".to_string(),
                url: format!("{manual_base}weixinminigame.html"),
            },
            TocSeedEntry {
                symbol: "UnityEngine.OpenHarmony".to_string(),
                title: "团结引擎 OpenHarmony (开源鸿蒙) 平台适配与原生交互 API".to_string(),
                url: format!("{script_base}OpenHarmonyJSClass.html"),
            },
            TocSeedEntry {
                symbol: "TuanjieEngine.Rendering.TuanjieGI".to_string(),
                title: "团结引擎实时全局光照 (Tuanjie GI) 与虚拟几何体 (Virtual Geometry)".to_string(),
                url: format!("{manual_base}TuanjieGI.html"),
            },
        ],
        builtin_docs: vec![BuiltinReferenceDoc {
            slug: "tuanjie_engine_core_reference".to_string(),
            title: "团结引擎 (Tuanjie Engine) 平台专属 API 与开发规范手册".to_string(),
            source_url: format!("{manual_base}index.html"),
            content: r#"# 团结引擎 (Tuanjie Engine) 核心开发与专属 API 手册

## 1. 引擎定位与工程特征
- 团结引擎基于 Unity 2022 LTS 演进并深度定制，编辑器版本标识通常带有 `tuanjie` 后缀（如 `2022.3.x-tuanjie1.x`），命令行可执行文件支持 `tuanjie` / `Tuanjie.exe`。
- 注意：团结引擎 C# 运行时保持 `UnityEngine` / `UnityEditor` 命名空间兼容，但默认不包含 Unity 6 (6000.0) 独有的 `Awaitable`；异步与协程应优先使用标准 `Coroutine`、`Addressables` 异步句柄或 `UniTask`，以及团结专属平台 SDK 回调。

## 2. 微信小游戏 / Instant Game 平台开发规范
- **内存与包体约束**：WebGL / 小游戏环境严禁阻塞式同步大文件 IO（如 `File.ReadAllBytes` 读取未挂载的远端包）和多线程 `System.Threading.Thread` 创建。
- **资源加载**：优先使用 `Addressables` 或异步 `AssetBundle.LoadFromFileAsync` / `UnityWebRequestAssetBundle` 配合团结引擎 Auto Streaming（按需流式加载）。
- **微信 SDK 交互 (`WeChatWASM`)**：
  - 初始化：`WX.InitSDK((code) => { ... })`
  - 文件缓存清理、登录、分享与振动等能力通过 `WX.*` 静态接口以异步 Option 回调方式调用，并使用 `#if UNITY_MINIGAME && MINIGAME_SUBPLATFORM_WEIXIN` 宏隔离平台代码。

## 3. OpenHarmony (开源鸿蒙) 平台开发规范
- 宏定义隔离：`#if UNITY_OPENHARMONY`
- 原生 ArkTS 交互：通过 `OpenHarmonyJSClass` 与 `OpenHarmonyJSObject` 调用鸿蒙系统层 ETS/ArkTS 模块（类似 Android 的 `AndroidJavaClass` / `AndroidJavaObject`）：
```csharp
#if UNITY_OPENHARMONY
using UnityEngine;
public class HarmonyBridge
{
    public static string CallNativeMethod(string arg)
    {
        using var plugin = new OpenHarmonyJSClass("com.example.harmonyplugin.PluginEntry");
        return plugin.CallStatic<string>("invokeFeature", arg);
    }
}
#endif
```

## 4. HMI 车机与高级渲染特性
- **HMI 车机多屏/嵌入式视图**：支持多 Display 独立渲染控制、快速启动（Fast Boot）与低功耗帧率调节（`Application.targetFrameRate` 与按需渲染 `OnDemandRendering`）。
- **Tuanjie GI & Virtual Geometry**：在高清渲染管线中支持免烘焙实时全局光照与高模虚拟几何体流式渲染。
"#.to_string(),
        }],
    }
}

fn ue6_verse_preset() -> EngineManualPreset {
    let doc_base = "https://dev.epicgames.com/documentation/en-us/uefn/";
    EngineManualPreset {
        preset_id: "ue6_verse".to_string(),
        name: "UE6 / UEFN Verse 代码手册".to_string(),
        description: "Unreal Engine / UEFN 官方 Verse 语言参考手册与核心模块 API（涵盖类型系统、<decides><transacts> 失败上下文、sync/race/rush 并发及 Devices/SceneGraph API）。".to_string(),
        engine_family: "ue6_verse".to_string(),
        entry_url: format!("{doc_base}verse-language-reference"),
        toc_urls: vec![
            format!("{doc_base}verse-language-reference"),
            format!("{doc_base}verse-api"),
        ],
        seed_urls: vec![
            format!("{doc_base}verse-language-reference"),
            format!("{doc_base}verse-language-quick-reference"),
            format!("{doc_base}concurrency-in-verse"),
            format!("{doc_base}failure-in-verse"),
            format!("{doc_base}class-in-verse"),
            format!("{doc_base}functions-in-verse"),
            format!("{doc_base}create-your-own-device-using-verse"),
        ],
        official_domains: vec!["dev.epicgames.com".to_string()],
        search_site_filter: "site:dev.epicgames.com/documentation/fortnite verse".to_string(),
        documentation_version: "UEFN official rolling Verse documentation".to_string(),
        builtin_toc_entries: vec![
            TocSeedEntry {
                symbol: "creative_device".to_string(),
                title: "creative_device (/Fortnite.com/Devices) - Base class for UEFN Verse devices".to_string(),
                url: format!("{doc_base}create-your-own-device-using-verse"),
            },
            TocSeedEntry {
                symbol: "sync / race / rush / branch / spawn".to_string(),
                title: "Concurrency in Verse - Structured async expressions (sync, race, rush, branch, spawn)".to_string(),
                url: format!("{doc_base}concurrency-in-verse"),
            },
            TocSeedEntry {
                symbol: "decides / transacts / suspends".to_string(),
                title: "Failure & Effect Specifiers in Verse (<decides><transacts><suspends>)".to_string(),
                url: format!("{doc_base}failure-in-verse"),
            },
            TocSeedEntry {
                symbol: "option / array / map".to_string(),
                title: "Verse Container & Option Types (?type, []type, [key]value)".to_string(),
                url: format!("{doc_base}verse-language-quick-reference"),
            },
        ],
        builtin_docs: vec![BuiltinReferenceDoc {
            slug: "ue6_verse_language_and_api_reference".to_string(),
            title: "UE6 / UEFN Verse 语言语法、并发原语与核心 API 手册".to_string(),
            source_url: format!("{doc_base}verse-language-reference"),
            content: r#"# UE6 / UEFN Verse 语言与核心 API 代码手册

## 1. 模块导入与基础语法规范
- 标准核心模块导入：
  ```verse
  using { /Fortnite.com/Devices }
  using { /Fortnite.com/Characters }
  using { /Verse.org/Simulation }
  using { /Verse.org/SpatialMath }
  using { /Verse.org/Random }
  using { /UnrealEngine.com/Temporary/Diagnostics }
  ```
- **不可变与可变变量**：
  - 不可变绑定（默认）：`X : int = 10` 或 `X := 10`
  - 可变变量（必须显式加 `var` 关键字，修改时必须使用 `set`）：
    ```verse
    var CurrentScore : int = 0
    set CurrentScore = CurrentScore + 1
    ```

## 2. 失败上下文 (Failable Expressions & `<decides><transacts>`)
- Verse 使用**失败（Failure）**而非布尔值或异常来做条件分支与安全索引：
  - 数组索引 `MyArray[0]`、Map 查找 `MyMap[Key]`、可空解包 `MaybeAgent?`、比较运算 `Score > 10` 都是 `<decides>` 表达式，**只能出现在失败上下文中**（如 `if (...)` 条件、`for (...)` 过滤器或带有 `<decides>` 修饰符的函数内）。
  - 错误写法：`Val := MyArray[0]`（编译报错：在非失败上下文中调用 `<decides>`）。
  - 正确写法：
    ```verse
    if (FirstItem := MyArray[0], FirstItem > 0):
        Print("Valid first item: {FirstItem}")
    ```
  - 带事务回滚的失败函数声明：
    ```verse
    TryDeductGold(Amount : int)<decides><transacts> : void =
        Amount > 0
        CurrentGold >= Amount
        set CurrentGold -= Amount
    ```

## 3. 结构化并发原语 (`<suspends>`, `sync`, `race`, `rush`, `branch`, `spawn`)
- 任何调用 `Sleep(Seconds)` 或 `Await()` 事件等待的函数必须声明 `<suspends>` 修饰符：
  - `sync:` — 并行执行块内所有异步分支，等待**全部完成**后再继续。
  - `race:` — 并行执行块内所有异步分支，**任一分支率先完成时立即取消其余所有分支**。
  - `rush:` — 并行执行块内所有异步分支，任一分支完成即向下继续，但其余分支仍在后台继续运行至当前生命周期结束。
  - `branch:` — 在当前 `<suspends>` 上下文内立即派生一个不阻塞主流程的并发块（主协程结束时自动取消）。
  - `spawn{ AsyncFunc() }` — 在普通同步上下文（如非 `<suspends>` 回调）中启动一个 `<suspends>` 异步函数。

## 4. 自定义设备 (`creative_device`) 与 `@editable` 绑定模板
```verse
using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

game_round_controller := class(creative_device):
    @editable
    TriggerButton : button_device = button_device{}

    @editable
    RoundDurationSeconds : float = 60.0

    OnBegin<override>()<suspends> : void =
        race:
            block:
                InteractingAgent := TriggerButton.InteractedWithEvent.Await()
                Print("Round ended early by agent interaction.")
            block:
                Sleep(RoundDurationSeconds)
                Print("Round timer expired.")
```
"#.to_string(),
        }],
    }
}

impl EngineManualPreset {
    pub fn allows_document_url(&self, url: &Url) -> bool {
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return false;
        }
        let path = url.path();
        let encoded_path = path.to_ascii_lowercase();
        if ["%2f", "%5c", "%00"]
            .iter()
            .any(|escape| encoded_path.contains(escape))
        {
            return false;
        }
        match (self.preset_id.as_str(), url.host_str()) {
            ("unity6", Some("docs.unity3d.com")) => path.starts_with("/6000.0/Documentation/"),
            ("tuanjie", Some("docs.unity.cn")) => {
                path.starts_with("/cn/tuanjiemanual/Manual/")
                    || path.starts_with("/cn/tuanjiemanual/ScriptReference/")
            }
            ("ue6_verse", Some("dev.epicgames.com")) => {
                ["/documentation/en-us/uefn/", "/documentation/fortnite/"]
                    .into_iter()
                    .filter_map(|prefix| path.strip_prefix(prefix))
                    .any(|suffix| {
                        let article = suffix.split('/').next().unwrap_or_default();
                        article.starts_with("verse-")
                            || article.ends_with("-verse")
                            || article.contains("-verse-")
                    })
            }
            _ => false,
        }
    }

    pub fn document_url(&self, mut url: Url) -> Option<Url> {
        if !self.allows_document_url(&url) {
            return None;
        }
        url.set_fragment(None);
        // Locale is part of the documentation identity. Discard tracking data.
        let language = url
            .query_pairs()
            .find(|(key, _)| key == "lang")
            .map(|(_, value)| value.into_owned());
        url.set_query(None);
        if let Some(language) = language {
            url.query_pairs_mut().append_pair("lang", &language);
        }
        Some(url)
    }
}

fn parse_json_toc(
    preset: &EngineManualPreset,
    root: &Url,
    node: &Value,
    entries: &mut Vec<TocSeedEntry>,
) {
    if let Some(children) = node.as_array() {
        for child in children {
            parse_json_toc(preset, root, child, entries);
        }
        return;
    }
    if let Some(link) = node
        .get("link")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|link| !matches!(*link, "" | "null" | "toc"))
    {
        if let Some(title) = node
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
        {
            if let Ok(mut url) = root.join(link) {
                if !url.path().ends_with(".html") && !link.starts_with("https://") {
                    url.set_path(&format!("{}.html", url.path()));
                }
                if let Some(url) = preset.document_url(url) {
                    entries.push(TocSeedEntry {
                        symbol: link.replace('-', "."),
                        title: title.to_string(),
                        url: url.to_string(),
                    });
                }
            }
        }
    }
    if let Some(children) = node.get("children") {
        parse_json_toc(preset, root, children, entries);
    }
}

pub fn parse_toc_payload(
    preset: &EngineManualPreset,
    source_url: &str,
    raw_content: &str,
) -> Result<Vec<TocSeedEntry>, String> {
    let base = Url::parse(source_url).map_err(|err| err.to_string())?;
    if !preset.allows_document_url(&base) {
        return Err("KNOWLEDGE_TOC_OUTSIDE_PRESET".into());
    }
    let mut entries = Vec::new();
    if base.path().ends_with("/docdata/toc.json") {
        let tree: Value = serde_json::from_str(raw_content)
            .map_err(|err| format!("KNOWLEDGE_TOC_INVALID_JSON: {err}"))?;
        let root = base.join("../").map_err(|err| err.to_string())?;
        parse_json_toc(preset, &root, &tree, &mut entries);
    } else {
        let anchors = Regex::new(r#"(?is)<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#)
            .expect("constant TOC anchor pattern");
        let tags = Regex::new(r"(?is)<[^>]+>").expect("constant HTML tag pattern");
        for captures in anchors.captures_iter(raw_content) {
            let href = captures[1].trim();
            if href.is_empty() || href.starts_with('#') {
                continue;
            }
            let Some(url) = base
                .join(href)
                .ok()
                .and_then(|url| preset.document_url(url))
            else {
                continue;
            };
            let title = tags
                .replace_all(&captures[2], " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !title.is_empty() {
                entries.push(TocSeedEntry {
                    symbol: url
                        .path()
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .replace('-', " "),
                    title,
                    url: url.to_string(),
                });
            }
        }
    }
    let mut seen = HashSet::new();
    entries.retain(|entry| seen.insert(entry.url.clone()));
    if entries.is_empty() {
        return Err("KNOWLEDGE_TOC_EMPTY".into());
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_toc_keeps_parent_nodes_and_correct_document_roots() {
        let preset = tuanjie_preset();
        let tree = r#"{"title":"Parent","link":"Parent","children":[
          {"title":"Child","link":"Parent.Child#example"},
          {"title":"Other version","link":"https://docs.unity3d.com/6000.0/Documentation/Manual/outside.html"}
        ]}"#;
        let entries = parse_toc_payload(&preset, &preset.toc_urls[0], tree).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].url.ends_with("/ScriptReference/Parent.html"));
        assert!(entries[1]
            .url
            .ends_with("/ScriptReference/Parent.Child.html"));
        let manual = parse_toc_payload(&preset, &preset.toc_urls[1], tree).unwrap();
        assert!(manual[0].url.ends_with("/Manual/Parent.html"));
    }

    #[test]
    fn document_scope_rejects_wrong_versions_and_external_redirect_targets() {
        let preset = unity6_preset();
        let original = Url::parse(&preset.entry_url).unwrap();
        for target in [
            "https://docs.unity3d.com/6000.0/Documentation/Manual/MonoBehaviour.html",
            "../Manual/MonoBehaviour.html",
        ] {
            assert!(preset.allows_document_url(&original.join(target).unwrap()));
        }
        for target in [
            "https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Other.html",
            "https://docs.unity3d.com.example.org/6000.0/Documentation/Other.html",
            "http://docs.unity3d.com/6000.0/Documentation/Other.html",
            "/6000.0/Documentation/%2f%2e%2e/Other.html",
        ] {
            assert!(
                !preset.allows_document_url(&original.join(target).unwrap()),
                "{target}"
            );
        }
    }

    #[test]
    fn raw_verse_html_preserves_links_and_excludes_other_origins() {
        let preset = ue6_verse_preset();
        let entries = parse_toc_payload(&preset,
            "https://dev.epicgames.com/documentation/fortnite/verse-api?lang=en-US",
            r#"<a href="/documentation/fortnite/verse-api/fortnitedotcom/devices"><code>Devices</code></a>
               <a href="https://outside.example/verse-api">Outside</a>"#).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Devices");
        assert!(entries[0]
            .url
            .ends_with("/verse-api/fortnitedotcom/devices"));
    }
}
