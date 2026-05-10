# MAIN 闭源主仓库 + 双公开仓库发布方案

这份方案专门对应你现在的目标：

- 主项目源码保持闭源
- 下载走 GitHub Releases
- 官网按钮稳定指向最新版
- macOS / Windows 版本号尽量只维护一次

## 推荐结构

### 1. 私有主仓库：`MAIN`

这个仓库继续放真正的源码与构建逻辑：

- 桌面应用源码
- Tauri 配置
- 构建脚本
- 内部文档
- 自动化测试
- 发布辅助脚本

这个仓库不需要公开。

### 2. 公开下载仓库：`MAIN-Releases`

这个仓库只承担“对外下载入口”，不承担源码托管：

- GitHub Releases
- 二进制安装包
- README（说明 MAIN 是闭源桌面应用）
- 可选截图、版本说明

最关键的是：

- 用户访问公开仓库拿安装包
- 你继续在私有仓库里开发
- 不需要开源主项目代码

### 3. 公开更新源仓库：`MAIN-UpdateFeed`

这个仓库只承担“应用内自动更新源”，不承担手动下载入口：

- `latest.json`
- `*_updater_*` 更新包
- 对应 `.sig` 签名文件

这样可以把手动下载页面和自动更新资产解耦，下载页只展示用户真正需要点击的 zip。

## 为什么这是当前最稳方案

相比“直接把安装包放网站服务器”或“把源码也公开到同一仓库”，这套结构更适合你现在的产品阶段：

- 网站流量不会直接吃你自己的服务器带宽
- GitHub Releases 更适合承接安装包下载
- 主源码继续保持闭源
- 官网下载按钮可以固定指向 `releases/latest`
- 每次发新版本时，首页通常不需要再改链接

## GitHub Actions 自动发布 zip

当前仓库已经配置了：

- `.github/workflows/build-desktop.yml`

它会在私有 `MAIN` 仓库里构建，然后分两路发布：

发布到 `MAIN-Releases`（用户下载页）：

- `MAIN_<version>_macOS_universal.zip`
- `MAIN_<version>_macOS_apple_silicon.zip`
- `MAIN_<version>_windows_x64.zip`

发布到 `MAIN-UpdateFeed`（自动更新源）：

- `MAIN_<version>_updater_darwin_x86_64.app.tar.gz`
- `MAIN_<version>_updater_darwin_aarch64.app.tar.gz`
- `MAIN_<version>_updater_windows_x86_64.exe`
- 对应的 `.sig` 签名文件
- `latest.json`

不会上传 `src/`、`src-tauri/`、`dist/`、`target/` 这类源码或构建目录。
Release Changelog 会自动写入私有 `MAIN` 仓库触发构建时的最后一次提交摘要、提交正文和变更文件列表，但不会公开源码 diff。

其中 `MAIN-Releases` 只保留用户手动下载的 zip；`MAIN-UpdateFeed` 承担 Tauri updater 自动更新所需的 `updater_*`、`.sig` 和 `latest.json`。`latest.json` 只包含版本号、更新说明、下载 URL 和签名，不包含源码。

### 最快发布命令

本机已经封装了一键触发命令：

```bash
npm run release:desktop -- 1.4.2
```

这条命令会检查 GitHub CLI 登录、两个公开仓库访问、`PUBLIC_RELEASES_TOKEN`、Tauri updater 签名 Secrets、当前工作区是否干净、当前 `HEAD` 是否已经推送到 `origin/main`，然后触发 GitHub Actions 构建并发布：

- zip 到 `MAIN-Releases`
- updater feed 到 `MAIN-UpdateFeed`

常用参数：

```bash
npm run release:desktop -- 1.4.2 --draft
npm run release:desktop -- 1.4.2 --prerelease
npm run release:desktop -- 1.4.2 --no-watch
npm run release:desktop -- 1.4.2 --dry-run
```

版本号必须写成 `1.4.2`，不要写成 `v1.4.2`；脚本会自动给 Release tag 加 `v` 前缀。

### 一次性配置

#### 1. 创建公开仓库

在 GitHub 创建一个 public 仓库：

```text
MSTUDIOHUB/MAIN-Releases
MSTUDIOHUB/MAIN-UpdateFeed
```

两个仓库都不放源码：

- `MAIN-Releases`: 只放用户下载 zip
- `MAIN-UpdateFeed`: 只放 updater feed 资产

创建时建议勾选 `Add a README file`，让公开仓库拥有默认分支。GitHub Release 的 tag 会挂在这个公开仓库自己的默认分支上，不会指向私有 `MAIN` 的源码提交。

