'use strict';
// 社員・タブレット向けAPI
const { config } = require('./config');
const db = require('./db');
const C = require('./crypto');
const R = require('../public/js/rules');
const auth = require('./auth');
const tokens = require('./tokens');
const att = require('./attendance');
const ot = require('./overtime');
const { HttpError } = require('./http');
const { jstDate, jstTime } = require('./time');
const QR = require('../vendor/qrcode/core/qrcode');

const baseUrl = ctx => config.BASE_URL || `http://${ctx.req.headers.host}`;
const str = (v, max) => R.cleanText(v, max);

function qrPath(text) {
  const q = QR.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size, data = q.modules.data;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (data[y * n + x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  }
  return { size: n + 8, path: d };
}

function register(app) {
  const rt = (m, p, o, h) => app[m](p, o, h);

  // ---------- ログイン ----------
  rt('post', '/api/login', {}, ctx => {
    const code = str(ctx.body.code, 64), password = String(ctx.body.password ?? '').slice(0, 200);
    if (!code || !password) throw new HttpError(400, '社員コードとパスワードを入力してください。');
    const u = auth.login(ctx, code, password);
    return { user: auth.publicUser(u) };
  });
  rt('post', '/api/logout', {}, ctx => { auth.logout(ctx); });

  rt('get', '/api/me', {}, ctx => {
    const u = auth.currentUser(ctx);
    if (!u) return { user: null };
    return { user: auth.publicUser(u), punch: att.punchState(u.id), today: jstDate(Date.now()) };
  });

  rt('post', '/api/me/password', { auth: 'user', allowMustChange: true }, ctx => {
    const u = auth.currentUser(ctx);
    const { current, next } = ctx.body;
    if (!C.verifyPassword(String(current ?? ''), u.pw_hash)) throw new HttpError(400, '現在のパスワードが違います。');
    const err = auth.validatePassword(next);
    if (err) throw new HttpError(400, err);
    if (next === current) throw new HttpError(400, '現在と違うパスワードにしてください。');
    db.tx(() => {
      db.run('UPDATE employees SET pw_hash=?, must_change_pw=0, updated_at=? WHERE id=?', C.hashPassword(next), Date.now(), u.id);
      auth.destroyUserSessions(u.id, C.sha256(ctx.cookies[auth.SID] || ''));
      db.audit({ actor: u, action: 'employee.password_change', entity: 'employee', entityId: u.id, targetEmployeeId: u.id, reason: '本人による変更' });
    });
  });

  // ---------- 打刻(スマホ) ----------
  rt('get', '/api/punch/check', {}, ctx => {
    const v = tokens.verifyToken(String(ctx.query.t || ''));
    if (!v.ok) return { ok: false, reason: v.reason };
    if (tokens.isUsed(v.id)) return { ok: false, reason: 'used' };
    const u = auth.currentUser(ctx);
    return { ok: true, loggedIn: !!u, remainSec: 0 };
  });
  rt('post', '/api/punch', { auth: 'user' }, ctx => {
    const u = auth.currentUser(ctx);
    const r = att.recordPunch(u, String(ctx.body.type), String(ctx.body.token || ''), ctx.body.confirm === true);
    return { punch: r, state: att.punchState(u.id) };
  });

  // ---------- 自分の勤怠・残業申請 ----------
  rt('get', '/api/me/period', { auth: 'user' }, ctx => {
    const u = auth.currentUser(ctx);
    const anchor = R.isDateStr(ctx.query.anchor) ? ctx.query.anchor : jstDate(Date.now());
    const period = R.getPayrollPeriod(anchor);
    const data = att.loadData(period.start, period.end, u.id);
    const days = att.buildDays(u, period.start, period.end, data);
    const approved = days.filter(d => d.request && d.request.status === 'approved').map(d => d.request);
    return {
      period, today: jstDate(Date.now()), days, totals: R.totalsOf(approved),
      pendingCount: days.filter(d => d.request && d.request.status === 'pending').length,
    };
  });
  rt('get', '/api/me/day', { auth: 'user' }, ctx => {
    const u = auth.currentUser(ctx);
    const date = ctx.query.date;
    if (!R.isDateStr(date)) throw new HttpError(400, '日付が正しくありません。');
    const data = att.loadData(date, date, u.id);
    return att.buildDay(u, date, data.pm.get(u.id + '|' + date), data.rm.get(u.id + '|' + date), jstDate(Date.now()));
  });
  rt('post', '/api/me/overtime', { auth: 'user' }, ctx => {
    const u = auth.currentUser(ctx);
    return ot.save({ actor: u, emp: u, input: ctx.body });
  });
  rt('post', '/api/me/overtime/:id/delete', { auth: 'user' }, ctx => {
    const u = auth.currentUser(ctx);
    const r = ot.getById(ctx.params.id);
    if (!r || r.employeeId !== u.id) throw new HttpError(404, '申請が見つかりません。');
    ot.remove({ actor: u, request: r, asAdmin: false });
  });

  // ---------- 打刻用タブレット ----------
  rt('post', '/api/tablet/register', {}, ctx => {
    tokens.registerTablet(ctx, str(ctx.body.code, 64));
  });
  rt('get', '/api/tablet/qr', {}, ctx => {
    const t = tokens.currentTablet(ctx);
    if (!t) throw new HttpError(403, 'このタブレットは登録されていません。', { unregistered: true });
    db.run('UPDATE tablets SET last_seen_at=? WHERE id=?', Date.now(), t.id);
    const token = tokens.issueToken(t.id);
    const url = `${baseUrl(ctx)}/p?t=${token}`;
    return { token, rotateSec: config.QR_ROTATE_SECONDS, ttlSec: config.QR_TTL_SECONDS, qr: qrPath(url) };
  });
  rt('get', '/api/tablet/state', {}, ctx => {
    const t = tokens.currentTablet(ctx);
    if (!t) throw new HttpError(403, 'このタブレットは登録されていません。', { unregistered: true });
    let tokenUsed = false;
    const v = tokens.verifyToken(String(ctx.query.t || ''));
    if (v.ok && tokens.isUsed(v.id)) tokenUsed = true;
    const now = Date.now();
    const recent = db.all(
      `SELECT p.id, p.type, p.hhmm, e.name FROM punches p JOIN employees e ON e.id=p.employee_id
       WHERE p.work_date=? AND p.voided=0 AND p.source='qr' ORDER BY p.ts DESC, p.id DESC LIMIT 8`, jstDate(now));
    return { tokenUsed, recent: recent.map(r => ({ id: r.id, type: r.type, hhmm: r.hhmm, name: r.name })), date: jstDate(now), time: jstTime(now), nowMs: now };
  });
}

module.exports = { register, baseUrl };
