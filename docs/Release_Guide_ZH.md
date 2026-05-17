# MAIN 打包与分发指南

本文档说明如何在当前主项目里生成可分发的 macOS 与 Windows 安装包，并把它们整理成适合公开发布的二进制资产。

如果你准备采用“闭源主仓库 + 公开 Releases 仓库”的结构，请同时阅读：

- `docs/Public_Releases_Distribution_Guide_ZH.md`

## 当前版本来源

版本号不再建议手动到处改。以后统一执行：

```bash
npm run release:bump -- <version>
```

这会同步更新：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.macos.conf.json`
- `src-tauri/tauri.windows.conf.json`

对应规则：

- 用户可见版本：`<version>`
- macOS 内部构建号：自动同步为 `major.minor.patch`
- Windows MSI / WiX 版本：自动同步为 `major.minor.patch.build`

## 一次性准备

1. 安装 Node.js、Rust、Xcode Command Line Tools。
2. 在项目根目录执行 `npm install`。
3. 如果需要重新生成图标，执行 `npm run icon:app`。
4. 如果要发布支持自动更新的公开版本，确认私有 `MAIN` 仓库 Actions Secrets 已配置 `PUBLIC_RELEASES_TOKEN`、`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

## 一键公开发布

现在推荐的公开发布入口是：

```bash
npm run release:desktop -- <version>
```

例如：

```bash
npm run release:desktop -- 1.5.5
```

这条命令不会在本机打包，而是触发私有 `MAIN` 仓库的 GitHub Actions。workflow 会构建：

- `MAIN_<version>_macOS_universal.zip`
- `MAIN_<version>_macOS_apple_silicon.zip`
- `MAIN_<version>_windows_x64.zip`
- Tauri updater 使用的签名更新包、`.sig` 和 `latest.json`

发布时会分仓库上传：

- `MAIN-Releases`：只放用户下载 zip
- `MAIN-UpdateFeed`：只放 updater feed（`latest.json + *_updater_* + .sig`）

如果缺少 updater 签名 Secrets，workflow 会失败并提示补齐，避免发布一个无法自动更新的版本。

## 本地公开发布：不用 GitHub Actions

如果 Actions 额度用完，可以直接本地打包并上传公开 Release。先准备好 GitHub CLI 登录状态，并在当前 shell 设置 Tauri updater 私钥：

本地上传不依赖 `PUBLIC_RELEASES_TOKEN` 这个 Actions Secret，但当前 `gh auth login` 的账号需要有 `MAIN-Releases` 和 `MAIN-UpdateFeed` 的 Release 写权限。

macOS / zsh：

```bash
export TAURI_SIGNING_PRIVATE_KEY='<你的 updater 私钥内容>'
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<你的 updater 私钥密码>'
```

Windows / PowerShell：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = '<你的 updater 私钥内容>'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<你的 updater 私钥密码>'
```

### macOS 本机发布

```bash
npm run release:local:mac -- <version>
```

第一次在本机打 universal 包前，如果缺少 Rust target，脚本会提示执行：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

这会生成并上传：

- `MAIN_<version>_macOS_universal.zip`
- `MAIN_<version>_macOS_apple_silicon.zip`
- `MAIN_<version>_updater_darwin_x86_64.app.tar.gz`
- `MAIN_<version>_updater_darwin_x86_64.app.tar.gz.sig`
- `MAIN_<version>_updater_darwin_aarch64.app.tar.gz`
- `MAIN_<version>_updater_darwin_aarch64.app.tar.gz.sig`
- `latest.json`

本地暂存目录：

```text
release-output/local/v<version>/assets/
```

只生成文件、不上传：

```bash
npm run release:local:mac -- <version> --no-upload
```

### Windows 虚拟机发布

Windows 正式发布建议在 Windows VM 或 Windows 真机里跑：

```powershell
npm install
npm run release:local:windows -- <version>
```

这会生成并上传：

- `MAIN_<version>_windows_x64.zip`
- `MAIN_<version>_updater_windows_x86_64.exe`
- `MAIN_<version>_updater_windows_x86_64.exe.sig`
- `latest.json`

如果另一个平台已经先上传过，脚本会下载并合并现有 `latest.json`，避免覆盖对方平台的自动更新入口。

Windows 不建议作为默认流程在 Mac 上交叉打包：Tauri 官方文档说明 MSI 只能在 Windows 上生成，NSIS 虽可从 macOS/Linux 交叉编译但限制较多。稳定发布优先用 Windows VM。

## macOS 打包

### 本地验证未签名包

```bash
npm run build:mac:unsigned
```

产物通常位于：

- `src-tauri/target/release/bundle/macos/MAIN.app`
- `src-tauri/target/release/bundle/dmg/MAIN_<version>_<arch>.dmg`

### 不加入 Apple Developer Program 时更稳的分享方式

如果你暂时不加入 Apple Developer Program，就不要追求“任何 Mac 双击都直接打开”。

没有 `Developer ID Application` 证书和 Apple notarization 时，Gatekeeper 仍然可能拦截。但你仍然可以生成一份更适合朋友测试的 zip 分享包：

```bash
npm run build:mac:share
```

这条命令会自动完成：

1. 清理图标源文件和构建产物上的 `quarantine` 扩展属性
2. 重新生成图标
3. 打一个未签名的 `.app`
4. 用本机做一次 `ad-hoc` 重签名，保证包结构一致
5. 输出适合分享的 zip 包

如果你想把“改版本号 + 打包”合成一步，可以直接运行：

```bash
npm run release:mac
```

这条命令会使用当前 `package.json` 里的版本号，自动同步各平台版本文件，然后继续执行 `npm run build:mac:share`。

如果要在打包前顺手改成指定版本，可以传入版本号：

```bash
npm run release:mac -- 1.1.2
```

带版本号时脚本会先把版本同步为你传入的值，再继续打包。

生成文件通常位于：

- `src-tauri/target/release/bundle/macos/MAIN-<version>-macOS-unsigned-share.zip`

分享时建议：

1. 不要直接发裸 `.app`
2. 不要优先发未签名的 `.dmg`
3. 优先发上面的 `.zip`
4. 尽量不要用会二次处理文件内容的聊天软件直接在线解包

### 朋友端的打开方式

第一次打开时，朋友的 Mac 仍然可能拦截，因为这不是 Apple Developer 正式签名应用。

推荐处理顺序：

1. 把 `MAIN.app` 解压后拖到 `Applications`
2. 在 Finder 里对 `MAIN.app` 点击右键，选择 `Open`
3. 如果系统仍然拦截，到 `System Settings > Privacy & Security` 里点 `Open Anyway`
4. 如果看到 `damaged and can't be opened`，在终端运行：

