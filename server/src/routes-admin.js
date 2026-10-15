'use strict';
// 管理者専用API(すべて auth:'admin' でサーバー側の権限チェックを通る)
const db = require('./db');
const C = require('./crypto');
const R = require('../public/js/rules');
const auth = require('./auth');
const tokens = require('./tokens');
const att = require('./attendance');
const ot = require('./overtime');
const importer = require('./importer');
const backup = require('./backup');
const exportV61 = require('./export-v61');
const { HttpError } = require('./http');
const { jstDate } = require('./time');
const { baseUrl } = require('./routes-user');

const A = { auth: 'admin' };
const str = (v, n) => R.cleanText(v, n);
const empRow = e => ({
  id: e.id, code: e.code, name: e.name, kind: e.kind, pattern: e.pattern, ptStart: e.pt_start, ptEnd: e.pt_end,
  ptBreak: e.pt_break, role: e.role, active: !!e.active, mustChangePw: !!e.must_change_pw,
});
const getEmp = id => {
  const e = db.get('SELECT * FROM employees WHERE id=?', Number(id));
  if (!e) throw new HttpError(404, '社員が見つかりません。');
  return e;
};
const reqReason = body => {
  const r = str(body.reason, 300);
  if (!r) throw new HttpError(400, '修正の理由を入力してください。');
  return r;
};

function parseEmployeeInput(b, partial) {
  const o = {};
  const code = str(b.code, 20);
  if (!partial || b.code !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) throw new HttpError(400, '社員コードは半角英数字・-・_ の20文字以内で入力してください。');
    o.code = code;
  }
  if (!partial || b.name !== undefined) {
    const name = str(b.name, 50).replace(/[\s\u3000]+/g, '');
    if (!name) throw new HttpError(400, '氏名を入力してください。');
    o.name = name;
  }
  if (!partial || b.kind !== undefined) {
    if (!['full', 'part'].includes(b.kind)) throw new HttpError(400, '勤務区分(正社員/パート)を選んでください。');
    o.kind = b.kind;
  }
  if (!partial || b.pattern !== undefined) {
    if (!['pattern1', 'pattern2'].includes(b.pattern)) throw new HttpError(400, '勤務体系パターンを選んでください。');
    o.pattern = b.pattern;
  }
  if (b.ptStart !== undefined || b.ptEnd !== undefined || b.ptBreak !== undefined || !partial) {
    const s = b.ptStart || '09:00', e = b.ptEnd || '18:30', br = b.ptBreak === undefined ? 90 : Math.round(Number(b.ptBreak));
    if (!R.isTimeStr(s) || !R.isTimeStr(e)) throw new HttpError(400, 'パートの所定時間が正しくありません。');
    if (!Number.isFinite(br) || br < 0 || br > 600) throw new HttpError(400, '休憩時間は0〜600分で入力してください。');
    o.pt_start = s; o.pt_end = e; o.pt_break = br;
  }
  if (b.role !== undefined) {
    if (!['employee', 'admin'].includes(b.role)) throw new HttpError(400, '権限が正しくありません。');
    o.role = b.role;
  }
  return o;
}

function activeAdminCount(exceptId) {
  return db.get("SELECT COUNT(*) AS n FROM employees WHERE role='admin' AND active=1 AND id != ?", exceptId || 0).n;
}

