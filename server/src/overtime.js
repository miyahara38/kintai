'use strict';
// 残業申請の登録・修正・承認
const db = require('./db');
const R = require('../public/js/rules');
const { HttpError } = require('./http');
const { config } = require('./config');
const { jstDate } = require('./time');
const { mapRequest } = require('./attendance');

const AUTO_COMMENT = '自動承認';

const rowToStored = v => ({
  work_date: v.date, work_type: v.workType, pattern: v.pattern, half_shift: v.halfShift, break_min: v.breakMinutes,
  slots: JSON.stringify(v.slots), normal_min: v.normalMin, night_min: v.nightMin,
  holiday_within8_min: v.holidayWithin8Min, holiday_over8_min: v.holidayOver8Min,
  pt_start: v.ptStart, pt_end: v.ptEnd, pt_base_min: v.ptBaseMin, pt_over_min: v.ptOverMin, pt_memo: v.ptMemo,
  is_match: v.isMatch ? 1 : 0,
});

// 監査ログ用に、人が読める形へ
const snapshot = r => r && ({
  日付: r.date, 勤務区分: r.workType, 勤務体系: r.pattern, 半日勤務: r.halfShift, 休憩分: r.breakMinutes,
  残業枠: r.slots, 通常残業分: r.normalMin, 深夜残業分: r.nightMin, 休日8h内分: r.holidayWithin8Min, 休日8h超分: r.holidayOver8Min,
  パート所定分: r.ptBaseMin, パート残業分: r.ptOverMin, パート理由: r.ptMemo, 状態: r.status,
});

function normalizeInput(emp, input) {
  const i = input || {};
  const workType = emp.kind === 'part' ? 'parttime' : (['normal', 'half', 'holiday'].includes(i.workType) ? i.workType : 'normal');
  return {
    date: i.date, workType,
    pattern: emp.pattern, // 勤務体系は社員マスタの値を使う(本人が変えられない)
    halfShift: i.halfShift, breakMinutes: emp.kind === 'part' ? (i.breakMinutes ?? emp.pt_break) : i.breakMinutes,
    slots: i.slots, ptStart: i.ptStart || emp.pt_start, ptEnd: i.ptEnd || emp.pt_end,
    partTimeOverMin: i.partTimeOverMin, partTimeMemo: i.partTimeMemo,
  };
}

function getByEmpDate(empId, date) {
  return mapRequest(db.get('SELECT * FROM overtime_requests WHERE employee_id=? AND work_date=?', empId, date));
}
function getById(id) { return mapRequest(db.get('SELECT * FROM overtime_requests WHERE id=?', Number(id))); }

/**
 * 申請の登録・更新。
 * actor: 操作した人 / emp: 申請の対象社員 / asAdmin: 管理者による代理入力・修正か
 */
