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
      if (d.clockIn || d.clockOut) rows.push({ e, d });
    }
  }
  rows.sort((a, b) => a.d.date.localeCompare(b.d.date) || a.e.code.localeCompare(b.e.code));
  return { period, rows };
}

// 残業はv61で申請・管理するため、ここでは打刻(出勤・退勤)だけを渡す。
// v61側の残業・公休・有給の記録は上書きされない(overtimeFromRequest は常に false)。
function toV61Record({ e, d }) {
  return {
    staffName: e.name, staffCode: e.code, staffKind: e.kind === 'part' ? 'part' : 'full',
    date: d.date, clockIn: d.clockIn || '', clockOut: d.clockOut || '', overtimeFromRequest: false,
    pattern: e.pattern, slots: [], totalNormalMin: 0, totalNightMin: 0, holidayOver8Min: 0, partTimeOverMin: 0, partTimeMemo: '', isMatch: true,
  };
}

function buildJson(opts) {
  const { period, rows } = collect(opts);
  const payload = {
    format: 'kintai-server-export', version: 1, exportedAt: jstDateTime(Date.now()), period,
    records: rows.map(toV61Record),
  };
  return { buffer: Buffer.from(JSON.stringify(payload, null, 1), 'utf8'), filename: `既存アプリ用_打刻_${period.start}〜${period.end}.json`, count: rows.length };
}

// CSVの1項目。数式として実行されないよう、先頭が = + - @ の文字には ' を付ける
function csvCell(v) {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function buildCsv(opts) {
  const { period, rows } = collect(opts);
  const lines = [['日付', '曜日', '社員コード', '氏名', '区分', '出勤', '退勤', '備考']];
  for (const { e, d } of rows) {
    const notes = [];
    for (const w of d.warnings) if (w.code === 'MISSING_IN' || w.code === 'MISSING_OUT') notes.push(w.text);
    if (d.punchWarnings.length) notes.push('打刻時に確認あり');
    lines.push([d.date, d.dow, e.code, e.name, e.kind === 'part' ? 'パート' : '正社員', d.clockIn, d.clockOut, notes.join(' ')]);
  }
  const text = '﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return { buffer: Buffer.from(text, 'utf8'), filename: `打刻一覧_${period.start}〜${period.end}.csv`, count: rows.length };
}

module.exports = { buildJson, buildCsv, csvCell };
