# MAIN 桌面打包与公开发布指南

> 状态：现行规范
> 事实源：`package.json`、`scripts/release-desktop.mjs`、`scripts/release-local.mjs`、`scripts/release_tools.mjs` 与 `.github/workflows/build-desktop.yml`。脚本的 `--help` 和当前 workflow 是最终执行事实；本文不能覆盖代码。

## 仓库与密钥边界

MAIN 使用一个私有源码仓库和两个公开二进制仓库：

| 仓库 | 可公开内容 | 禁止内容 |
| --- | --- | --- |
| `MSTUDIOHUB/MAIN` | 不公开 | 源码、构建脚本、内部文档与 Secrets 只留在私有仓库 |
| `MSTUDIOHUB/MAIN-Releases` | 用户下载 zip 与 `release_notes.md` | 源码、构建目录、签名私钥 |
| `MSTUDIOHUB/MAIN-UpdateFeed` | updater 包、`.sig` 与 `latest.json` | 源码与签名私钥 |

GitHub Actions 使用私有仓库中的 `PUBLIC_RELEASES_TOKEN`、`TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。Token 和 updater 私钥不得写入仓库、命令历史、发布说明或 Debug Log。

Apple Developer 与 Windows Authenticode 签名是分发身份；Tauri updater 签名是更新完整性校验。二者职责不同，不能互相替代。

## 版本号

版本参数必须是不带 `v` 的语义版本，例如 `<major>.<minor>.<patch>`；发布 tag 由脚本自动变为 `v<version>`。

如果要在源码分支中显式提交版本变更，只使用：

```bash
npm run release:bump -- <version>
```

它同步修改 `package.json`、`package-lock.json`、Tauri 通用/macOS/Windows 配置和 `src-tauri/Cargo.toml`。不要手工只改其中一个文件。

`release:desktop` 的 workflow 与本地 `release:mac:upload` / `release:windows:x64` 会在自己的流程中调用同一版本同步逻辑，因此不要求预先单独执行 `release:bump`。云端发布命令反而要求当前工作树干净且 HEAD 已推送到 `origin/main`。

## 路径 A：GitHub Actions 双平台发布

这是同时发布 macOS 与 Windows 的推荐路径：

```bash
npm run release:desktop -- <version>
```

本地 preflight 会验证：

- `gh` 已安装并登录 GitHub；
- 私有仓库和两个公开仓库均可访问；
- 三个必需 Actions Secrets 存在；
- 两个公开仓库中尚不存在同版本 Release；
- 工作树干净；
- 当前 HEAD 与 `origin/main` 完全一致。

可选参数：

```bash
npm run release:desktop -- <version> --draft
npm run release:desktop -- <version> --prerelease
npm run release:desktop -- <version> --no-watch
npm run release:desktop -- <version> --dry-run
```

workflow `build-desktop.yml` 在隔离 runner 中构建 macOS Universal、macOS Apple Silicon 与 Windows x64，生成 updater 签名和 `latest.json`，再分别发布到下载仓库与更新源仓库。`--dry-run` 只打印 workflow 命令，不做 preflight 或远端写入；`--no-watch` 触发后立即返回。

如果同版本 Release 已存在，`release:desktop` 会在触发前拒绝。需要重发时应使用新版本；不要把公开过的版本号静默替换成另一组二进制。

## 路径 B：本地分平台发布

GitHub Actions 不可用时，可以在对应原生系统上构建。两个平台脚本都会同步版本、清理 `tauri-app` 构建缓存、核验产物版本、生成 updater 签名与 manifest；`--skip-build` 会复用现有产物，只适合已经确认产物与版本完全匹配的恢复场景。

### macOS

默认从仓库外读取：

```text
~/.config/main/tauri-updater.key
~/.config/main/tauri-updater.pwd
```

也可以使用 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PATH`，或传 `--signing-key-file`。如果同目录存在 `.pub` 文件，脚本会核对它与 `src-tauri/tauri.conf.json` 中的 updater 公钥。