#### 2. 创建发布 Token

在 GitHub 创建一个 fine-grained personal access token：

1. 打开 `GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens`
2. 选择 `Generate new token`
3. Repository access 选择：
   - `MSTUDIOHUB/MAIN-Releases`
   - `MSTUDIOHUB/MAIN-UpdateFeed`
4. Repository permissions 至少给：
   - `Contents: Read and write`
   - `Metadata: Read-only`
5. 生成 token 后复制。这个值只会显示一次。

#### 3. 把 Token 放进私有 MAIN 仓库 Secrets

在私有 `MAIN` 仓库打开：

```text
Settings > Secrets and variables > Actions > New repository secret
```

新增：

```text
Name: PUBLIC_RELEASES_TOKEN
Value: 上一步复制的 GitHub token
```

不要把这个 token 写进代码、README、workflow 明文里。

#### 4. 配置 Tauri updater 签名密钥

自动更新必须使用 Tauri updater 的签名校验。私钥只放在私有 `MAIN` 仓库的 Actions Secrets，不放进代码仓库。

当前需要这两个 Secrets：

```text
Name: TAURI_SIGNING_PRIVATE_KEY
Value: Tauri updater 私钥内容

Name: TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Value: 生成私钥时设置的密码
```

`MAIN-UpdateFeed` 仓库会出现 `.sig` 与 `latest.json`。应用内置 updater 公钥，用户端会校验签名；如果附件被篡改，签名校验会失败，MAIN 不会安装该更新。

### 每次发布

1. 打开私有 `MAIN` 仓库的 `Actions`
2. 左侧选择 `Build and Publish Desktop Zips`
3. 点击 `Run workflow`
4. 填：
   - `version`: 例如 `1.4.1`
   - `release_repo`: 默认 `MSTUDIOHUB/MAIN-Releases`
   - `update_repo`: 默认 `MSTUDIOHUB/MAIN-UpdateFeed`
   - `draft`: 第一次建议选 `true`，确认附件无误后再公开
   - `prerelease`: 测试版才选 `true`
5. 点击绿色 `Run workflow`

构建成功后，公开仓库会出现：

```text
https://github.com/MSTUDIOHUB/MAIN-Releases/releases/tag/v1.4.1
```

如果 `draft = true`，需要到 `MAIN-Releases > Releases` 页面手动点 `Publish release`。

自动更新入口固定为：

```text
https://github.com/MSTUDIOHUB/MAIN-UpdateFeed/releases/latest/download/latest.json
```

用户已经安装的 MAIN 会在启动后自动检查这个文件；有新版本时，Sidebar 顶部 Logo 行右侧会出现“更新 / Update”按钮。

### 用户下载入口

官网按钮建议固定指向：

```text
https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest
```

以后每次发布新版本，官网通常不需要改链接。

### macOS 未签名提示

如果没有配置 Apple Developer 证书，workflow 会生成 ad-hoc signed 的 macOS zip。它可以下载和解压，但首次打开时 macOS 仍可能拦截。

用户可以：

1. Apple Silicon 机型优先解压 `MAIN_<version>_macOS_apple_silicon.zip`；不确定机型时解压 `MAIN_<version>_macOS_universal.zip`
2. 把 `MAIN.app` 拖进 `Applications`
3. 右键 `Open`
4. 如仍被拦截，到 `System Settings > Privacy & Security` 点 `Open Anyway`

正式对外分发时，建议后续补 Apple Developer ID 签名与 notarization。

### Windows SmartScreen 提示

Windows zip 内是 portable `.exe`。如果没有代码签名证书，SmartScreen 或杀毒软件可能提示未知发布者。

不签也能发布，但正式商用分发建议后续添加 Windows 代码签名证书。

## 手动发布备用流程

如果 GitHub Actions 暂时没有配置好，也可以使用下面的本地手动流程。

## 一次性配置

### 1. 创建公开仓库

建议仓库名：`MAIN-Releases`

README 可以只写这类内容：

- MAIN 是本地优先的桌面 Agent 工作台
- 源码不开源
- 这里仅提供公开安装包与版本说明

### 2. 官网统一接到最新 Release 页面

官网按钮最省事的方式不是直接写死某个具体文件，而是固定跳：

```text
https://github.com/<你的 GitHub 用户名>/MAIN-Releases/releases/latest
```

这样做的好处是：

- 新版本发布后，首页按钮不用改
- 用户永远拿到最新版本入口
- 你只需要维护 GitHub Release 本身