function register(app) {
  const rt = (m, p, o, h) => app[m](p, o, h);

  // ---------- 社員マスタ ----------
  rt('get', '/api/admin/employees', A, () => ({
    employees: db.all('SELECT * FROM employees ORDER BY active DESC, code').map(empRow),
  }));
  rt('post', '/api/admin/employees', A, ctx => {
    const actor = auth.currentUser(ctx);
    const o = parseEmployeeInput(ctx.body, false);
    if (db.get('SELECT 1 AS x FROM employees WHERE code=?', o.code)) throw new HttpError(400, 'その社員コードはすでに使われています。');
    const temp = C.generatePassword();
    const now = Date.now();
    const id = db.tx(() => {
      const r = db.run(
        `INSERT INTO employees(code,name,kind,pattern,pt_start,pt_end,pt_break,role,pw_hash,must_change_pw,active,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,1,1,?,?)`,
        o.code, o.name, o.kind, o.pattern, o.pt_start, o.pt_end, o.pt_break, o.role || 'employee', C.hashPassword(temp), now, now);
      const nid = Number(r.lastInsertRowid);
      db.audit({ actor, action: 'employee.create', entity: 'employee', entityId: nid, targetEmployeeId: nid, after: empRow(getEmp(nid)), reason: '新規登録' });
      return nid;
    });
    return { employee: empRow(getEmp(id)), tempPassword: temp };
  });
  rt('put', '/api/admin/employees/:id', A, ctx => {
    const actor = auth.currentUser(ctx);
    const e = getEmp(ctx.params.id);
    const o = parseEmployeeInput(ctx.body, true);
    if (o.code && o.code !== e.code && db.get('SELECT 1 AS x FROM employees WHERE code=?', o.code)) throw new HttpError(400, 'その社員コードはすでに使われています。');
    let active = e.active;
    if (ctx.body.active !== undefined) active = ctx.body.active ? 1 : 0;
    const role = o.role || e.role;
    if (e.id === actor.id && (!active || role !== 'admin')) throw new HttpError(400, '自分自身の無効化・権限の引き下げはできません。');
    if (e.role === 'admin' && (!active || role !== 'admin') && activeAdminCount(e.id) < 1) throw new HttpError(400, '管理者が0人になるため変更できません。');
    const before = empRow(e);
    db.tx(() => {
      const m = { code: e.code, name: e.name, kind: e.kind, pattern: e.pattern, pt_start: e.pt_start, pt_end: e.pt_end, pt_break: e.pt_break, ...o };
      db.run('UPDATE employees SET code=?,name=?,kind=?,pattern=?,pt_start=?,pt_end=?,pt_break=?,role=?,active=?,updated_at=? WHERE id=?',
        m.code, m.name, m.kind, m.pattern, m.pt_start, m.pt_end, m.pt_break, role, active, Date.now(), e.id);
      if (!active || role !== e.role) auth.destroyUserSessions(e.id);
      db.audit({ actor, action: 'employee.update', entity: 'employee', entityId: e.id, targetEmployeeId: e.id, before, after: empRow(getEmp(e.id)), reason: str(ctx.body.reason, 300) });
    });
    return { employee: empRow(getEmp(e.id)) };
  });
  rt('post', '/api/admin/employees/:id/reset-password', A, ctx => {
    const actor = auth.currentUser(ctx);
    const e = getEmp(ctx.params.id);
    const temp = C.generatePassword();
    db.tx(() => {
      db.run('UPDATE employees SET pw_hash=?, must_change_pw=1, updated_at=? WHERE id=?', C.hashPassword(temp), Date.now(), e.id);
      auth.destroyUserSessions(e.id);
      db.run('DELETE FROM login_fails WHERE key=?', 'code:' + e.code);
      db.audit({ actor, action: 'employee.password_reset', entity: 'employee', entityId: e.id, targetEmployeeId: e.id, reason: 'パスワード再設定' });
    });
    return { tempPassword: temp };
  });

  // ---------- 打刻用タブレット ----------
  const tabletRow = t => ({
    id: t.id, name: t.name, active: !!t.active, registered: !!t.secret_hash, registeredAt: t.registered_at, lastSeenAt: t.last_seen_at,
    regPending: !!(t.reg_code_hash && t.reg_expires_at > Date.now()),
  });
  rt('get', '/api/admin/tablets', A, () => ({ tablets: db.all('SELECT * FROM tablets ORDER BY active DESC, id').map(tabletRow) }));
  rt('post', '/api/admin/tablets', A, ctx => {
    const actor = auth.currentUser(ctx);
    const name = str(ctx.body.name, 50);
    if (!name) throw new HttpError(400, 'タブレット名を入力してください。');
    const t = tokens.createTablet(name);
    db.audit({ actor, action: 'tablet.create', entity: 'tablet', entityId: t.id, after: { 名前: name }, reason: 'タブレット登録' });
    return { id: t.id, registerUrl: `${baseUrl(ctx)}/tablet?reg=${t.code}` };
  });
  rt('post', '/api/admin/tablets/:id/reissue', A, ctx => {
    const actor = auth.currentUser(ctx);
    const t = db.get('SELECT * FROM tablets WHERE id=? AND active=1', Number(ctx.params.id));
    if (!t) throw new HttpError(404, 'タブレットが見つかりません。');
    const code = tokens.reissueRegCode(t.id);
    db.audit({ actor, action: 'tablet.reissue', entity: 'tablet', entityId: t.id, reason: '登録コード再発行(以前の登録は無効)' });
    return { registerUrl: `${baseUrl(ctx)}/tablet?reg=${code}` };
  });
  rt('post', '/api/admin/tablets/:id/revoke', A, ctx => {
    const actor = auth.currentUser(ctx);
    const t = db.get('SELECT * FROM tablets WHERE id=?', Number(ctx.params.id));
    if (!t) throw new HttpError(404, 'タブレットが見つかりません。');
    db.run('UPDATE tablets SET active=0, secret_hash=NULL, reg_code_hash=NULL WHERE id=?', t.id);
    db.audit({ actor, action: 'tablet.revoke', entity: 'tablet', entityId: t.id, before: { 名前: t.name }, reason: 'タブレット解除' });
  });

  // ---------- 日別・月別 ----------
  rt('get', '/api/admin/day', A, ctx => {
    const date = R.isDateStr(ctx.query.date) ? ctx.query.date : jstDate(Date.now());
    const emps = db.all('SELECT * FROM employees WHERE active=1 ORDER BY code');
    const data = att.loadData(date, date, null);
    const today = jstDate(Date.now());
    return {
      date, dow: R.dayOfWeek(date),
      rows: emps.map(e => ({ employee: empRow(e), ...att.buildDay(e, date, data.pm.get(e.id + '|' + date), data.rm.get(e.id + '|' + date), today) })),
    };
  });
  rt('get', '/api/admin/period', A, ctx => {
    const anchor = R.isDateStr(ctx.query.anchor) ? ctx.query.anchor : jstDate(Date.now());
    const period = R.getPayrollPeriod(anchor);
    const emps = db.all(`SELECT * FROM employees WHERE active=1 OR id IN (SELECT employee_id FROM punches WHERE work_date BETWEEN ? AND ?)
                         OR id IN (SELECT employee_id FROM overtime_requests WHERE work_date BETWEEN ? AND ?) ORDER BY code`,
      period.start, period.end, period.start, period.end);
    const data = att.loadData(period.start, period.end, null);
    const rows = emps.map(e => {
      const days = att.buildDays(e, period.start, period.end, data);
      const approved = days.filter(d => d.request && d.request.status === 'approved').map(d => d.request);
      return {
        employee: empRow(e), days, totals: R.totalsOf(approved),
        pending: days.filter(d => d.request && d.request.status === 'pending').length,
        warnings: days.reduce((a, d) => a + d.warnings.length, 0),
        workDays: days.filter(d => d.clockIn || d.clockOut).length,
      };
    });
    const all = [];
    for (const r of rows) for (const d of r.days) if (d.request && d.request.status === 'approved') all.push(d.request);
    return { period, rows, grand: R.totalsOf(all), today: jstDate(Date.now()) };
  });
  rt('get', '/api/admin/missing', A, ctx => {
    const anchor = R.isDateStr(ctx.query.anchor) ? ctx.query.anchor : jstDate(Date.now());
    const period = R.getPayrollPeriod(anchor);
    const emps = db.all('SELECT * FROM employees WHERE active=1 ORDER BY code');
    const data = att.loadData(period.start, period.end, null);
    const items = [];
    for (const e of emps) {
      for (const d of att.buildDays(e, period.start, period.end, data)) {
        const miss = d.warnings.filter(w => w.code === 'MISSING_IN' || w.code === 'MISSING_OUT');
        if (miss.length) items.push({ employee: empRow(e), date: d.date, dow: d.dow, clockIn: d.clockIn, clockOut: d.clockOut, text: miss.map(m => m.text).join(' ') });
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.employee.code.localeCompare(b.employee.code));
    return { period, items };
  });

  // ---------- 打刻の修正(元の打刻は消さず無効扱いにして、新しい打刻を追加) ----------
  rt('post', '/api/admin/punch-fix', A, ctx => {
    const actor = auth.currentUser(ctx);
    const emp = getEmp(ctx.body.employeeId);
    const { date, type } = ctx.body;
    const hhmm = ctx.body.hhmm || '';
    const reason = reqReason(ctx.body);
    if (!R.isDateStr(date)) throw new HttpError(400, '日付が正しくありません。');
    if (!['in', 'out'].includes(type)) throw new HttpError(400, '出勤・退勤を選んでください。');
    if (hhmm && !R.isTimeStr(hhmm)) throw new HttpError(400, '時刻が正しくありません。');
    const ts = hhmm ? Date.parse(`${date}T${hhmm}:00+09:00`) : 0;
    if (hhmm && ts > Date.now()) throw new HttpError(400, '未来の時刻は登録できません。');
    const now = Date.now();
    const before = att.inOut(att.todayPunches(emp.id, date));
    db.tx(() => {
      db.run(`UPDATE punches SET voided=1, voided_at=?, voided_by=?, void_reason=? WHERE employee_id=? AND work_date=? AND type=? AND voided=0`,
        now, actor.id, reason, emp.id, date, type);
      if (hhmm) {
        db.run("INSERT INTO punches(employee_id,type,ts,work_date,hhmm,source,created_by,created_at) VALUES(?,?,?,?,?,'admin',?,?)",
          emp.id, type, ts, date, hhmm, actor.id, now);
      }
      const after = att.inOut(att.todayPunches(emp.id, date));
      db.audit({ actor, action: 'punch.fix', entity: 'punch', targetEmployeeId: emp.id, workDate: date,
        before: { 出勤: before.clockIn, 退勤: before.clockOut }, after: { 出勤: after.clockIn, 退勤: after.clockOut }, reason });
    });
  });

  // ---------- 修正履歴 ----------
  rt('get', '/api/admin/audit', A, ctx => {
    const where = [], args = [];
    if (ctx.query.employeeId) { where.push('target_employee_id=?'); args.push(Number(ctx.query.employeeId)); }
    if (R.isDateStr(ctx.query.start)) { where.push('work_date>=?'); args.push(ctx.query.start); }
    if (R.isDateStr(ctx.query.end)) { where.push('work_date<=?'); args.push(ctx.query.end); }
    const limit = Math.min(500, Math.max(1, Number(ctx.query.limit) || 200));
    const rows = db.all(
      `SELECT a.*, e.name AS target_name FROM audit_log a LEFT JOIN employees e ON e.id=a.target_employee_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${limit}`, ...args);
    return { items: rows.map(r => ({
      id: r.id, at: r.at, actor: r.actor_name, action: r.action, targetName: r.target_name || '', workDate: r.work_date || '',
      before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null, reason: r.reason,
    })) };
  });

  // ---------- Excel出力・取り込み・バックアップ ----------
  // 既存アプリ(v61)へ渡すファイル(締め期間ごと)
  const periodOpts = ctx => ({
    anchor: R.isDateStr(ctx.query.anchor) ? ctx.query.anchor : jstDate(Date.now()),
    employeeId: ctx.query.employeeId ? Number(ctx.query.employeeId) : null,
  });
  rt('get', '/api/admin/export-v61.json', A, ctx => {
    const out = exportV61.buildJson(periodOpts(ctx));
    if (!out.count) throw new HttpError(404, 'この期間に、出力できる打刻・残業のデータがありません。');
    app.sendBuffer(ctx.res, ctx, out.buffer, 'application/json; charset=utf-8', out.filename);
  });
  rt('get', '/api/admin/export-punches.csv', A, ctx => {
    const out = exportV61.buildCsv(periodOpts(ctx));
    if (!out.count) throw new HttpError(404, 'この期間に、出力できる打刻のデータがありません。');
    app.sendBuffer(ctx.res, ctx, out.buffer, 'text/csv; charset=utf-8', out.filename);
  });
  rt('post', '/api/admin/import/preview', { ...A, bodyLimit: 20 * 1024 * 1024 }, ctx => importer.preview(ctx.body.records));
  rt('post', '/api/admin/import/commit', { ...A, bodyLimit: 20 * 1024 * 1024 }, ctx => {
    const actor = auth.currentUser(ctx);
    return importer.commit({ actor, records: ctx.body.records, mapping: ctx.body.mapping });
  });
  rt('get', '/api/admin/backups', A, () => ({ backups: backup.listBackups() }));
  rt('post', '/api/admin/backups', A, ctx => {
    const actor = auth.currentUser(ctx);
    const f = backup.runBackup();
    db.audit({ actor, action: 'backup.manual', entity: 'system', reason: '手動バックアップ' });
    return { file: require('node:path').basename(f) };
  });
}

module.exports = { register };
