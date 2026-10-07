'use strict';
process.env.TZ = 'Asia/Tokyo';
const { config, assertSecrets } = require('./config');
const db = require('./db');
const auth = require('./auth');
const { App, createServer } = require('./http');
const backup = require('./backup');

// ログをファイルにも残す(logs/server.log。5MBを超えたら古いものに切り替える)
const fs = require('node:fs');
const path = require('node:path');
const logDir = path.join(config.ROOT, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'server.log');
function writeLog(level, args) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, path.join(logDir, 'server.old.log'));
    const text = args.map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    fs.appendFileSync(logFile, `${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} [${level}] ${text}\n`);
  } catch { /* ログに書けなくても動作は続ける */ }
}
const origLog = console.log.bind(console), origErr = console.error.bind(console);
console.log = (...a) => { origLog(...a); writeLog('INFO', a); };
console.error = (...a) => { origErr(...a); writeLog('ERROR', a); };

assertSecrets();
db.open();
const app = new App();
app.authHook = auth.authHook;
require('./routes-user').register(app);
require('./routes-admin').register(app);

const server = createServer(app);
server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`勤怠システムを起動しました: http://localhost:${config.PORT}  (QR用アドレス: ${config.BASE_URL || '未設定'})`);
});
auth.cleanupExpired();
setInterval(auth.cleanupExpired, 3600 * 1000);
backup.startScheduler();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('停止します…'); server.close(() => { try { db.open().close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 3000); });
}
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
process.on('uncaughtException', e => { console.error('uncaughtException', e); process.exit(1); }); // 自動再起動に任せる
