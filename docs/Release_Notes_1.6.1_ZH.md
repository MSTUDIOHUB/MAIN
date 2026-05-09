# MAIN 1.6.1 中文 Release Note

版本跨度：1.6.0 -> 1.6.1  
整理日期：2026-05-09

## 下载页短摘要

MAIN 1.6.1 重点优化了“本地持久化体积与隔离边界”“Composer 输入链路稳定性”和“工作区文件索引效率”。新版把本地持久化升级为轻量 schema，仅保留必要配置与会话元信息，并在迁移时主动清理旧的重型 runtime 字段；同时重构了 Composer 的输入状态管理与发送链路，减少因全局输入状态耦合导致的判定偏差；文件 `@` 引用也新增工作区级缓存与并发收敛，在大项目里打开引用菜单更稳更快。

## 下载说明

- macOS Apple Silicon（M1 / M2 / M3 / M4）用户：下载 `MAIN_1.6.1_macOS_apple_silicon.zip`
- macOS Intel 用户，或不确定自己芯片型号的用户：下载 `MAIN_1.6.1_macOS_universal.zip`
- Windows 64 位用户：下载 `MAIN_1.6.1_windows_x64.zip`
- `latest.json`、`*_updater_*` 和 `.sig` 文件用于应用内自动更新与签名校验，普通用户手动下载安装时不需要下载这些文件

## 主要更新

### 本地持久化瘦身（Schema v2）

- 新增 `persistState` 模块，定义 `LOCAL_PERSIST_SCHEMA_VERSION = 2`，统一处理本地持久化裁剪与迁移。
- 持久化内容改为轻量结构：保留配置、工作区、会话元信息与 UI 布局，不再把 `taskFlow`、`conversationTurns`、`input` 等重型 runtime 数据直接落到本地存储。
- 对 `sessionsByWorkspace` 的落盘数据做进一步收敛：会话只保留元信息，不再持久化 `messages` 与 `runtimeSnapshot`。
- 迁移阶段会主动清理旧版本里的 legacy runtime 字段，减少历史状态污染和持久化膨胀。
- `recordingDisabled` 会话默认不持久化；但 `temporary` 会话会按临时态保留必要记录，兼顾隔离和可恢复性。

### Composer 输入链路重构

- Composer 改为本地 `draftInput` 驱动输入编辑，发送时再显式同步到 store，降低全局 `input` 强耦合。
- `onSendMessage` 现在显式接收 `text` 参数，不再依赖外层闭包读取旧输入值，减少发送瞬间的竞态。
- `setInput` 新增 `preserveLockedComposerIntent` 控制，清空输入时可按需保留当前意图锁定，避免输入法或中间态误清空意图。
- 预检链路对“输入已被本地草稿清空”的场景做了陈旧判定修正，减少误判 stale preflight 的情况。
- ChatArea / App 层同步减参，Composer 输入状态职责更聚焦。

### 工作区文件索引与 @ 引用性能

- 新增 `workspaceFileIndex` 控制器，按 `workspace + contentVersion` 缓存文件列表，支持 LRU 清理与 `maxEntries` 上限。
- 同一工作区同版本的并发文件扫描请求会自动 single-flight 合并，避免重复 I/O。
- `@` 引用菜单改为“按需加载 + 缓存命中”，并加入请求序号保护，避免异步返回覆盖最新状态。
- Game Studio 初始化/移除后会主动清理对应工作区索引并强制刷新，保持引用结果与真实文件树一致。

### 版本同步

- 前端、Tauri、Cargo 与平台打包版本已同步更新到 `1.6.1`。

## 修复与稳定性

- 改进本地存储中的历史 runtime 冗余问题，减少状态迁移后的脏数据残留。
- 改进 Composer 在快速输入、切换与发送场景下的输入一致性。
- 改进大型工作区下 `@` 文件引用的加载抖动与重复扫描问题。

## 验证覆盖

- 新增 Node 测试覆盖持久化 schema v2、legacy 字段清理、会话元数据裁剪策略。
- 新增 Node 测试覆盖工作区文件索引缓存命中、并发 single-flight、版本失效与强制刷新逻辑。

## 推荐展示文案

MAIN 1.6.1 是一次以“更轻、更稳、更快”为目标的维护增强版本。它通过本地持久化瘦身和迁移清理降低历史状态负担，重构了 Composer 输入与发送链路的一致性，并为 `@` 文件引用引入工作区级缓存与并发收敛机制，让长周期使用和大项目协作体验更稳定。
