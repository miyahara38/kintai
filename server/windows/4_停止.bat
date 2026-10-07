@echo off
chcp 65001 > nul
net session > nul 2>&1
if errorlevel 1 ( echo 右クリックして「管理者として実行」を選んでください。 & pause & exit /b 1 )
schtasks /End /TN KintaiServer
echo 停止しました。(次回パソコンを起動すると、また自動で起動します)
pause
