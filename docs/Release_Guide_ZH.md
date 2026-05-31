# MAIN 极速打包与公开发布指南

本文档介绍如何为 MAIN 进行版本打包、编译并安全地分发至公开的下载与更新通道。

> [!IMPORTANT]
> **私有与公开发布的绝对安全边界**
> 1. **严防源码泄露**：我们的主开发仓库 `MAIN` 属于**私有仓库**，绝不能公开其源代码。
> 2. **独立公开仓库**：所有公开发布资产均推送到独立的、无源码的公开仓库中：
>    - **用户下载库**：`MSTUDIOHUB/MAIN-Releases`（仅包含打包好的 Zip/Installer 安装包，无源码）。
>    - **自动更新库**：`MSTUDIOHUB/MAIN-UpdateFeed`（仅包含 `latest.json` 配置、签名及更新包）。
> 3. **强力缓存清理**：所有本地打包命令已内置 `cargo clean -p tauri-app` 自动清理缓存，100% 保证每次打包生成的内容都是您项目中的最新前端和 Rust 代码，杜绝旧内容残留。

---

## 核心版本号管理

发布前禁止手动修改各配置文件的版本。统一在主项目根目录下执行：
```bash
npm run release:bump -- <version>
```
*例如：`npm run release:bump -- 2.2.0`。此命令会自动同步更新 `package.json`、`Cargo.toml` 以及各平台的 `tauri.*.conf.json` 版本号，确保多端一致。*

---

## 发布路径 A：云端一键发布（GitHub Actions）

直接触发私有仓库的 GitHub Actions 自动打包并分发，免去本地环境配置与多系统编译的烦恼。

### 1. 执行发布命令
```bash
npm run release:desktop -- <version>
```
*例如：`npm run release:desktop -- 2.2.0`。*

### 2. 自动化流程
- 脚本会自动检查当前工作区是否干净、本地 HEAD 是否已推送到 `origin/main`（确保云端编译的是最新代码）。
- 之后自动触发 GitHub Actions 云端拉取 macOS 与 Windows 构建环境，完成双平台编译、签名及加密，并自动推送到公开的 `MAIN-Releases` 与 `MAIN-UpdateFeed` 仓库中。

### 3. 常用可选参数
- `--draft`：创建为草稿 Release（确认无误后再公开）。
- `--prerelease`：标记为预发布版本。
- `--no-watch`：仅触发工作流，不在控制台等待其运行结束。

---

## 发布路径 B：本地打包并自动上传（GitHub CLI）

当云端 Actions 额度不足或需要本地完成打包上传时使用。本路径需要配置本地 Tauri 更新签名私钥，且依赖 GitHub CLI (`gh`) 登录状态。

### 一次性准备：配置本地私钥
- **macOS (zsh)**:
  ```bash
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.config/main/tauri-updater.key"
  ```
- **Windows (PowerShell)**:
  ```powershell
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.config\main\tauri-updater.key"
  ```

### 运行打包上传命令
脚本会自动清理旧的包编译缓存，合并双端 `latest.json` 自动更新配置文件，并直接上传至 GitHub Releases。

- **macOS 本地打包上传**：
  ```bash
  ./release-mac.sh <version>
  ```
  *(等价于 `npm run release:mac:upload -- <version>`)*
  **产出物**：生成 macOS Universal 与 Apple Silicon 两套 Zip 压缩包，自动签名，并发布/上传到公开仓库。

- **Windows 本地打包上传**：
  在 Windows PowerShell 中执行：
  ```powershell
  npm run release:windows:x64 -- <version>
  ```
  **产出物**：自动生成单文件便携版 `.exe` 与 NSIS 安装包，签名并发布/上传到公开仓库。

---

## 发布路径 C：本地快速临时打包（不上传 GitHub）

如果您只想在本机生成安装包进行临时测试、给朋友体验，而不需要将其发布/上传到 GitHub，请采用以下命令：

### 1. macOS 快速打包
生成适合拷贝给他人直接双击运行的免苹果证书签名 macOS 压缩包：
```bash
npm run build:mac:share
```
- **产物路径**：`src-tauri/target/release/bundle/macos/MAIN-<version>-macOS-unsigned-share.zip`

### 2. Windows 快速打包
- **生成免安装单文件绿色便携版**：
  ```bash
  npm run build:windows:portable
  ```
  - **产物路径**：`src-tauri/target/release/portable/MAIN-<version>-windows-portable.exe`

- **生成标准安装包 (NSIS/MSI)**：
  ```bash
  npm run build:windows
  ```
  - **产物路径**：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`

---

> [!TIP]
> **本地 Staging 说明**：
> 如果您想对本地快速打包生成的零散文件进行整理，可以使用以下命令将它们统一整理到 `release-output/public/` 目录下（其会自动搜寻 target 及架构目录下的最新内容）：
> ```bash
> npm run release:stage -- --repo MSTUDIOHUB/MAIN-Releases
> ```