function save({ actor, emp, input, asAdmin = false, reason = '' }) {
  const norm = normalizeInput(emp, input);
  const calc = R.computeRequest(norm);
  if (!calc.ok) throw new HttpError(400, calc.errors.join('\n'));
  const v = calc.value;
  if (v.workType !== 'parttime' && v.slots.length === 0) throw new HttpError(400, '残業枠を1つ以上入力してください。');

  if (!asAdmin) {
    const today = jstDate(Date.now());
    if (v.date < R.addDays(today, -config.OVERTIME_PAST_DAYS) || v.date > R.addDays(today, config.OVERTIME_FUTURE_DAYS)) {
      throw new HttpError(400, `申請できるのは ${config.OVERTIME_PAST_DAYS}日前から${config.OVERTIME_FUTURE_DAYS}日先までの日付です。それ以外は管理者に依頼してください。`);
    }
  }
  const existing = getByEmpDate(emp.id, v.date);
  if (existing && !asAdmin && existing.status === 'approved' && !config.OVERTIME_AUTO_APPROVE) {
    throw new HttpError(403, 'この日の申請はすでに承認されています。修正が必要な場合は管理者に依頼してください。');
  }
  if (asAdmin && existing && !reason) throw new HttpError(400, '修正の理由を入力してください。');

  const s = rowToStored(v);
  const now = Date.now();
  const result = db.tx(() => {
    let id;
    if (existing) {
      const auto = !asAdmin && config.OVERTIME_AUTO_APPROVE;
      const status = asAdmin ? existing.status : (auto ? 'approved' : 'pending');
      db.run(
        `UPDATE overtime_requests SET work_type=?,pattern=?,half_shift=?,break_min=?,slots=?,normal_min=?,night_min=?,
           holiday_within8_min=?,holiday_over8_min=?,pt_start=?,pt_end=?,pt_base_min=?,pt_over_min=?,pt_memo=?,is_match=?,
           status=?,reviewer_id=?,reviewed_at=?,review_comment=?,updated_at=? WHERE id=?`,
        s.work_type, s.pattern, s.half_shift, s.break_min, s.slots, s.normal_min, s.night_min, s.holiday_within8_min, s.holiday_over8_min,
        s.pt_start, s.pt_end, s.pt_base_min, s.pt_over_min, s.pt_memo, s.is_match, status,
        auto ? null : (status === 'pending' ? null : existing.reviewerId), auto ? now : (status === 'pending' ? null : existing.reviewedAt),
        auto ? AUTO_COMMENT : (status === 'pending' ? '' : existing.reviewComment), now, existing.id);
      id = existing.id;
    } else {
      const auto = !asAdmin && config.OVERTIME_AUTO_APPROVE;
      const status = (asAdmin || auto) ? 'approved' : 'pending';
      const r = db.run(
        `INSERT INTO overtime_requests(employee_id,work_date,work_type,pattern,half_shift,break_min,slots,normal_min,night_min,
           holiday_within8_min,holiday_over8_min,pt_start,pt_end,pt_base_min,pt_over_min,pt_memo,is_match,status,reviewer_id,reviewed_at,
           source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        emp.id, s.work_date, s.work_type, s.pattern, s.half_shift, s.break_min, s.slots, s.normal_min, s.night_min,
        s.holiday_within8_min, s.holiday_over8_min, s.pt_start, s.pt_end, s.pt_base_min, s.pt_over_min, s.pt_memo, s.is_match, status,
        asAdmin ? actor.id : null, (asAdmin || auto) ? now : null, asAdmin ? 'admin' : 'app', now, now);
      if (auto) db.run('UPDATE overtime_requests SET review_comment=? WHERE id=?', AUTO_COMMENT, Number(r.lastInsertRowid));
      id = Number(r.lastInsertRowid);
    }
    const after = getById(id);
    db.audit({
      actor, action: existing ? 'overtime.update' : 'overtime.create', entity: 'overtime_request', entityId: id,
      targetEmployeeId: emp.id, workDate: v.date, before: snapshot(existing), after: snapshot(after),
      reason: reason || (existing ? '本人による再申請' : (asAdmin ? '管理者による代理入力' : '新規申請')) + (!asAdmin && config.OVERTIME_AUTO_APPROVE ? '(自動承認)' : ''),
    });
    return after;
  });
  return { request: result, warnings: calc.warnings };
}

function remove({ actor, request, reason, asAdmin }) {
  if (!asAdmin && request.status === 'approved' && !config.OVERTIME_AUTO_APPROVE) throw new HttpError(403, '承認済みの申請は取り消せません。管理者に依頼してください。');
  if (asAdmin && !reason) throw new HttpError(400, '取り消しの理由を入力してください。');
  db.tx(() => {
    db.audit({ actor, action: 'overtime.delete', entity: 'overtime_request', entityId: request.id, targetEmployeeId: request.employeeId,
      workDate: request.date, before: snapshot(request), reason: reason || '本人による取り消し' });
    db.run('DELETE FROM overtime_requests WHERE id=?', request.id);
  });
}

function review({ actor, request, status, comment }) {
  if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, '承認または差し戻しを選んでください。');
  if (request.employeeId === actor.id) throw new HttpError(403, '自分自身の申請は承認できません。他の管理者に依頼してください。');
  const c = R.cleanText(comment, 300);
  if (status === 'rejected' && !c) throw new HttpError(400, '差し戻しの理由(コメント)を入力してください。');
  db.tx(() => {
    db.run('UPDATE overtime_requests SET status=?, reviewer_id=?, reviewed_at=?, review_comment=?, updated_at=? WHERE id=?',
      status, actor.id, Date.now(), c, Date.now(), request.id);
    db.audit({ actor, action: status === 'approved' ? 'overtime.approve' : 'overtime.reject', entity: 'overtime_request', entityId: request.id,
      targetEmployeeId: request.employeeId, workDate: request.date, before: { 状態: request.status }, after: { 状態: status }, reason: c });
  });
  return getById(request.id);
}

module.exports = { save, remove, review, getById, getByEmpDate, snapshot };
