@echo off
chcp 65001 > nul
net session > nul 2>&1
if errorlevel 1 ( echo 右クリックして「管理者として実行」を選んでください。 & pause & exit /b 1 )
schtasks /Run /TN KintaiServer
echo 起動しました。
pause
