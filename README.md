# MAIN

MAIN 是一个基于 `Tauri 2 + React + TypeScript` 的桌面应用。

## 开发

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run icon:app
npm run build:mac:unsigned
npm run build:mac
npm run build:windows
```

- `npm run icon:app` 会使用 `public/LogoM.png` 重新生成应用图标。
- `npm run build:mac:unsigned` 用于本地验证未签名的 macOS 包。
- `npm run build:mac` 用于正式签名的 macOS 包。
- `npm run build:windows` 需要在 Windows 机器或 Windows CI 上执行。

默认产物位于 `src-tauri/target/release/bundle/`。

## 发布说明

详细的 macOS 签名、公证和 Windows 打包说明见 [docs/Release_Guide_ZH.md](/Users/mstudio/Documents/MAIN/docs/Release_Guide_ZH.md)。
