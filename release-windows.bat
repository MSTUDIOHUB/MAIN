@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Error: Please specify the version to release.
    echo Example: release-windows.bat 2.1.9
    exit /b 1
)

echo Starting Windows release process for version %1...

:: Auto-install dependencies if node_modules doesn't exist
if not exist "node_modules" (
    echo node_modules not found, running npm install...
    call npm install
)

:: Run the release command
call npm run release:windows:x64 -- %1

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Release failed with error code %errorlevel%.
    exit /b %errorlevel%
)

echo.
echo [SUCCESS] Release completed successfully!
