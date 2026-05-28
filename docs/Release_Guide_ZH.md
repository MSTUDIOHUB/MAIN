# MAIN 极速打包与公开发布指南

本文档介绍如何快速为 MAIN 进行版本升级、编译打包，并安全地分发至公开的下载与更新通道。

> [!IMPORTANT]
> **私有与公开发布的绝对安全边界（本地不上传内容）**
> 1. **严防源码泄露**：我们的核心主开发仓库 `MAIN` 属于**私有仓库**，绝不能公开其源代码。
> 2. **独立公开仓库**：所有公开发布资产均推送到独立的、无源码的公开仓库中：
>    - **用户下载库**：`MSTUDIOHUB/MAIN-Releases`（仅包含编译好的成品 Zip 安装包与 Release Note，无源码）。
>    - **自动更新库**：`MSTUDIOHUB/MAIN-UpdateFeed`（仅包含 `latest.json` 配置、`.sig` 签名及更新包）。
> 3. **本地严禁提交**：打包生成的 `release-output/` 临时目录、`src-tauri/target/` 编译缓存等均已配置在 `.gitignore` 中。**在任何情况下，请勿将其提交到 Git 或手动上传源码至公开仓库**。

---

## 核心发布流程

### 第一步：一键同步版本号

禁止手动修改各配置文件的版本。统一在主项目根目录下执行：

```bash
npm run release:bump -- <version>
```
*例如：`npm run release:bump -- 2.2.0`。此命令将自动同步更新 `package.json`、`Cargo.toml` 以及各平台的 `tauri.*.conf.json` 版本号，确保多端一致。*

---

### 第二步：选择发布路径

#### 路径 A：云端一键发布（推荐 🌟）
直接触发私有仓库的 GitHub Actions 自动打包并分发，免去本地环境配置与多系统编译的烦恼。

1. **执行命令**：
   ```bash
   npm run release:desktop -- <version>
   ```
2. **自动化构建**：GitHub Actions 将自动在云端拉取 macOS 与 Windows 构建环境，完成双平台编译、签名及加密，并自动推送到公开的 `MAIN-Releases` 与 `MAIN-UpdateFeed` 仓库中。

---

#### 路径 B：本地一键打包并上传（GitHub Actions 额度不足或需要本地调试时）
本地打包依赖 GitHub CLI (`gh`) 登录状态，并需要配置 Tauri 更新私钥用于包签名。

##### 1. 一次性准备：配置本地环境变量
**macOS (zsh)**:
```bash
# 直接贴入私钥内容
export TAURI_SIGNING_PRIVATE_KEY='<你的 updater 私钥内容>'
# 或者指定私钥文件路径（推荐，更安全）
export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.config/main/tauri-updater.key"
```

**Windows (PowerShell)**:
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = '<你的 updater 私钥内容>'
# 或者指定路径
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.config\main\tauri-updater.key"
```

##### 2. 执行一键本地发布
*脚本会自动合并双端 `latest.json` 自动更新配置文件，不会产生平台覆盖冲突。*

- **macOS 本地打包上传**：
  在 macOS 终端直接运行极简脚本：
  ```bash
  ./release-mac.sh <version>
  ```
  *(等价于运行 `npm run release:mac:upload -- <version>`)*
  **产出物**：生成 macOS Universal（通用版）与 Apple Silicon 两套 Zip 压缩包，自动签名生成 `.sig` 差分包，并自动发布/上传到 GitHub 的两个公开仓库。

- **Windows 本地打包上传**：
  在 Windows 虚拟机（VM）或 Windows 实体机的 PowerShell 中执行：
  ```powershell
  npm install
  npm run release:windows:x64 -- <version>
  ```
  **产出物**：自动执行便携版及安装版构建，生成并上传 `MAIN_<version>_windows_x64.zip`、Tauri 自动更新文件及签名包。

---

## 本地快速临时打包（不上传 GitHub）

如果您只想进行本地测试或将包直接发给朋友，不需要公开更新和上传，可采用以下快捷命令：

### 1. macOS 极速打包分享
如果您未加入 Apple 开发者计划，无需申请官方证书公证，也可以快速打出一个可分享的绿色版 Zip：
```bash
npm run build:mac:share
```
* **工作机制**：自动清理图标和缓存文件的系统安全隔离（quarantine）属性，进行 ad-hoc 本地重签名，输出适合直接拷贝的压缩包。
* **产物路径**：`src-tauri/target/release/bundle/macos/MAIN-<version>-macOS-unsigned-share.zip`
* **朋友接收后的打开方式**：
  1. 解压后将 `MAIN.app` 拖入 `Applications`（应用程序）文件夹。
  2. 在 Finder 中**右键**点击 `MAIN.app` 选择 **打开 (Open)**。
  3. 若被系统 Gatekeeper 阻拦，前往 `系统设置 > 隐私与安全` 点击 **仍要打开 (Open Anyway)**。
  4. 若提示“应用已损坏”，可在终端执行：
     ```bash
     xattr -dr com.apple.quarantine /Applications/MAIN.app
     ```

### 2. Windows 极速便携版打包
生成单个免安装的 `.exe` 绿色便携版：
```bash
npm run build:windows:portable
```
* **产物路径**：`src-tauri/target/release/portable/MAIN-<version>-windows-portable.exe`
* 非常适合通过 U 盘、网盘或即时聊天软件直接发送给他人进行单机测试。
