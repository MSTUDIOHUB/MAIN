$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJsonPath = Join-Path $rootDir "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

$appName = "MAIN"
$version = $packageJson.version
$releaseDir = Join-Path $rootDir "src-tauri\target\release"
$portableDir = Join-Path $releaseDir "portable"
$sourceExe = Join-Path $releaseDir "$appName.exe"
$portableExe = Join-Path $portableDir "$appName-$version-windows-portable.exe"

npm run icon:app
npm run tauri build -- --no-bundle

New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
Copy-Item $sourceExe $portableExe -Force

Write-Host ""
Write-Host "Created Windows portable build:"
Write-Host "  $portableExe"
Write-Host ""
Write-Host "Notes:"
Write-Host "- This is a portable single EXE build."
Write-Host "- It does not require an installer."
Write-Host "- Target PCs still need Microsoft Edge WebView2 Runtime."
