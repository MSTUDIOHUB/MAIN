param(
  [string]$Target = "x86_64-pc-windows-msvc",
  [switch]$SkipIcon
)

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJsonPath = Join-Path $rootDir "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

$appName = "MAIN"
$version = $packageJson.version
$targetReleaseDir = Join-Path $rootDir "src-tauri\target\$Target\release"
$portableOutputRoot = Join-Path $rootDir "src-tauri\target\release"
$portableDir = Join-Path $portableOutputRoot "portable"
$sourceExe = Join-Path $targetReleaseDir "$appName.exe"
$portableExe = Join-Path $portableDir "$appName-$version-windows-portable.exe"

if ([string]::IsNullOrWhiteSpace($Target)) {
  throw "Windows target cannot be empty. Use x86_64-pc-windows-msvc for Windows 11 x64 builds."
}

Write-Host "Building Windows portable package for target: $Target"
rustup target add $Target

if (!$SkipIcon) {
  npm run icon:app
}

npm run tauri build -- --target $Target --no-bundle

if (!(Test-Path $sourceExe)) {
  throw "Missing built Windows executable: $sourceExe"
}

New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
Copy-Item $sourceExe $portableExe -Force

Write-Host ""
Write-Host "Created Windows portable build:"
Write-Host "  $portableExe"
Write-Host ""
Write-Host "Target:"
Write-Host "  $Target"
Write-Host ""
Write-Host "Notes:"
Write-Host "- This is a Windows 11 x64-compatible portable single EXE build when Target is x86_64-pc-windows-msvc."
Write-Host "- It does not require an installer."
Write-Host "- Target PCs still need Microsoft Edge WebView2 Runtime."
