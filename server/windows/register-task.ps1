# 勤怠サーバーを「パソコン起動時に自動で起動」するよう登録し、社内ネットワークからの接続だけを許可する
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$taskName = 'KintaiServer'

# .env からポート番号を読む
$port = 3000
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw '.env がありません。先に「1_初期設定.bat」を実行してください。' }
foreach ($line in Get-Content $envFile) { if ($line -match '^\s*PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] } }

# 1) 自動起動(パソコン起動時・誰もログインしていなくても動く)
$action = New-ScheduledTaskAction -Execute $node -Argument 'src\server.js' -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description '勤怠(QR打刻・残業管理)サーバー' | Out-Null

# 2) ファイアウォール: 同じネットワーク(社内LAN)の機器からだけ接続を許可。インターネットからは通らない
$ruleName = 'Kintai Server (LAN only)'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow `
  -RemoteAddress LocalSubnet -Profile Any | Out-Null

# 3) スリープしない設定(電源につないでいる間も、バッテリーの間も。ノートPCはふたを閉じても止まらない)
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-dc 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-dc 0 | Out-Null
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host ''
Write-Host "登録しました。サーバーを起動しました(ポート $port)。" -ForegroundColor Green
Write-Host "このパソコンで http://localhost:$port を開いて確認してください。"
