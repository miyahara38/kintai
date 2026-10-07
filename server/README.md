# 勤怠システム(QR打刻 + 残業管理)

社内LAN専用。Node.js 22以上 + SQLite(標準機能)。外部ライブラリ・外部通信なし(QR生成ライブラリは `vendor/` に同梱)。

- 使い方・設置手順 … [docs/MANUAL.md](docs/MANUAL.md)
- セキュリティレビュー … [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)

## 開発者向け

```
npm run setup          # .env を作る(秘密鍵を自動生成)
npm run create-admin   # 最初の管理者を作る
npm start              # 起動(http://localhost:3000)
npm test               # 自動テスト(既存HTMLとの計算一致テストを含む)
```

| 場所 | 内容 |
|---|---|
| `src/` | サーバー(`server.js` 起動、`routes-*.js` API、`attendance.js` 打刻と警告、`overtime.js` 残業申請、`exporter.js`/`xlsx.js` Excel、`backup.js`、`importer.js`) |
| `public/js/rules.js` | 勤務ルールの計算(画面とサーバーで共通。既存HTMLから移植) |
| `public/` | 画面(`tablet.html` / `punch.html` / `admin.html`) |
| `windows/` | Windows用の設置・起動・停止・復元の `.bat` |
| `test/` | 自動テスト(`test/legacy/` は既存HTML。計算一致テストの比較元) |
