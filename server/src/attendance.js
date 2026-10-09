'use strict';
// 打刻の記録と、その日の勤怠(打刻+残業申請)の組み立て・食い違い警告
const { config } = require('./config');
const db = require('./db');
const R = require('../public/js/rules');
const { jstDate, jstTime } = require('./time');
const tokens = require('./tokens');
const { HttpError } = require('./http');

// ---------- 打刻の記録 ----------
function todayPunches(employeeId, date) {
  return db.all('SELECT * FROM punches WHERE employee_id=? AND work_date=? AND voided=0 ORDER BY ts, id', employeeId, date);
}

// 現在の打刻状態(スマホ画面の表示用)
function punchState(employeeId) {
  const date = jstDate(Date.now());
  const list = todayPunches(employeeId, date);
  const last = list[list.length - 1] || null;
  return {
    date,
    punches: list.map(p => ({ id: p.id, type: p.type, hhmm: p.hhmm })),
    status: !last ? 'none' : (last.type === 'in' ? 'working' : 'left'),
  };
}

function recordPunch(user, type, token, confirm) {
  if (type !== 'in' && type !== 'out') throw new HttpError(400, '出勤・退勤を選んでください。');
  const v = tokens.verifyToken(token);
  const retry = 'もう一度QRコードを読み取ってください。';
  if (!v.ok) throw new HttpError(400, v.reason === 'expired' ? `QRコードの有効期限が切れています。${retry}` : `QRコードが正しくありません。${retry}`, { retryQr: true });
  if (tokens.isUsed(v.id)) throw new HttpError(400, `このQRコードはすでに使われました。${retry}`, { retryQr: true });

  const now = Date.now();
  const date = jstDate(now);
  return db.tx(() => {
    // 短時間の二重打刻防止
    const recent = db.get('SELECT ts FROM punches WHERE employee_id=? AND voided=0 ORDER BY ts DESC LIMIT 1', user.id);
    if (recent && now - recent.ts < config.PUNCH_COOLDOWN_SECONDS * 1000) {
      const wait = Math.ceil((config.PUNCH_COOLDOWN_SECONDS * 1000 - (now - recent.ts)) / 1000);
      throw new HttpError(429, `続けて打刻はできません。あと${wait}秒ほど待ってください。(すでに打刻済みの可能性があります)`);
    }
    const list = todayPunches(user.id, date);
    const last = list[list.length - 1] || null;
    let warning = '';
    if (type === 'in' && last && last.type === 'in') warning = `すでに ${last.hhmm} に出勤を打刻しています。もう一度出勤を打刻しますか?`;
    if (type === 'out' && !list.some(p => p.type === 'in')) warning = '今日はまだ出勤の打刻がありません。このまま退勤を打刻しますか?';
    else if (type === 'out' && last && last.type === 'out') warning = `すでに ${last.hhmm} に退勤を打刻しています。退勤時刻を更新しますか?`;
    if (warning && !confirm) throw new HttpError(409, warning, { needConfirm: true });

    if (!tokens.consume(v.id)) throw new HttpError(400, `このQRコードはすでに使われました。${retry}`, { retryQr: true });
    const r = db.run(
      `INSERT INTO punches(employee_id,type,ts,work_date,hhmm,source,token_id,tablet_id,warning,created_by,created_at)
       VALUES(?,?,?,?,?,'qr',?,?,?,?,?)`,
      user.id, type, now, date, jstTime(now), v.id, v.tabletId, warning || null, user.id, now);
    return { id: Number(r.lastInsertRowid), type, hhmm: jstTime(now), date, warning };
  });
}

// ---------- 勤怠の組み立て ----------
const mapRequest = r => r && ({
  id: r.id, employeeId: r.employee_id, date: r.work_date, workType: r.work_type, pattern: r.pattern, halfShift: r.half_shift,
  breakMinutes: r.break_min, slots: JSON.parse(r.slots || '[]'),
  normalMin: r.normal_min, nightMin: r.night_min, holidayWithin8Min: r.holiday_within8_min, holidayOver8Min: r.holiday_over8_min,
  ptStart: r.pt_start, ptEnd: r.pt_end, ptBaseMin: r.pt_base_min, ptOverMin: r.pt_over_min, ptMemo: r.pt_memo,
  isMatch: !!r.is_match, status: r.status, reviewerId: r.reviewer_id, reviewedAt: r.reviewed_at,
  reviewComment: r.review_comment, source: r.source, updatedAt: r.updated_at,
});

function loadData(start, end, employeeId) {
  const ep = employeeId ? ' AND employee_id = ?' : '';
  const args = employeeId ? [start, end, employeeId] : [start, end];
  const punches = db.all(`SELECT * FROM punches WHERE work_date BETWEEN ? AND ? AND voided=0${ep} ORDER BY ts, id`, ...args);
  const requests = db.all(`SELECT * FROM overtime_requests WHERE work_date BETWEEN ? AND ?${ep}`, ...args).map(mapRequest);
  const pm = new Map(), rm = new Map();
  for (const p of punches) {
    const k = p.employee_id + '|' + p.work_date;
    if (!pm.has(k)) pm.set(k, []);
    pm.get(k).push(p);
  }
  for (const r of requests) rm.set(r.employeeId + '|' + r.date, r);
  return { pm, rm };
}

