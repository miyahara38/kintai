'use strict';
// .env を読み込む(外部ライブラリは使わない)。秘密鍵はコードに書かず、ここから取る。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const resolvePath = p => path.isAbsolute(p) ? p : path.resolve(ROOT, p);

const config = {
  ROOT,
  PORT: num('PORT', 3000),
  BASE_URL: (process.env.BASE_URL || '').replace(/\/+$/, ''),
  TOKEN_SECRET: process.env.TOKEN_SECRET || '',
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  DB_PATH: resolvePath(process.env.DB_PATH || './data/kintai.db'),
  QR_ROTATE_SECONDS: num('QR_ROTATE_SECONDS', 30),
  QR_TTL_SECONDS: num('QR_TTL_SECONDS', 60),
  PUNCH_COOLDOWN_SECONDS: num('PUNCH_COOLDOWN_SECONDS', 60),
  LOGIN_MAX_FAILS: num('LOGIN_MAX_FAILS', 5),
  LOGIN_LOCK_MINUTES: num('LOGIN_LOCK_MINUTES', 15),
  BACKUP_DIR: resolvePath(process.env.BACKUP_DIR || './backups'),
  BACKUP_TIME: /^\d{2}:\d{2}$/.test(process.env.BACKUP_TIME || '') ? process.env.BACKUP_TIME : '02:00',
  BACKUP_KEEP_DAYS: num('BACKUP_KEEP_DAYS', 30),
  // 残業申請を、申請と同時に自動承認する(false にすると、管理者が1件ずつ承認する)
  OVERTIME_AUTO_APPROVE: String(process.env.OVERTIME_AUTO_APPROVE ?? 'true').toLowerCase() !== 'false',
  // 「定時後の打刻があるのに残業申請がない」警告を出す(初期値は出さない)
  WARN_NO_REQUEST: String(process.env.WARN_NO_REQUEST).toLowerCase() === 'true',
  COOKIE_SECURE: String(process.env.COOKIE_SECURE).toLowerCase() === 'true',
  PUBLIC_DIR: path.join(ROOT, 'public'),
  TZ: 'Asia/Tokyo',
  SESSION_DAYS_EMPLOYEE: 60,
  SESSION_DAYS_ADMIN: 7,
  OVERTIME_PAST_DAYS: 31,
  OVERTIME_FUTURE_DAYS: 7,
};

function assertSecrets() {
  const bad = [];
  if (config.TOKEN_SECRET.length < 32) bad.push('TOKEN_SECRET');
  if (config.SESSION_SECRET.length < 32) bad.push('SESSION_SECRET');
  if (bad.length) {
    throw new Error(`.env の ${bad.join(' と ')} が未設定、または短すぎます(32文字以上)。「npm run setup」を実行してください。`);
  }
}

module.exports = { config, assertSecrets };
