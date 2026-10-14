# 引継ぎ: QR出退勤打刻 + 残業管理システム(kintai)

このファイルは、新しいチャット(新しいClaudeセッション)が、これまでの経緯と現在の状態をすぐ把握するためのものです。
**作業ブランチ: `claude/qr-attendance-overtime-system-jummli`**(`main` には入っていない。PRは、ユーザーに頼まれるまで作らない)

## 0. ユーザーについて・進め方のルール
- ユーザーは**プログラミングの専門家ではない**。説明は**平易な日本語**で、手順は1つずつ、画面の写真(スクリーンショット)を見ながら案内する。
- **実装の前に、設計・方針を示して、確認を取る**。仕様に不明点・矛盾があれば、推測せずに質問する。
- ユーザーのPC(Windows 11)は、こちらから操作できない。手順は、ターミナル(PowerShell)に貼り付けるコマンドで案内する。
- コミットには、システムの指示にある共著者の行を付ける。**PRは、頼まれたときだけ**作る。

## 1. システムの概要
社内LAN専用(インターネットに公開しない・外部CDN/外部APIなし)の、QR出退勤打刻 + 残業管理。Node.js 22以上(実機は24.21.0) + 標準SQLite。外部ライブラリは、QR生成(`server/vendor/`に同梱)のみ。
- 場所: **`server/`**(システム本体)、**`v61/`**(既存アプリ「残業・公休・有給管理 v61」+ 取り込み機能)、リポジトリ直下の `index.html` 等(以前の残業アプリ。変更しない)。
- 説明書: `server/docs/MANUAL.md`(非専門家向け)、`server/docs/SECURITY_REVIEW.md`(セキュリティレビュー)、`server/README.md`(開発者向け)。
- 自動テスト: `cd server && npm test`(21件。既存HTMLとの計算一致4,320パターンを含む。比較元は `server/test/legacy/overtime-legacy.html`)。**変更したら必ずテストを通す**。

### 主なファイル
| 場所 | 内容 |
|---|---|
| `server/public/js/rules.js` | 勤務ルール計算(画面とサーバーで共通。既存HTMLから移植。数値の正はサーバー側の再計算) |
| `server/src/server.js` | 起動。`routes-user.js`(社員・タブレット)、`routes-admin.js`(管理者) |
| `server/src/attendance.js` | 打刻の記録、日ごとの勤怠の組み立て、警告 |
| `server/src/overtime.js` | 残業申請(自動承認、承認、差し戻し、履歴) |
| `server/src/tokens.js` | QRトークン(HMAC署名・60秒有効・使い捨て)、タブレット登録 |
| `server/src/exporter.js`, `xlsx.js` | Excel出力(既存HTMLのレイアウト+打刻列) |
| `server/src/export-v61.js` | v61用JSON・打刻CSVの出力 |
| `server/src/importer.js` | 旧HTML版(`overtime_records`)の取り込み |
| `server/src/backup.js` | 毎日02:00の自動バックアップ(30世代) |
| `server/public/{tablet,punch,admin}.html` + `js/` | 画面(HTMLは文字列で組まず `textContent`。CSPでインラインスクリプト禁止) |
| `server/windows/` | Windows用の登録・起動・停止・復元スクリプト |
| `v61/kintai-leave-overtime-v61-import.html` | 取り込み・バックアップ・復元ボタンを足したv61(元は `…-original.html`) |

## 2. 決定事項(ユーザーの回答)
- 昼休みの打刻なし。1日1回の出勤・退勤。管理者は3人まで。社員10名程度、拠点1、打刻用タブレット1台(iPad)。
- 勤務区分(通常/半日/休日出勤)は、社員が申請時に選ぶ(いずれ自動化の予定)。祝日カレンダーは未実装(日曜のみ休日扱い)。
- 休日出勤で深夜に入る場合は**警告の表示のみ**(計算は既存の方式)。日またぎ勤務なし(残業枠は23:59まで)。
- 通信はHTTP(社内Wi-Fi・WPA2以上が前提)。
- **氏名は空白を入れない**(例: 宮原侑希)。サーバー側で空白を自動で除去。既存アプリの名前と一致させるため。
- **残業は、申請と同時に自動承認**(`OVERTIME_AUTO_APPROVE=true`)。本人が自分で修正でき、履歴(修正履歴)に残る。管理者は差し戻し可。`false` で手動承認に戻せる。
- 警告: 「定時後の打刻があるのに残業申請がない」は**非表示**(`WARN_NO_REQUEST=false`。`true`で復活)。残す警告: 申請の終了が退勤より後/申請の開始が出勤より前/打刻漏れ/申請があるのに打刻がない/休日(日曜)の打刻で申請なし/休日深夜。
- **既存アプリ連携の方針**: 打刻と残業の入力は**サーバー**で行い、**締め日に**既存アプリ(v61)へ取り込む(管理画面「月別」→「打刻と残業(既存アプリ用)」)。公休・有給は、既存アプリで管理。v61に足したのは、取り込み・バックアップ・復元のボタンのみ(既存の計算・画面は変更しない)。取り込みは、同じ名前・同じ日の出勤/退勤と申請された残業を更新、公休・有給の記録は変更しない。
- 元の打刻は削除しない(修正は無効化+新規行)。修正履歴は追記専用(DBトリガーで保護)。修正には理由が必須。

