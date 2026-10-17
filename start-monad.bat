@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TASK_NODE=node"
where node >nul 2>&1
if errorlevel 1 set "TASK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%TASK_NODE%" --import tsx server.ts
if errorlevel 1 pause