function inOut(list) {
  const ins = (list || []).filter(p => p.type === 'in');
  const outs = (list || []).filter(p => p.type === 'out');
  return { clockIn: ins.length ? ins[0].hhmm : '', clockOut: outs.length ? outs[outs.length - 1].hhmm : '' };
}

// 食い違い警告(許容誤差なし。1分でも違えば警告する)
function dayWarnings(emp, date, clockIn, clockOut, req, today) {
  const W = [];
  const eff = req && req.status !== 'rejected' ? req : null;
  const T = R.timeToMinutes;
  const inM = clockIn ? T(clockIn) : null;
  const outM = clockOut ? T(clockOut) : null;
  const isPart = eff ? eff.workType === 'parttime' : emp.kind === 'part';
  const add = (code, text) => W.push({ code, text });

  if (isPart) {
    const ptStart = eff ? eff.ptStart : emp.pt_start;
    const ptEnd = eff ? eff.ptEnd : emp.pt_end;
    const over = eff ? eff.ptOverMin : 0;
    const expectedOut = T(ptEnd) + over;
    if (outM !== null) {
      if (outM > expectedOut) { if (config.WARN_NO_REQUEST) add('NO_REQUEST', over > 0
        ? `退勤打刻 ${clockOut} が、所定終了+申請残業(${R.minutesToTime(Math.min(expectedOut, 1439))})より後です。`
        : `所定終了 ${ptEnd} より後(${clockOut})の打刻がありますが、残業申請がありません。`); }
      else if (over > 0 && outM < expectedOut) add('REQ_AFTER_OUT', `残業申請(${over}分)の終了見込み ${R.minutesToTime(Math.min(expectedOut, 1439))} より、退勤打刻 ${clockOut} が早いです。`);
    }
    if (eff && over > 0 && inM === null && outM === null) add('NO_PUNCH', '残業申請がありますが、この日の打刻がありません。');
    return finish(W, emp, date, clockIn, clockOut, today, ptStart);
  }

  const workType = eff ? eff.workType : 'normal';
  const rule = R.getShiftRule({ date, workType, pattern: eff ? eff.pattern : emp.pattern, halfShift: eff ? eff.halfShift : 'am0900' });
  const schedEnd = rule && rule.end ? T(rule.end) : null;
  const slots = eff ? eff.slots : [];
  const lastSlotEnd = slots.length ? Math.max(...slots.map(s => T(s.end))) : null;

  for (const s of slots) {
    if (outM !== null && T(s.end) > outM) add('REQ_AFTER_OUT', `残業申請の終了 ${s.end} が、退勤打刻 ${clockOut} より後です。`);
    if (inM !== null && T(s.start) < inM) add('REQ_BEFORE_IN', `残業申請の開始 ${s.start} が、出勤打刻 ${clockIn} より前です。`);
  }
  if (outM !== null) {
    const limit = Math.max(schedEnd ?? -1, lastSlotEnd ?? -1);
    if (config.WARN_NO_REQUEST && limit >= 0 && outM > limit) {
      add('NO_REQUEST', slots.length
        ? `退勤打刻 ${clockOut} が、残業申請の終了 ${R.minutesToTime(limit)} より後です(申請のない残業の可能性)。`
        : `定時 ${rule.end} より後(${clockOut})の打刻があるのに、残業申請がありません。`);
    }
  }
  if (!eff && schedEnd === null && (inM !== null || outM !== null)) {
    W.length = 0;
    add('HOLIDAY_NO_REQUEST', '休日(日曜)に打刻がありますが、休日出勤の申請がありません。');
  }
  if (eff && slots.length && inM === null && outM === null) add('NO_PUNCH', '残業申請がありますが、この日の打刻がありません。');
  if (eff && eff.workType === 'holiday' && eff.nightMin > 0) add('HOLIDAY_NIGHT', '休日出勤に深夜(22時〜5時)の残業が含まれています。内容を確認してください。');
  return finish(W, emp, date, clockIn, clockOut, today, rule && rule.start);
}

function finish(W, emp, date, clockIn, clockOut, today) {
  if (clockIn && !clockOut && date < today) W.push({ code: 'MISSING_OUT', text: '退勤の打刻漏れがあります。' });
  if (!clockIn && clockOut) W.push({ code: 'MISSING_IN', text: '出勤の打刻漏れがあります。' });
  return W;
}

function buildDay(emp, date, punchList, req, today) {
  const { clockIn, clockOut } = inOut(punchList);
  return {
    date, dow: R.dayOfWeek(date), clockIn, clockOut,
    punchWarnings: (punchList || []).filter(p => p.warning).map(p => p.warning),
    request: req || null,
    warnings: dayWarnings(emp, date, clockIn, clockOut, req, today),
  };
}

// 期間内の「打刻または申請のある日」を列挙して返す
function buildDays(emp, start, end, data) {
  const today = jstDate(Date.now());
  const dates = new Set();
  for (const k of data.pm.keys()) { const [id, d] = k.split('|'); if (+id === emp.id) dates.add(d); }
  for (const k of data.rm.keys()) { const [id, d] = k.split('|'); if (+id === emp.id) dates.add(d); }
  return [...dates].sort().map(d => buildDay(emp, d, data.pm.get(emp.id + '|' + d), data.rm.get(emp.id + '|' + d), today));
}

module.exports = { punchState, recordPunch, loadData, buildDay, buildDays, inOut, mapRequest, dayWarnings, todayPunches };
