@echo off
chcp 65001 >nul
rem 双击运行：重新生成 shared-docs.zip（逻辑在 scripts\build-zip.mjs）
cd /d "%~dp0"

where node >nul 2>nul || (
    echo 没找到 Node.js，请先安装：https://nodejs.org/
    pause
    exit /b 1
)

node scripts\build-zip.mjs
if errorlevel 1 (
    echo.
    echo 打包失败，请看上面的报错。
)
pause