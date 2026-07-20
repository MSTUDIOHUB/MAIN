# MAIN

MAIN 是一个基于 `Tauri 2 + React + TypeScript` 的桌面应用。

## 开发

```bash
npm install
npm run tauri dev
```

## 现行运行时契约

- [架构与唯一所有权](docs/ARCHITECTURE.md)
- [Run / Turn 生命周期](docs/RUNTIME_LIFECYCLE.md)
- [Session 持久化与 Workspace Turn 接纳](docs/SESSION_PERSISTENCE.md)
- [Rust 受信任执行边界](docs/TRUSTED_EXECUTION.md)
- [测试、Trace 与 Replay](docs/TESTING_AND_REPLAY.md)

历史 Release Notes 只记录当时版本，不能覆盖上述现行契约。

## 打包

```bash
npm run icon:app
npm run build:mac:unsigned
npm run build:mac
npm run build:windows
```

- `npm run icon:app` 会使用 `public/LogoM.png` 重新生成应用图标。
- `npm run build:mac:unsigned` 用于本地验证未签名的 macOS 包。
- `npm run build:mac` 使用当前 Tauri / Apple signing 配置生成 app 与 dmg；只有证书、公证配置和验收都通过后才能视为正式分发包。
- `npm run build:windows` 需要在 Windows 机器或 Windows CI 上执行，并显式生成 Windows 11 x64 产物。

产物目录取决于目标平台与 target；以构建命令输出和发布脚本校验结果为准。

## 发布说明

闭源主仓库、双公开仓库、签名、GitHub Actions 与本地发布的现行流程见 [桌面打包与公开发布指南](docs/Release_Guide_ZH.md)。

Actions 额度用完时可以改走本地发布：

```bash
npm run release:mac:upload -- <version>
```

Windows 发布在 Windows VM 里执行；即使 VM 是 Windows ARM，产物也会按 `x86_64-pc-windows-msvc` 生成给 Windows 11 x64 使用：

```powershell
npm run release:windows:x64 -- <version>
```