```bash
xattr -dr com.apple.quarantine /Applications/MAIN.app
```

### 正式签名与公证

要让其他人双击后可以更自然地打开，macOS 版本至少需要：

1. `Developer ID Application` 证书
2. Hardened Runtime
3. Apple notarization 公证
4. 最终 `staple` 到应用或 DMG

当前项目已经启用：

- `bundle.macOS.hardenedRuntime = true`
- `bundle.targets = ["app", "dmg"]`

正式签名打包前，请先在本机导入 `.p12` 证书，并确认下列命令能看到有效身份：

```bash
security find-identity -v -p codesigning
```

然后配置这些环境变量再执行正式构建：

```bash
export APPLE_CERTIFICATE="<base64-p12>"
export APPLE_CERTIFICATE_PASSWORD="<p12-password>"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="<apple-id>"
export APPLE_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<team-id>"
npm run build:mac
```

如果你已经把证书导入登录钥匙串，也可以不使用 `APPLE_CERTIFICATE`，直接依赖钥匙串中的证书，但 `APPLE_SIGNING_IDENTITY` 仍建议显式设置，避免签错身份。

### Intel 与 Apple Silicon

当前这台机器如果只安装了 `aarch64-apple-darwin` Rust target，本地默认生成的是 Apple Silicon 版本。

如果你要同时兼容 Intel Mac，先安装额外 target：

```bash
rustup target add x86_64-apple-darwin
```

再执行：

```bash
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

这样会生成 universal macOS 应用，更适合公开分发。

## Windows 打包

### 便携版

如果你希望朋友拿到后尽量直接运行，不走安装流程，优先使用便携版：

```bash
npm run build:windows:portable
```

生成文件通常位于：

- `src-tauri/target/release/portable/MAIN-<version>-windows-portable.exe`

这个版本的特点是：

1. 单个 `.exe`
2. 不需要安装器
3. 适合聊天软件、网盘或 U 盘直接分发

但目标电脑仍然需要 `Microsoft Edge WebView2 Runtime`。

### 安装版

如果你还要 NSIS / MSI：

```bash
npm run build:windows
```

产物通常位于：

- `src-tauri/target/release/bundle/nsis/`
- `src-tauri/target/release/bundle/msi/`

## 对外发布前整理素材

如果你采用 GitHub Releases 做下载入口，建议在构建完成后执行：

```bash
npm run release:stage -- --repo <你的 GitHub 用户名>/MAIN-Releases
```

脚本会生成：

- `release-output/public/v<version>/assets/`
- `release-output/public/v<version>/release-notes.md`
- `release-output/public/v<version>/release-metadata.json`
- `release-output/public/v<version>/website-links.json`

## 发布前检查

1. 先执行 `npm run release:bump -- <version>`，不要手改多个版本文件。
2. 确认图标已经是你要公开分发的正式图标。
3. 确认 macOS 分享包或正式签名包已经生成。
4. 确认 Windows 便携版 / 安装版已生成。
5. 确认 `npm run release:stage -- --repo <owner>/MAIN-Releases` 已生成发布附件与说明文件。
6. 确认 `identifier` 在正式公开发布前替换成你自己长期持有的反向域名标识。

最后一项尤其重要。当前项目仍使用 `com.localagent.ide`，功能上可以打包，但如果要长期对外发布，建议改成你自己控制的正式 bundle identifier，例如基于品牌域名来命名。
