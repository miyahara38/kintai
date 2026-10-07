'use strict';
// Excel出力(既存HTMLと同じレイアウト + 出勤・退勤打刻の列)
const db = require('./db');
const R = require('../public/js/rules');
const att = require('./attendance');
const { xlsxBuildWorkbook } = require('./xlsx');
const { jstDate, jstTime } = require('./time');

const F = R.formatHoursMinutes;

function buildPeriodWorkbook({ anchor, employeeId }) {
  const period = R.getPayrollPeriod(anchor);
  const emps = db.all(`SELECT * FROM employees ${employeeId ? 'WHERE id = ?' : ''} ORDER BY code`, ...(employeeId ? [employeeId] : []));
  const data = att.loadData(period.start, period.end, employeeId || null);
  const now = Date.now();
  const stamp = `${jstDate(now)} ${jstTime(now)}`;

  const full = [], part = [];
  for (const e of emps) {
    for (const d of att.buildDays(e, period.start, period.end, data)) {
      if (!d.request || d.request.status !== 'approved') continue;
      (d.request.workType === 'parttime' ? part : full).push({ e, d });
    }
  }
  const byName = (a, b) => a.d.date.localeCompare(b.d.date) || a.e.name.localeCompare(b.e.name, 'ja');
  full.sort(byName); part.sort(byName);
  const sheets = [];
  const label = `月間集計期間: ${period.start}〜${period.end}`;

  if (full.length) {
    const rows = full.map(({ e, d }) => {
      const r = d.request;
      let normal = 0, half = 0, holiday = 0, holiday8 = 0;
      if (r.workType === 'normal') normal = r.normalMin;
      else if (r.workType === 'half') half = r.normalMin;
      else if (r.workType === 'holiday') { holiday = r.holidayWithin8Min; holiday8 = r.holidayOver8Min; }
      const row = [e.name, d.date, d.clockIn, d.clockOut, F(normal), F(r.nightMin), F(half), F(holiday), F(holiday8)];
      for (let i = 0; i < 4; i++) { const s = r.slots[i]; row.push(s ? `${s.start}〜${s.end} (${s.memo || ''})` : ''); }
      return row;
    });
    const SLOT0 = 9;
    const slotWidths = [0, 1, 2, 3].map(i => rows.some(r => String(r[SLOT0 + i] || '').trim() !== '') ? 26 : 6);
    // 月間集計(社員ごと + 合計)
    const per = new Map();
    for (const { e, d } of full) { if (!per.has(e.id)) per.set(e.id, { e, recs: [] }); per.get(e.id).recs.push(d.request); }
    const srows = [];
    const all = [];
    for (const { e, recs } of per.values()) {
      const t = R.totalsOf(recs); all.push(...recs);
      srows.push([e.name, F(t.normal), F(t.night), F(t.half), F(t.holiday), F(t.holidayOver8)]);
    }
    const tt = R.totalsOf(all);
    if (per.size > 1) srows.push(['合計', F(tt.normal), F(tt.night), F(tt.half), F(tt.holiday), F(tt.holidayOver8)]);
    sheets.push({
      name: '正社員',
      def: {
        title: '正社員・残業データ',
        subtitle: `出力日時: ${stamp} / 対象件数: ${full.length}件 / 承認済みの申請のみ`,
        columns: [
          { header: 'スタッフ名', width: 14 }, { header: '日付', width: 12, align: 'center' },
          { header: '出勤打刻', width: 10, align: 'center' }, { header: '退勤打刻', width: 10, align: 'center' },
          { header: '通常残業', width: 11, align: 'center' }, { header: '深夜残業', width: 11, align: 'center' },
          { header: '半日出勤', width: 11, align: 'center' }, { header: '休日8h内', width: 11, align: 'center' },
          { header: '休出8h外', width: 11, align: 'center' },
          { header: '枠1', width: slotWidths[0] }, { header: '枠2', width: slotWidths[1] },
          { header: '枠3', width: slotWidths[2] }, { header: '枠4', width: slotWidths[3] },
        ],
        rows,
        summary: {
          label,
          columns: [{ header: 'スタッフ名', width: 14 }, { header: '通常残業', width: 12 }, { header: '深夜残業', width: 12 },
            { header: '半日出勤', width: 12 }, { header: '休日8h内', width: 12 }, { header: '休出8h外', width: 12 }],
          rows: srows,
        },
      },
    });
  }

  if (part.length) {
    const rows = part.map(({ e, d }) => {
      const r = d.request;
      return [e.name, d.date, d.clockIn, d.clockOut, r.ptBaseMin, r.ptOverMin, r.ptBaseMin + r.ptOverMin, r.ptMemo];
    });
    const per = new Map();
    for (const { e, d } of part) per.set(e.id, { e, min: (per.get(e.id)?.min || 0) + d.request.ptBaseMin + d.request.ptOverMin });
    const srows = [...per.values()].map(x => [x.e.name, x.min]);
    if (per.size > 1) srows.push(['合計', [...per.values()].reduce((a, x) => a + x.min, 0)]);
    sheets.push({
      name: 'パート',
      def: {
        title: 'パート勤務データ',
        subtitle: `出力日時: ${stamp} / 対象件数: ${part.length}件 / 承認済みの申請のみ`,
        columns: [
          { header: 'スタッフ名', width: 14 }, { header: '日付', width: 12, align: 'center' },
          { header: '出勤打刻', width: 10, align: 'center' }, { header: '退勤打刻', width: 10, align: 'center' },
          { header: '所定時間(分)', width: 14, numeric: true }, { header: '残業時間(分)', width: 14, numeric: true },
          { header: '合計労働時間(分)', width: 16, numeric: true }, { header: '残業理由', width: 42 },
        ],
        rows,
        summary: {
          label,
          columns: [{ header: 'スタッフ名', width: 14 }, { header: 'パート合計労働時間(分)', width: 26, numeric: true }],
          rows: srows,
        },
      },
    });
  }
  if (!sheets.length) return null;
  const name = emps.length === 1 && employeeId ? `_${emps[0].name.replace(/[\\/:*?"<>|]/g, '_')}` : '';
  return { buffer: xlsxBuildWorkbook(sheets), filename: `勤怠管理データ${name}_${period.start}〜${period.end}.xlsx` };
}

module.exports = { buildPeriodWorkbook };
