@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 請先安裝 Node.js：https://nodejs.org （選 LTS 版） & pause & exit /b)
if not exist node_modules (echo 第一次執行，安裝中... & call npm install)
start "" http://localhost:8080/host
node server.js
pause
