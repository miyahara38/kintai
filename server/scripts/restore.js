'use strict';
// バックアップから復元する。必ずサーバーを止めてから実行すること。
//   使い方: node scripts/restore.js backups\kintai-20260101-020000.db
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../src/config');
const backup = require('../src/backup');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('復元するバックアップファイルを指定してください。\n  例: node scripts/restore.js backups\\kintai-20260101-020000.db'); process.exit(1); }
if (!backup.verifyFile(src)) { console.error('このバックアップファイルは壊れています。別の日付のものを試してください。'); process.exit(1); }

const dest = config.DB_PATH;
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) {
  const keep = path.join(path.dirname(dest), `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  fs.copyFileSync(dest, keep);
  console.log('現在のデータを退避しました:', keep);
}
for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dest + ext); } catch { /* なければ何もしない */ } }
fs.copyFileSync(src, dest);
console.log('復元しました。サーバーを起動してください。');
