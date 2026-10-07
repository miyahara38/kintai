'use strict';
// データベースの自動バックアップ(SQLiteの VACUUM INTO で、動作中でも矛盾のないコピーを作る)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');
const db = require('./db');
const { jstDate, jstTime, jstDateTime } = require('./time');

const NAME_RE = /^kintai-(\d{8})-(\d{6})\.db$/;

function listBackups() {
  if (!fs.existsSync(config.BACKUP_DIR)) return [];
  return fs.readdirSync(config.BACKUP_DIR).filter(f => NAME_RE.test(f)).sort().reverse().map(f => {
    const st = fs.statSync(path.join(config.BACKUP_DIR, f));
    return { file: f, size: st.size, mtime: st.mtimeMs };
  });
}

function verifyFile(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'; } finally { d.close(); }
}

function runBackup() {
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  const stamp = jstDateTime(Date.now()).replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const file = path.join(config.BACKUP_DIR, `kintai-${stamp}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.open().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (!verifyFile(file)) { fs.unlinkSync(file); throw new Error('バックアップの検査に失敗しました。'); }
  prune();
  return file;
}

// 古い世代を削除(BACKUP_KEEP_DAYS日分を残す)
function prune() {
  const limit = Date.now() - config.BACKUP_KEEP_DAYS * 86400000;
  for (const b of listBackups()) {
    if (b.mtime < limit) { try { fs.unlinkSync(path.join(config.BACKUP_DIR, b.file)); } catch { /* ignore */ } }
  }
}

function hasBackupToday() {
  const today = jstDate(Date.now()).replace(/-/g, '');
  return listBackups().some(b => b.file.startsWith(`kintai-${today}-`));
}

// 毎日 BACKUP_TIME に実行。その時刻にPCが止まっていた場合は、起動後に取り直す。
function startScheduler(log = console.log) {
  const tick = () => {
    try {
      if (jstTime(Date.now()) >= config.BACKUP_TIME && !hasBackupToday()) {
        const f = runBackup();
        log(`バックアップ完了: ${f}`);
      }
    } catch (e) { console.error('バックアップに失敗しました:', e.message); }
  };
  setTimeout(tick, 5000);
  return setInterval(tick, 60000);
}

module.exports = { runBackup, listBackups, startScheduler, verifyFile, prune };
