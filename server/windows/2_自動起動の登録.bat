@echo off
chcp 65001 > nul
cd /d "%~dp0"
net session > nul 2>&1
if errorlevel 1 (
  echo このファイルを右クリックして「管理者として実行」を選んでください。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-task.ps1"
pause
