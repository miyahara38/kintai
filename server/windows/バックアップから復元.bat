@echo off
chcp 65001 > nul
cd /d "%~dp0.."
net session > nul 2>&1
if errorlevel 1 ( echo 右クリックして「管理者として実行」を選んでください。 & pause & exit /b 1 )
echo ==== バックアップからの復元 ====
echo 保存されているバックアップ:
dir /b /o-n backups\kintai-*.db
echo.
echo ※ 復元すると、現在のデータはバックアップの時点の内容に戻ります。
echo   (現在のデータは data フォルダに「before-restore-...」として退避されます)
set /p FILE=復元するファイル名を入力してください(例 kintai-20260101-020000.db):
if "%FILE%"=="" ( echo 中止しました。 & pause & exit /b 1 )
set /p OK=本当に復元しますか? (yes と入力で実行):
if /i not "%OK%"=="yes" ( echo 中止しました。 & pause & exit /b 1 )
schtasks /End /TN KintaiServer > nul 2>&1
timeout /t 3 > nul
node scripts\restore.js "backups\%FILE%"
if errorlevel 1 ( echo 復元に失敗しました。サーバーは停止したままです。 & pause & exit /b 1 )
schtasks /Run /TN KintaiServer
echo サーバーを再起動しました。
pause
