'use strict';
// 既存アプリ(残業・公休・有給管理 v61)への引き渡し用ファイルを作る
//  - JSON : v61の勤怠記録(overtime_records)と同じ形。v61の「取り込み」ボタンで読み込む
//  - CSV  : 出勤・退勤の打刻一覧(Excelで開ける)
const db = require('./db');
const R = require('../public/js/rules');
const att = require('./attendance');
const { jstDate, jstTime, jstDateTime } = require('./time');

function collect({ anchor, employeeId }) {
  const period = R.getPayrollPeriod(anchor);
  const emps = db.all(`SELECT * FROM employees ${employeeId ? 'WHERE id = ?' : ''} ORDER BY code`, ...(employeeId ? [employeeId] : []));
  const data = att.loadData(period.start, period.end, employeeId || null);
  const rows = [];
  for (const e of emps) {
    for (const d of att.buildDays(e, period.start, period.end, data)) {
      // 差し戻し中の申請は「申請なし」として扱う(打刻だけを渡す)
      const req = d.request && d.request.status !== 'rejected' ? d.request : null;
      rows.push({ e, d, req });
    }
  }
  rows.sort((a, b) => a.d.date.localeCompare(b.d.date) || a.e.code.localeCompare(b.e.code));
  return { period, rows };
}

function toV61Record({ e, d, req }) {
  const base = {
    staffName: e.name, staffCode: e.code, staffKind: e.kind === 'part' ? 'part' : 'full',
    date: d.date, clockIn: d.clockIn || '', clockOut: d.clockOut || '',
    overtimeFromRequest: !!req,
  };
  if (!req) {
    // 申請のない日(打刻だけ)。v61側の既存の残業・公休・有給の記録は上書きしない
    return { ...base, pattern: e.pattern, slots: [], totalNormalMin: 0, totalNightMin: 0, holidayOver8Min: 0, partTimeOverMin: 0, partTimeMemo: '', isMatch: true };
  }
  return {
    ...base,
    workType: req.workType, pattern: req.pattern, halfShift: req.halfShift, breakMinutes: req.breakMinutes,
    slots: req.slots.map(s => ({ start: s.start, end: s.end, memo: s.memo || '', normalMin: s.normalMin, nightMin: s.nightMin })),
    totalNormalMin: req.normalMin, totalNightMin: req.nightMin, holidayOver8Min: req.holidayOver8Min,
    partTimeBaseMin: req.ptBaseMin, partTimeOverMin: req.ptOverMin, partTimeMemo: req.ptMemo,
    ptStart: req.ptStart || '09:00', ptEnd: req.ptEnd || '18:30', isMatch: req.isMatch,
  };
}

function buildJson(opts) {
  const { period, rows } = collect(opts);
  const payload = {
    format: 'kintai-server-export', version: 1, exportedAt: jstDateTime(Date.now()), period,
    records: rows.map(toV61Record),
  };
  return { buffer: Buffer.from(JSON.stringify(payload, null, 1), 'utf8'), filename: `既存アプリ用_打刻と残業_${period.start}〜${period.end}.json`, count: rows.length };
}

// CSVの1項目。数式として実行されないよう、先頭が = + - @ の文字には ' を付ける
function csvCell(v) {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function buildCsv(opts) {
  const { period, rows } = collect(opts);
  const typeLabel = { normal: '通常', half: '半日', holiday: '休日出勤', parttime: 'パート' };
  const lines = [['日付', '曜日', '社員コード', '氏名', '区分', '出勤', '退勤', '残業申請', '備考']];
  for (const { e, d, req } of rows) {
    const notes = [];
    for (const w of d.warnings) if (w.code === 'MISSING_IN' || w.code === 'MISSING_OUT') notes.push(w.text);
    if (d.punchWarnings.length) notes.push('打刻時に確認あり');
    lines.push([d.date, d.dow, e.code, e.name, e.kind === 'part' ? 'パート' : '正社員', d.clockIn, d.clockOut,
      req ? `${typeLabel[req.workType]} ${req.workType === 'parttime' ? `${req.ptOverMin}分` : req.slots.map(s => `${s.start}-${s.end}`).join(' / ')}` : '', notes.join(' ')]);
  }
  const text = '﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return { buffer: Buffer.from(text, 'utf8'), filename: `打刻一覧_${period.start}〜${period.end}.csv`, count: rows.length };
}

module.exports = { buildJson, buildCsv, csvCell };