### 3. 主仓库里统一版本号入口

本轮已经补了版本同步脚本：

```bash
npm run release:bump -- 1.1.2
```

它会同步更新：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.macos.conf.json`
- `src-tauri/tauri.windows.conf.json`

对应规则：

- App 版本：`1.1.2`
- macOS `bundleVersion`：`1.1.2`
- Windows WiX 版本：`1.1.2.0`

如果你以后发预发布，例如：

```text
1.2.0-beta.1
```

脚本会自动转成：

- macOS `bundleVersion`：`1.2.0`
- Windows WiX 版本：`1.2.0.1`

也就是说，以后你只需要记住一个对外版本号。

## 每次发布时的推荐流程

### 第一步：统一版本号

```bash
npm run release:bump -- 1.1.2
```

### 第二步：在私有主仓库里构建安装包

macOS：

```bash
npm run build:mac:share
```

Windows 便携版：

```bash
npm run build:windows:portable
```

如果还要安装版：

```bash
npm run build:windows
```

### 第三步：整理成“可上传到公开仓库”的发布目录

```bash
npm run release:stage -- --repo <你的 GitHub 用户名>/MAIN-Releases
```

脚本会在：

```text
release-output/public/v1.1.2/
```

生成这些文件：

- `assets/`：准备上传的安装包
- `release-notes.md`
- `release-metadata.json`
- `website-links.json`

其中 `website-links.json` 适合拿来核对官网按钮应该指向哪里。

### 第四步：上传到公开 GitHub Release

如果你安装了 GitHub CLI，可以直接用脚本输出的命令，例如：

```bash
gh release create v1.1.2 release-output/public/v1.1.2/assets/* --repo <你的 GitHub 用户名>/MAIN-Releases --title "MAIN 1.1.2" --notes-file release-output/public/v1.1.2/release-notes.md
```

如果你暂时不用 `gh`，也可以手动去 GitHub 网页端：

1. 新建 Tag：`v1.1.2`
2. 新建 Release
3. 上传 `assets/` 里的文件
4. 把 `release-notes.md` 内容粘进去

## 官网下载按钮怎么接 GitHub Releases

当前最推荐的规则只有两条：

### 1. 主下载按钮固定跳 `latest`

```text
https://github.com/<你的 GitHub 用户名>/MAIN-Releases/releases/latest
```

适合：

- Hero 主按钮
- Footer 下载按钮
- 任何“获取最新版”入口

### 2. Footer GitHub 按钮跳仓库根地址

```text
https://github.com/<你的 GitHub 用户名>/MAIN-Releases
```

适合：

- “GitHub” 链接
- “版本历史”入口
- 用户想查看所有历史 Release 的场景

## 为什么不建议首页直接写死具体安装包文件名

比如下面这种链接：

```text
.../releases/download/v1.1.2/MAIN-1.1.2-windows-portable.exe
```

虽然能用，但维护成本更高：

- 每发一个版本都要改官网
- 如果同一版本重新打包，文件名可能变化
- macOS / Windows 资产一多时容易漏改

所以首页更适合连到 `releases/latest`，真正的平台选择交给 GitHub Release 页面。

## 版本维护最省事的建议

以后就按这条简单规则走：

### 你只维护一个语义版本号

例如：

- `1.1.2`
- `1.1.3`
- `1.2.0-beta.1`

然后总是执行：

```bash
npm run release:bump -- <version>
```

不要再手改多个配置文件。

## 这套方案里的职责边界

### 私有主仓库负责

- 写代码
- 跑测试
- 打包构建
- 生成发布素材
- 维护真实开发历史

### 公开 Releases 仓库负责

- 对外下载
- 版本说明
- 二进制附件
- 历史版本留档

这个边界非常清楚，也最适合你现在“不想开源代码，但希望下载稳定”的目标。

## 发布前检查清单

每次对外发版前建议快速确认：

1. `npm run release:bump -- <version>` 已执行
2. macOS / Windows 构建都成功
3. `npm run release:stage -- --repo <owner>/MAIN-Releases` 已生成发布目录
4. `release-notes.md` 已包含本次发布的提交摘要
5. 官网主下载按钮仍然指向 `/releases/latest`
6. GitHub Release 的 tag 使用 `v<version>` 形式

如果你后面愿意，我下一步可以继续直接帮你补：

- 一个更完整的 `MAIN-Releases` README 模板
- 一套适合网页展示的“下载 / 更新日志 / 校验说明”文案
- 或者把私有主仓库发布后自动推送到公开 Release 的半自动脚本
