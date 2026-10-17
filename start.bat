@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TASK_NODE=node"
where node >nul 2>&1
if errorlevel 1 set "TASK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
echo CrossCheck local demo - http://localhost:5173
echo Fixed demo results and local EVM only. Not Monad or live AI.
"%TASK_NODE%" scripts\local-demo.mjs
if errorlevel 1 pause