## 3. 実機の状態(試験運用中)
- 試験運用PC: Windows 11のノートPC。システムは **`C:\kintai`**。タスクスケジューラの **`KintaiServer`** で、PC起動時に自動起動(SYSTEM権限)。ファイアウォール規則 `Kintai Server (LAN only)`(TCP 3000、同じネットワークのみ)。
- ポート 3000。QRの宛先は `C:\kintai\.env` の **`BASE_URL`**。**PCのIPアドレスは固定されていない**(DHCP)。最近は `192.168.1.17`(以前は `.63`)。ルーターで「DHCP固定割り当て」を設定する予定(ユーザーが実施)。**住所が変わったら、`.env` の `BASE_URL` を直して、サーバーを再起動し、iPadを開き直す(必要なら管理画面「タブレット」で再登録)**。
- **`192.168.1.220`** は、会社の別の機器(本番で使う予定のPC)に割り当て済みの住所。試験運用PCでは使わない。
- WiFi名 `ccaoc-meet`(スマホ・iPad・PCが同じネットワーク)。iPad(タブレット)登録済み。管理者アカウントあり。社員は少人数で試験中。
- 本番(会社のPC)への引っ越し予定: `.env` と `data\kintai.db` を移す。住所が変わると、`BASE_URL` の修正、タブレットの再登録、社員の再ログインが必要。
- 旧アプリ・v61は、ユーザーのPCのブラウザの中(localStorage)にデータを持つ。複数のPCでは、データが別々になる。**取り込みは、管理者が使う1台で行う**。

### 更新のしかた(ユーザー向けに案内してきた手順)
1. GitHubからZIPをダウンロード: `https://github.com/miyahara38/kintai/archive/refs/heads/claude/qr-attendance-overtime-system-jummli.zip`
2. 展開し、`server` の中の **`src`、`public`、`docs`** を `C:\kintai` に上書きコピー(**`.env`、`data`、`backups`、`logs` は上書きしない**)。
3. ターミナルで `Get-ChildItem -Path C:\kintai -Recurse | Unblock-File`
4. `Stop-ScheduledTask -TaskName KintaiServer` → `Start-ScheduledTask -TaskName KintaiServer`
- 1ファイルだけ直す場合は、`Invoke-WebRequest -Uri "https://raw.githubusercontent.com/miyahara38/kintai/claude/qr-attendance-overtime-system-jummli/server/<パス>" -OutFile "C:\kintai\<パス>"` でも更新できた。

### 実機で分かっている注意点
- **スマートアプリコントロール**が、ダウンロードした `.bat` をブロックする。`Unblock-File` でブロックを外すか、`.bat` を使わず、PowerShellのコマンドで案内する(`windows/register-task.ps1` は `powershell -ExecutionPolicy Bypass -File ...` で実行)。
- PCがスリープするとサーバーも止まる。スリープ・ふた閉じ無効の `powercfg` 設定を案内済み(`windows/register-task.ps1` に含む)。iPadの自動ロックは「なし」。
- iPadのSafariでサーバー停止中に画面を更新すると、Safari自身のエラー画面になり、自動復帰しない(開いたままなら、`tablet.js` が自動で復帰する)。
- `Get-Content` は日本語を含むファイルの行数を、`-Encoding UTF8` なしだとずらして数える。

## 4. 未解決・今後の課題
- **ユーザーが、別のチャットで「修正してほしい点」を伝える予定**(内容は未確認。まず聞くこと)。
- 実機での確認がまだのもの: 締め日(毎月15日)のあとの、Excel出力と旧HTMLの数字の見比べ。v61取り込みの実データでの確認(**特にパート社員の所定時間・休憩の計算**)。
- v61は、見た目の部品(Tailwind)を**インターネットから**読み込む。社内LANだけで使う場合は、部品の同梱が必要(未対応・要相談)。v61には、責任者用PINの初期値(`0310`のハッシュ)がプログラムに書かれている(変更していない。ユーザーに伝えてある)。
- ルーターでのIPアドレス固定(ユーザーが実施予定)。バックアップを、週1回、外付けなどにコピーする運用(案内済み)。
- 祝日カレンダー、勤務区分の自動判定は未実装。通信の暗号化(HTTPS)も未実装(リスクはSECURITY_REVIEW.mdに記載)。
- 実際のスマホ(iPhone)のカメラでのQR読み取りと打刻は、動作確認済み。
