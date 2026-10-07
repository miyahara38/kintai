@echo off
chcp 65001 > nul
cd /d "%~dp0.."
echo ==== 勤怠システム 初期設定 ====
where node > nul 2>&1
if errorlevel 1 (
  echo Node.js が見つかりません。先に Node.js をインストールしてください。手順はマニュアルを見てください。
  pause
  exit /b 1
)
node scripts\setup.js
echo.
echo 次に、メモ帳で設定ファイル(.env)が開きます。
echo   BASE_URL の「192.168.1.10」を、このパソコンのIPアドレスに書き換えて保存してください。
pause
notepad .env
echo.
echo 続けて、最初の管理者を作ります。
node scripts\create-admin.js
echo.
echo 初期設定が完了しました。次は「2_自動起動の登録.bat」を右クリック→「管理者として実行」してください。
pause
