/* 画面共通の部品。HTMLは文字列で組み立てず、必ず textContent 経由で作る(XSS対策) */
(function () {
  'use strict';
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const $ = id => document.getElementById(id);

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'X-Requested-With': 'kintai' } };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(path, init); }
    catch { throw Object.assign(new Error('サーバーに接続できません。Wi-Fiの接続を確認してください。'), { network: true }); }
    let data = {};
    try { data = await res.json(); } catch { /* 空 */ }
    if (!res.ok) throw Object.assign(new Error(data.error || `エラーが発生しました(${res.status})`), { status: res.status, data });
    return data;
  }

  let toastTimer;
  function toast(msg, ms = 2400) {
    let t = $('toast');
    if (!t) { t = h('div', { id: 'toast', class: 'toast' }); document.body.append(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  const F = (m) => (window.Rules ? window.Rules.formatHoursMinutes(m) : String(m));
  const typeLabel = { normal: '通常', half: '半日', holiday: '休日出勤', parttime: 'パート' };
  const statusLabel = { pending: '承認待ち', approved: '承認済み', rejected: '差し戻し' };
  const statusClass = { pending: 'b-wait', approved: 'b-ok', rejected: 'b-reject' };

  function badge(text, cls) { return h('span', { class: 'badge ' + (cls || '') }, text); }

  function periodNav(period, onShift, onNow, today) {
    const R = window.Rules;
    const isNow = period.start === R.getPayrollPeriod(today).start;
    return h('div', { class: 'period' },
      h('button', { class: 'pbtn', type: 'button', onclick: () => onShift(-1), 'aria-label': '前の期間' }, '◀'),
      h('div', { class: 'plabel' }, `${period.start} 〜 ${period.end}`, isNow ? '' : h('div', { class: 'small' }, '今期以外を表示中')),
      h('button', { class: 'pbtn', type: 'button', onclick: () => onShift(1), 'aria-label': '次の期間' }, '▶'),
      h('button', { class: 'pbtn', type: 'button', onclick: onNow }, '今期'));
  }

  function totalsTiles(t) {
    return h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('span', {}, '通常残業'), h('b', {}, F(t.normal))),
      h('div', { class: 'tile' }, h('span', {}, '半日出勤'), h('b', {}, F(t.half))),
      h('div', { class: 'tile' }, h('span', {}, '休日出勤(8h内)'), h('b', {}, F(t.holiday))),
      h('div', { class: 'tile' }, h('span', {}, '休日8h超'), h('b', {}, F(t.holidayOver8))),
      h('div', { class: 'tile wide' }, h('span', {}, '深夜残業(22時〜5時)'), h('b', {}, F(t.night))),
      h('div', { class: 'tile wide' }, h('span', {}, 'パート合計労働時間'), h('b', {}, F(t.part))));
  }

  function slotsText(req) {
    if (!req) return '';
    if (req.workType === 'parttime') return `所定 ${req.ptBaseMin}分 + 残業 ${req.ptOverMin}分${req.ptMemo ? `(${req.ptMemo})` : ''}`;
    return req.slots.map(s => `${s.start}〜${s.end}${s.memo ? `(${s.memo})` : ''}`).join(' / ');
  }

  function dayCard(d, { onEdit, extra } = {}) {
    const req = d.request;
    return h('div', { class: 'day' },
      h('div', { class: 'day-top' },
        h('div', {}, h('div', { class: 'date' }, `${d.date}(${d.dow})`), extra ? h('div', { class: 'name' }, extra) : null),
        h('div', {},
          req ? badge(typeLabel[req.workType], req.workType === 'parttime' ? 'b-part' : 'b-gray') : null,
          req ? badge(statusLabel[req.status], statusClass[req.status]) : null)),
      h('div', { class: 'punches' }, `出勤 ${d.clockIn || '--:--'} / 退勤 ${d.clockOut || '--:--'}`),
      req ? h('div', { class: 'small' }, slotsText(req)) : null,
      req && req.status === 'rejected' && req.reviewComment ? h('div', { class: 'warnline' }, '差し戻し理由: ' + req.reviewComment) : null,
      ...d.warnings.map(w => h('div', { class: 'warnline' }, '⚠ ' + w.text)),
      ...d.punchWarnings.map(w => h('div', { class: 'small' }, '※打刻時の確認: ' + w)),
      onEdit ? h('div', { class: 'mt' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => onEdit(d) }, req ? '残業申請を確認・修正' : '残業を申請')) : null);
  }

  function sheet(titleText, bodyEl) {
    const bg = h('div', { class: 'sheet-bg', onclick: e => { if (e.target === bg) bg.remove(); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('h3', {}, titleText), bodyEl));
    document.body.append(bg);
    return { close: () => bg.remove(), el: bg };
  }

  window.UI = { h, clear, $, api, toast, F, typeLabel, statusLabel, statusClass, badge, periodNav, totalsTiles, slotsText, dayCard, sheet };
})();
