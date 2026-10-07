'use strict';
// QRコードのワンタイムトークンと、打刻用タブレットの登録
//  トークン = base64url(JSON{ i:ランダムID, t:発行時刻(ms), d:タブレットID }) + "." + HMAC署名
const { config } = require('./config');
const db = require('./db');
const C = require('./crypto');
const { HttpError, cookieString } = require('./http');

const TABLET_COOKIE = 'kintai_tablet';

function issueToken(tabletId) {
  const payload = Buffer.from(JSON.stringify({ i: C.randomToken(12), t: Date.now(), d: tabletId })).toString('base64url');
  return `${payload}.${C.hmac(config.TOKEN_SECRET, payload)}`;
}

// 戻り値: { ok:true, id, tabletId } / { ok:false, reason }
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 300) return { ok: false, reason: 'invalid' };
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !C.safeEqual(sig, C.hmac(config.TOKEN_SECRET, payload))) return { ok: false, reason: 'invalid' };
  let p;
  try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'invalid' }; }
  if (!p || typeof p.i !== 'string' || typeof p.t !== 'number') return { ok: false, reason: 'invalid' };
  const age = Date.now() - p.t;
  if (age > config.QR_TTL_SECONDS * 1000 || age < -5000) return { ok: false, reason: 'expired' };
  const tablet = db.get('SELECT id, active FROM tablets WHERE id = ?', p.d);
  if (!tablet || !tablet.active) return { ok: false, reason: 'invalid' };
  return { ok: true, id: p.i, tabletId: p.d };
}

const isUsed = id => !!db.get('SELECT 1 AS x FROM used_tokens WHERE token_id = ?', id);
// 使用済みにする。すでに使われていたら false(同時アクセスでも1回しか成功しない)
function consume(id) {
  const r = db.run('INSERT OR IGNORE INTO used_tokens(token_id, used_at) VALUES(?,?)', id, Date.now());
  return r.changes === 1;
}

// ---- タブレット登録 ----
function createTablet(name) {
  const code = C.randomToken(9);
  const now = Date.now();
  const r = db.run('INSERT INTO tablets(name, reg_code_hash, reg_expires_at, created_at) VALUES(?,?,?,?)',
    name, C.sha256(code), now + 15 * 60000, now);
  return { id: Number(r.lastInsertRowid), code };
}
function reissueRegCode(id) {
  const code = C.randomToken(9);
  db.run('UPDATE tablets SET reg_code_hash=?, reg_expires_at=?, secret_hash=NULL, registered_at=NULL WHERE id=?',
    C.sha256(code), Date.now() + 15 * 60000, id);
  return code;
}
// 登録コードを使って、このブラウザを「登録済みタブレット」にする
function registerTablet(ctx, code) {
  const row = db.get('SELECT * FROM tablets WHERE reg_code_hash = ? AND active = 1', C.sha256(String(code)));
  if (!row || !row.reg_expires_at || row.reg_expires_at < Date.now()) {
    throw new HttpError(400, '登録コードが無効か、期限(15分)が切れています。管理画面で新しいコードを発行してください。');
  }
  const secret = C.randomToken(32);
  db.run('UPDATE tablets SET secret_hash=?, reg_code_hash=NULL, reg_expires_at=NULL, registered_at=? WHERE id=?',
    C.sha256(secret), Date.now(), row.id);
  ctx.setCookies.push(cookieString(TABLET_COOKIE, `${row.id}.${secret}`, { maxAgeSec: 10 * 365 * 86400, sameSite: 'Strict' }));
  return row;
}
function currentTablet(ctx) {
  const v = ctx.cookies[TABLET_COOKIE];
  if (!v) return null;
  const [id, secret] = v.split('.');
  const row = db.get('SELECT * FROM tablets WHERE id = ? AND active = 1', Number(id));
  if (!row || !row.secret_hash || !secret || !C.safeEqual(C.sha256(secret), row.secret_hash)) return null;
  return row;
}

module.exports = { issueToken, verifyToken, isUsed, consume, createTablet, reissueRegCode, registerTablet, currentTablet };
