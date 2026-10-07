'use strict';
// 既存HTML(localStorage "overtime_records")のデータ取り込み
const db = require('./db');
const R = require('../public/js/rules');
const { HttpError } = require('./http');
const { snapshot } = require('./overtime');
const { mapRequest } = require('./attendance');

const normName = s => String(s ?? '').replace(/[\s　]+/g, '');

function parse(records) {
  if (!Array.isArray(records)) throw new HttpError(400, '取り込めるデータの形式ではありません(配列ではありません)。');
  if (records.length > 20000) throw new HttpError(400, 'データが多すぎます。');
  return records.filter(r => r && typeof r === 'object' && R.isDateStr(r.date) && R.WORK_TYPES.includes(r.workType));
}

function preview(records) {
  const valid = parse(records);
  const emps = db.all('SELECT id, code, name, active FROM employees');
  const byName = new Map(emps.map(e => [normName(e.name), e]));
  const names = new Map();
  for (const r of valid) {
    const n = normName(r.staffName);
    if (!names.has(n)) names.set(n, { name: String(r.staffName ?? '').trim(), count: 0 });
    names.get(n).count++;
  }
  return {
    total: records.length, valid: valid.length, invalid: records.length - valid.length,
    names: [...names.entries()].map(([k, v]) => ({ name: v.name, count: v.count, employeeId: byName.get(k)?.id ?? null })),
  };
}

function toMs(date, hhmm) { return Date.parse(`${date}T${hhmm}:00+09:00`); }

function commit({ actor, records, mapping }) {
  const valid = parse(records);
  const map = new Map();
  for (const [name, id] of Object.entries(mapping || {})) if (id) map.set(normName(name), Number(id));
  const result = { imported: 0, skipped: 0, unmatched: 0, recomputeDiff: [], punches: 0 };
  db.tx(() => {
    for (const rec of valid) {
      const empId = map.get(normName(rec.staffName));
      const emp = empId && db.get('SELECT * FROM employees WHERE id=?', empId);
      if (!emp) { result.unmatched++; continue; }
      if (db.get('SELECT 1 AS x FROM overtime_requests WHERE employee_id=? AND work_date=?', emp.id, rec.date)) { result.skipped++; continue; }
      const calc = R.computeRequest({
        date: rec.date, workType: rec.workType, pattern: rec.pattern, halfShift: rec.halfShift,
        breakMinutes: rec.breakMinutes, slots: (Array.isArray(rec.slots) ? rec.slots : []).map(s => ({ start: s.start, end: s.end, memo: s.memo })),
        ptStart: rec.ptStart, ptEnd: rec.ptEnd, partTimeOverMin: rec.partTimeOverMin, partTimeMemo: rec.partTimeMemo,
      });
      let v = calc.value;
      if (!calc.ok) {
        // 日またぎなど、現在のルールでは入力できない過去データは、枠を無理に直さず警告として記録して飛ばす
        result.skipped++;
        result.recomputeDiff.push(`${rec.staffName} ${rec.date}: ${calc.errors.join(' ')}`);
        continue;
      }
      const oldTotal = (Number(rec.totalNormalMin) || 0) + (Number(rec.totalNightMin) || 0);
      if (rec.workType !== 'parttime' && oldTotal !== v.normalMin + v.nightMin) {
        result.recomputeDiff.push(`${rec.staffName} ${rec.date}: 元データの合計 ${oldTotal}分 → 再計算 ${v.normalMin + v.nightMin}分`);
      }
      const now = Date.now();
      const r = db.run(
        `INSERT INTO overtime_requests(employee_id,work_date,work_type,pattern,half_shift,break_min,slots,normal_min,night_min,
           holiday_within8_min,holiday_over8_min,pt_start,pt_end,pt_base_min,pt_over_min,pt_memo,is_match,status,reviewer_id,reviewed_at,
           source,legacy_history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,'import',?,?,?)`,
        emp.id, v.date, v.workType, v.pattern, v.halfShift, v.breakMinutes, JSON.stringify(v.slots), v.normalMin, v.nightMin,
        v.holidayWithin8Min, v.holidayOver8Min, v.ptStart, v.ptEnd, v.ptBaseMin, v.ptOverMin, v.ptMemo, v.isMatch ? 1 : 0,
        actor.id, now, JSON.stringify(Array.isArray(rec.history) ? rec.history.slice(0, 200) : []), now, now);
      result.imported++;
      db.audit({ actor, action: 'overtime.import', entity: 'overtime_request', entityId: Number(r.lastInsertRowid),
        targetEmployeeId: emp.id, workDate: v.date, after: snapshot(mapRequest(db.get('SELECT * FROM overtime_requests WHERE id=?', Number(r.lastInsertRowid)))), reason: '既存システムのデータ取り込み' });
      // 旧データに打刻が残っていれば取り込む
      for (const [type, key] of [['in', 'clockIn'], ['out', 'clockOut']]) {
        const t = rec[key];
        if (R.isTimeStr(t) && !db.get("SELECT 1 AS x FROM punches WHERE employee_id=? AND work_date=? AND type=? AND voided=0", emp.id, v.date, type)) {
          db.run("INSERT INTO punches(employee_id,type,ts,work_date,hhmm,source,created_by,created_at) VALUES(?,?,?,?,?,'import',?,?)",
            emp.id, type, toMs(v.date, t), v.date, t, actor.id, now);
          result.punches++;
        }
      }
    }
  });
  result.recomputeDiff = result.recomputeDiff.slice(0, 50);
  return result;
}

module.exports = { preview, commit };
