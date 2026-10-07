'use strict';
// ログイン・セッション・ロック・権限チェック
const { config } = require('./config');
const db = require('./db');
const C = require('./crypto');
const { HttpError, cookieString } = require('./http');

const SID = 'kintai_sid';

const publicUser = u => ({
  id: u.id, code: u.code, name: u.name, kind: u.kind, pattern: u.pattern,
  ptStart: u.pt_start, ptEnd: u.pt_end, ptBreak: u.pt_break, role: u.role, mustChangePw: !!u.must_change_pw,
});

// ---- ロック管理(社員コード単位とIP単位の両方) ----
function lockState(key) {
  const r = db.get('SELECT * FROM login_fails WHERE key = ?', key);
  return r && r.locked_until > Date.now() ? r : null;
}
function recordFail(key, max, lockMs) {
  const now = Date.now();
  const r = db.get('SELECT * FROM login_fails WHERE key = ?', key);
  let fails = (r && now - r.updated_at < 24 * 3600 * 1000 ? r.fails : 0) + 1;
  let lockedUntil = 0;
  let locked = false;
  if (fails >= max) { lockedUntil = now + lockMs; fails = 0; locked = true; }
  db.run(`INSERT INTO login_fails(key,fails,locked_until,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET fails=excluded.fails, locked_until=excluded.locked_until, updated_at=excluded.updated_at`,
    key, fails, lockedUntil, now);
  return locked;
}
function clearFails(key) { db.run('DELETE FROM login_fails WHERE key = ?', key); }

function login(ctx, code, password) {
  const lockMs = config.LOGIN_LOCK_MINUTES * 60 * 1000;
  const kCode = 'code:' + String(code).slice(0, 64);
  const kIp = 'ip:' + ctx.ip;
  const lock = lockState(kCode) || lockState(kIp);
  if (lock) {
    const min = Math.max(1, Math.ceil((lock.locked_until - Date.now()) / 60000));
    throw new HttpError(429, `ログインに続けて失敗したため、一時的にロックされています。約${min}分後にもう一度お試しください。`);
  }
  const user = db.get('SELECT * FROM employees WHERE code = ?', String(code));
  const ok = C.verifyPassword(String(password), user ? user.pw_hash : C.DUMMY_HASH);
  if (!user || !ok || !user.active) {
    if (recordFail(kCode, config.LOGIN_MAX_FAILS, lockMs)) {
      db.audit({ actor: null, action: 'auth.lock', entity: 'employee', targetEmployeeId: user ? user.id : null,
        reason: `社員コード「${String(code).slice(0, 20)}」へのログイン失敗が続き、${config.LOGIN_LOCK_MINUTES}分間ロックしました(接続元 ${ctx.ip})` });
    }
    recordFail(kIp, config.LOGIN_MAX_FAILS * 4, lockMs);
    throw new HttpError(401, '社員コードまたはパスワードが違います。');
  }
  clearFails(kCode);
  clearFails(kIp);
  if (user.role === 'admin') db.audit({ actor: user, action: 'auth.login', entity: 'employee', entityId: user.id, targetEmployeeId: user.id, reason: `管理者ログイン(接続元 ${ctx.ip})` });
  const sid = C.randomToken(32);
  const days = user.role === 'admin' ? config.SESSION_DAYS_ADMIN : config.SESSION_DAYS_EMPLOYEE;
  const now = Date.now();
  db.run('INSERT INTO sessions(id_hash, employee_id, created_at, expires_at, ip) VALUES(?,?,?,?,?)',
    C.sha256(sid), user.id, now, now + days * 86400000, ctx.ip);
  ctx.setCookies.push(cookieString(SID, sid, { maxAgeSec: days * 86400 }));
  return user;
}

function logout(ctx) {
  const sid = ctx.cookies[SID];
  if (sid) db.run('DELETE FROM sessions WHERE id_hash = ?', C.sha256(sid));
  ctx.setCookies.push(cookieString(SID, '', { maxAgeSec: 0 }));
}

function currentUser(ctx) {
  if (ctx.user !== undefined) return ctx.user;
  ctx.user = null;
  const sid = ctx.cookies[SID];
  if (!sid || sid.length > 100) return null;
  const row = db.get(
    `SELECT e.* FROM sessions s JOIN employees e ON e.id = s.employee_id
     WHERE s.id_hash = ? AND s.expires_at > ? AND e.active = 1`, C.sha256(sid), Date.now());
  ctx.user = row || null;
  return ctx.user;
}

function destroyUserSessions(employeeId, exceptHash) {
  if (exceptHash) db.run('DELETE FROM sessions WHERE employee_id = ? AND id_hash != ?', employeeId, exceptHash);
  else db.run('DELETE FROM sessions WHERE employee_id = ?', employeeId);
}

// ルートごとの権限チェック。画面の表示制御とは無関係に、APIの入口で必ず実行する。
function authHook(ctx, opts) {
  const need = opts.auth;
  if (!need) return;
  const u = currentUser(ctx);
  if (!u) throw new HttpError(401, 'ログインが必要です。', { needLogin: true });
  if (need === 'admin' && u.role !== 'admin') throw new HttpError(403, 'この操作には管理者権限が必要です。');
  if (u.must_change_pw && !opts.allowMustChange) {
    throw new HttpError(403, '最初にパスワードを変更してください。', { mustChangePw: true });
  }
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'パスワードは8文字以上にしてください。';
  if (pw.length > 100) return 'パスワードが長すぎます。';
  if (/^\d+$/.test(pw)) return 'パスワードに数字以外の文字も含めてください。';
  return null;
}

function cleanupExpired() {
  db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  db.run('DELETE FROM login_fails WHERE updated_at < ? AND locked_until < ?', Date.now() - 86400000, Date.now());
  db.run('DELETE FROM used_tokens WHERE used_at < ?', Date.now() - 86400000);
}

module.exports = { SID, publicUser, login, logout, currentUser, destroyUserSessions, authHook, validatePassword, cleanupExpired };