执行：

```bash
npm run release:mac:upload -- <version>
```

### Windows x64

在 Windows 真机或 VM 中安装 Visual Studio Build Tools 的 C++ desktop / MSVC x64 工具链，然后执行：

```powershell
npm run release:windows:x64 -- <version>
```

脚本固定构建 `x86_64-pc-windows-msvc`，因此 Windows ARM VM 也会产出面向 Windows x64 的包。

### 本地发布选项

两个平台共享的主要选项：

- `--no-upload`：只构建、签名和暂存，不写 GitHub Release；
- `--skip-build`：复用现有 target 产物，仍做版本核验；
- `--draft` / `--prerelease`：设置公开 Release 状态；
- `--release-repo <owner/repo>` / `--update-repo <owner/repo>`：覆盖默认仓库；
- `--no-merge-existing-latest`：不合并同版本已存在的另一平台 manifest；
- `--update-existing-notes` / `--keep-existing-notes`：显式控制已有 Release 文案。

本地暂存目录为：

```text
release-output/local/v<version>/assets/
```

默认会合并同版本现有 `latest.json`，所以 macOS 与 Windows 谁先上传都可以。后执行的平台不得删除另一平台已经存在的 manifest entry。

## 路径 C：仅生成本机测试包

这些命令不发布 GitHub，也不生成一套可直接用于应用内更新的双平台 feed：

```bash
npm run build:mac:share
```

生成 ad-hoc signed 的 macOS 分享 zip：

```text
src-tauri/target/release/bundle/macos/MAIN-<version>-macOS-unsigned-share.zip
```

Windows PowerShell：

```powershell
npm run build:windows:portable
npm run build:windows
```

前者生成单文件 portable exe，后者生成 NSIS/MSI。未使用 Developer ID / notarization 或 Windows 代码签名证书时，系统可能显示未知开发者或 SmartScreen 警告；不能把这种测试包描述为已完成正式平台签名。

## 公开资产契约

`MAIN-Releases` 当前只接收：

```text
MAIN_<version>_macOS_universal.zip
MAIN_<version>_macOS_apple_silicon.zip
MAIN_<version>_windows_x64.zip
release_notes.md
```

`MAIN-UpdateFeed` 当前只接收：

```text
MAIN_<version>_updater_darwin_x86_64.app.tar.gz
MAIN_<version>_updater_darwin_x86_64.app.tar.gz.sig
MAIN_<version>_updater_darwin_aarch64.app.tar.gz
MAIN_<version>_updater_darwin_aarch64.app.tar.gz.sig
MAIN_<version>_updater_windows_x86_64.exe
MAIN_<version>_updater_windows_x86_64.exe.sig
latest.json
```

发布说明可以包含 commit 摘要与变更文件名，但不能包含源码 diff、Secrets 或私有构建日志。

## 发布后验收

1. 检查 `MAIN-Releases/releases/tag/v<version>` 只有三套用户 zip 与发布说明。
2. 检查 `MAIN-UpdateFeed/releases/tag/v<version>` 包含三平台 updater、每个对应 `.sig` 和 `latest.json`。
3. 校验 `latest.json` 是合法 JSON，version 正确，并同时包含 `darwin-x86_64`、`darwin-aarch64` 与 `windows-x86_64` 映射。
4. 确认 manifest URL 指向 `MAIN-UpdateFeed` 的同版本资产，签名字段非空。
5. 在一台干净机器上分别解压/安装下载包，验证启动、版本显示和更新检查。
6. 只有 Release 真正公开后，才把官网入口指向 `MAIN-Releases/releases/latest`，并确认 updater 的 `/releases/latest/download/latest.json` 已解析到本版本。

任何资产缺失、版本不一致或签名不匹配都应终止发布，不得用手工改写 `latest.json` 掩盖失败。
