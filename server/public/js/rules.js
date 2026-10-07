/*
 * 勤務ルール計算(既存の「残業管理システム_スマホ版.html」から移植)
 * 画面(ブラウザ)とサーバーの両方でこの1ファイルを使い、計算結果を必ず一致させる。
 * 数値の信頼元はサーバー側の再計算であり、画面側は表示用のプレビューにだけ使う。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHIFT_PATTERNS = {
    pattern1: {
      0: { str: '休日', start: '', end: '', breakMin: 0 },
      1: { str: '09:00〜13:00 / 14:30〜17:50', start: '09:00', end: '17:50', breakMin: 90 },
      2: { str: '09:20〜13:20 / 14:50〜18:50', start: '09:20', end: '18:50', breakMin: 90 },
      3: { str: '09:00〜13:00 / 14:30〜18:30', start: '09:00', end: '18:30', breakMin: 90 },
      4: { str: '09:20〜13:20 / 14:50〜18:50', start: '09:20', end: '18:50', breakMin: 90 },
      5: { str: '09:00〜13:00 / 14:30〜17:50', start: '09:00', end: '17:50', breakMin: 90 },
      6: { str: '09:20〜13:20 / 14:50〜18:30', start: '09:20', end: '18:30', breakMin: 90 },
    },
    pattern2: {
      0: { str: '休日', start: '', end: '', breakMin: 0 },
      1: { str: '09:20〜13:20 / 14:50〜18:10', start: '09:20', end: '18:10', breakMin: 90 },
      2: { str: '09:00〜13:00 / 14:30〜18:30', start: '09:00', end: '18:30', breakMin: 90 },
      3: { str: '09:20〜13:20 / 14:50〜18:50', start: '09:20', end: '18:50', breakMin: 90 },
      4: { str: '09:00〜13:00 / 14:30〜18:30', start: '09:00', end: '18:30', breakMin: 90 },
      5: { str: '09:20〜13:20 / 14:50〜18:10', start: '09:20', end: '18:10', breakMin: 90 },
      6: { str: '09:00〜13:00 / 14:30〜18:30', start: '09:00', end: '18:30', breakMin: 90 },
    },
  };

  const HALF_SHIFTS = {
    am0900: { start: '09:00', end: '13:00', label: '09:00〜13:00' },
    am0920: { start: '09:20', end: '13:20', label: '09:20〜13:20' },
    pm1430: { start: '14:30', end: '18:30', label: '14:30〜18:30' },
    pm1450: { start: '14:50', end: '18:50', label: '14:50〜18:50' },
  };

  const WORK_TYPES = ['normal', 'half', 'holiday', 'parttime'];
  const WEEK_DAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const DAY_END_MIN = 23 * 60 + 59; // 日またぎ非対応: 残業枠は23:59まで

  // ---------- 日付・時刻ユーティリティ(タイムゾーンに依存しない純粋計算) ----------
  const pad2 = n => String(n).padStart(2, '0');
  const isDateStr = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  const isTimeStr = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  function timeToMinutes(t) {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  function minutesToTime(min) {
    return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
  }
  // 'YYYY-MM-DD' の曜日(0=日)。Date.UTCで計算するのでサーバーのタイムゾーンに影響されない
  function dayIndex(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  function dayOfWeek(dateStr) { return isDateStr(dateStr) ? WEEK_DAYS[dayIndex(dateStr)] : ''; }
  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  function formatHoursMinutes(total) {
    const min = Math.max(0, Math.round(Number(total) || 0));
    return `${Math.floor(min / 60)}時間${min % 60}分`;
  }

  // ---------- 締め期間(16日〜翌月15日) ----------
  function getPayrollPeriod(dateStr) {
    if (!isDateStr(dateStr)) return null;
    let [y, m, d] = dateStr.split('-').map(Number);
    let mo = m - 1;
    if (d <= 15) { mo -= 1; if (mo < 0) { mo = 11; y -= 1; } }
    const start = `${y}-${pad2(mo + 1)}-16`;
    const ny = mo === 11 ? y + 1 : y;
    const nm = (mo + 1) % 12;
    const end = `${ny}-${pad2(nm + 1)}-15`;
    return { start, end };
  }
  function shiftPeriod(period, direction) {
    return getPayrollPeriod(addDays(direction < 0 ? period.start : period.end, direction < 0 ? -1 : 1));
  }

  // ---------- 勤務ルール ----------
  // opts: { date, workType, pattern, halfShift }
  function getShiftRule(opts) {
    if (!isDateStr(opts.date)) return null;
    const dayIdx = dayIndex(opts.date);
    if (opts.workType === 'half') {
      const key = HALF_SHIFTS[opts.halfShift] ? opts.halfShift : 'am0900';
      const base = HALF_SHIFTS[key];
      let end = base.end, overtimeStart = base.end, note = '';
      if (dayIdx === 6 && key === 'pm1450') { end = '18:30'; overtimeStart = '18:30'; note = '土曜特例：18:30終了'; }
      if ((dayIdx === 1 || dayIdx === 5) && key === 'pm1430') { overtimeStart = '17:50'; note = '月・金特例：17:50から残業申請可'; }
      return { start: base.start, end, overtimeStart, label: `${base.start}〜${end}`, note };
    }
    const patterns = SHIFT_PATTERNS[opts.pattern] || SHIFT_PATTERNS.pattern1;
    const s = patterns[dayIdx];
    if (!s) return null;
    return {
      start: s.start, end: s.end, overtimeStart: s.end,
      lunchStart: s.start === '09:20' ? '13:20' : '13:00',
      lunchEnd: s.start === '09:20' ? '14:50' : '14:30',
      label: s.str, note: '',
    };
  }

  // 残業枠が所定勤務時間内に入っていたら true(不整合)
  function slotsInsideShift(opts, slots) {
    if (opts.workType === 'parttime' || opts.workType === 'holiday') return false;
    const rule = getShiftRule(opts);
    if (!rule || !rule.start || !rule.end) return false;
    const shiftStart = timeToMinutes(rule.start);
    const otStart = timeToMinutes(rule.overtimeStart || rule.end);
    const hasLunch = opts.workType === 'normal' && rule.lunchStart && rule.lunchEnd;
    const lunchS = hasLunch ? timeToMinutes(rule.lunchStart) : null;
    const lunchE = hasLunch ? timeToMinutes(rule.lunchEnd) : null;
    for (const sl of slots) {
      const s = timeToMinutes(sl.start);
      const e = timeToMinutes(sl.end);
      const isBefore = e <= shiftStart;
      const isAfter = s >= otStart;
      const isLunch = hasLunch && s >= lunchS && e <= lunchE;
      if (!isBefore && !isLunch && !isAfter) return true;
    }
    return false;
  }

  // 22:00〜翌5:00 を深夜として1分単位で振り分ける(既存HTMLと同じ)
  function calculateSlotMinutes(startStr, endStr) {
    if (!startStr || !endStr) return { normalMin: 0, nightMin: 0 };
    const start = timeToMinutes(startStr);
    let end = timeToMinutes(endStr);
    if (end <= start) end += 24 * 60;
    let normalMin = 0, nightMin = 0;
    for (let m = start; m < end; m++) {
      const h = Math.floor((m % (24 * 60)) / 60);
      if (h >= 22 || h < 5) nightMin++; else normalMin++;
    }
    return { normalMin, nightMin };
  }

  function holidaySplit(totalMinutes) {
    const total = Math.max(0, Number(totalMinutes) || 0);
    return { within8Min: Math.min(total, 480), over8Min: Math.max(0, total - 480) };
  }

  const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

  /**
   * 残業申請の入力を検証し、計算結果を返す。サーバーは必ずこの関数で再計算する。
   * input: { date, workType, pattern, halfShift, breakMinutes, slots:[{start,end,memo}],
   *          ptStart, ptEnd, partTimeOverMin, partTimeMemo }
   * 戻り値: { ok, errors[], warnings[], value }  value は保存用に整形済み
   */
  function computeRequest(input) {
    const errors = [];
    const warnings = [];
    const date = input.date;
    if (!isDateStr(date)) errors.push('日付が正しくありません。');
    const workType = WORK_TYPES.includes(input.workType) ? input.workType : null;
    if (!workType) errors.push('勤務区分が正しくありません。');
    if (errors.length) return { ok: false, errors, warnings, value: null };

    const pattern = SHIFT_PATTERNS[input.pattern] ? input.pattern : 'pattern1';
    const halfShift = HALF_SHIFTS[input.halfShift] ? input.halfShift : 'am0900';
    let breakMinutes = Math.round(Number(input.breakMinutes));
    if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes > 600) breakMinutes = workType === 'half' ? 0 : 90;
    if (workType === 'half') breakMinutes = 0; // 半日勤務は休憩0分固定

    const v = {
      date, workType, pattern, halfShift, breakMinutes,
      slots: [], normalMin: 0, nightMin: 0, holidayWithin8Min: 0, holidayOver8Min: 0,
      ptStart: '', ptEnd: '', ptBaseMin: 0, ptOverMin: 0, ptMemo: '', isMatch: true,
    };

    if (workType === 'parttime') {
      const ptStart = isTimeStr(input.ptStart) ? input.ptStart : '09:00';
      const ptEnd = isTimeStr(input.ptEnd) ? input.ptEnd : '18:30';
      const s = timeToMinutes(ptStart);
      let e = timeToMinutes(ptEnd);
      if (e <= s) e += 24 * 60;
      v.ptStart = ptStart; v.ptEnd = ptEnd;
      v.ptBaseMin = Math.max(0, e - s - breakMinutes);
      const over = Math.round(Number(input.partTimeOverMin) || 0);
      if (over < 0 || over > 600) errors.push('パートの残業時間(分)は0〜600の範囲で入力してください。');
      v.ptOverMin = Math.min(600, Math.max(0, over));
      v.ptMemo = cleanText(input.partTimeMemo, 300);
      if (v.ptOverMin > 0 && !v.ptMemo) errors.push('パートの残業には理由の入力が必要です。');
      return { ok: errors.length === 0, errors, warnings, value: v };
    }

    const rawSlots = Array.isArray(input.slots) ? input.slots.slice(0, 4) : [];
    for (let i = 0; i < rawSlots.length; i++) {
      const sl = rawSlots[i] || {};
      const start = sl.start || '';
      const end = sl.end || '';
      if (!start && !end) continue;
      if (!start || !end) { errors.push(`残業枠${i + 1}は開始・終了時刻の両方を入力してください。`); continue; }
      if (!isTimeStr(start) || !isTimeStr(end)) { errors.push(`残業枠${i + 1}の時刻が正しくありません。`); continue; }
      if (timeToMinutes(end) <= timeToMinutes(start)) { errors.push(`残業枠${i + 1}: 終了は開始より後にしてください(日またぎの申請はできません。23:59まで)。`); continue; }
      const { normalMin, nightMin } = calculateSlotMinutes(start, end);
      v.slots.push({ start, end, memo: cleanText(sl.memo, 200), normalMin, nightMin });
      v.normalMin += normalMin;
      v.nightMin += nightMin;
    }
    // 枠の重複チェック
    const sorted = v.slots.slice().sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
    for (let i = 1; i < sorted.length; i++) {
      if (timeToMinutes(sorted[i].start) < timeToMinutes(sorted[i - 1].end)) { errors.push('残業枠の時間帯が重なっています。'); break; }
    }

    if (workType === 'holiday') {
      const split = holidaySplit(v.normalMin + v.nightMin);
      v.holidayWithin8Min = split.within8Min;
      v.holidayOver8Min = split.over8Min;
      if (v.nightMin > 0) {
        warnings.push('休日出勤に深夜(22時〜5時)の残業が含まれています。内容を確認してください。');
      }
    }
    if (v.slots.length && slotsInsideShift({ date, workType, pattern, halfShift }, v.slots)) {
      v.isMatch = false;
      const rule = getShiftRule({ date, workType, pattern, halfShift });
      const lunch = (workType === 'normal' && rule.lunchStart) ? `、昼休み ${rule.lunchStart}〜${rule.lunchEnd}` : '';
      warnings.push(`残業枠が所定勤務時間内に入っています。残業申請は ${rule.start} より前${lunch}、または ${rule.overtimeStart || rule.end} 以降で入力してください。`);
    }
    return { ok: errors.length === 0, errors, warnings, value: v };
  }

  // 集計用: 申請レコード(computeRequestのvalue形式)の配列から期間合計を出す
  function totalsOf(records) {
    const t = { normal: 0, half: 0, holiday: 0, night: 0, holidayOver8: 0, part: 0 };
    for (const r of records) {
      if (r.workType === 'normal') { t.normal += r.normalMin; t.night += r.nightMin; }
      else if (r.workType === 'half') { t.half += r.normalMin; t.night += r.nightMin; }
      else if (r.workType === 'holiday') { t.holiday += r.holidayWithin8Min; t.holidayOver8 += r.holidayOver8Min; t.night += r.nightMin; }
      else if (r.workType === 'parttime') { t.part += r.ptBaseMin + r.ptOverMin; }
    }
    return t;
  }

  return {
    SHIFT_PATTERNS, HALF_SHIFTS, WORK_TYPES, WEEK_DAYS, DAY_END_MIN,
    pad2, isDateStr, isTimeStr, timeToMinutes, minutesToTime, dayIndex, dayOfWeek, addDays,
    formatHoursMinutes, getPayrollPeriod, shiftPeriod, getShiftRule, slotsInsideShift,
    calculateSlotMinutes, holidaySplit, computeRequest, totalsOf, cleanText,
  };
});
