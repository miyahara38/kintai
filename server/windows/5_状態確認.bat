@echo off
chcp 65001 > nul
cd /d "%~dp0.."
echo ---- 自動起動の登録状況 ----
schtasks /Query /TN KintaiServer /FO LIST | findstr /C:"状態" /C:"Status" /C:"タスク名" /C:"TaskName"
echo.
echo ---- サーバーの応答 ----
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://localhost:3000/ -TimeoutSec 5).StatusCode; Write-Host '応答あり(正常)' } catch { Write-Host '応答がありません(停止中の可能性)' }"
echo.
echo ---- 最近のログ(最後の20行) ----
if exist logs\server.log ( powershell -NoProfile -Command "Get-Content logs\server.log -Tail 20 -Encoding UTF8" ) else ( echo ログはまだありません )
pause
