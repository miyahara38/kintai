/* 残業申請フォーム(社員画面・管理画面で共通)。計算は rules.js(サーバーと同じ)を使うプレビューのみ。 */
(function () {
  'use strict';
  const { h, clear, F } = UI;
  const R = Rules;

  const emptyForm = (emp, date) => ({
    date, workType: emp.kind === 'part' ? 'parttime' : 'normal', halfShift: 'am0900',
    breakMinutes: emp.kind === 'part' ? emp.ptBreak : 90,
    slots: [{ start: '', end: '', memo: '' }], ptStart: emp.ptStart, ptEnd: emp.ptEnd, partTimeOverMin: 0, partTimeMemo: '',
  });

  function fromRequest(emp, date, r) {
    const f = emptyForm(emp, date);
    if (!r) return f;
    return Object.assign(f, {
      workType: r.workType, halfShift: r.halfShift, breakMinutes: r.breakMinutes,
      slots: r.slots.length ? r.slots.map(s => ({ ...s })) : [{ start: '', end: '', memo: '' }],
      ptStart: r.ptStart || f.ptStart, ptEnd: r.ptEnd || f.ptEnd, partTimeOverMin: r.ptOverMin, partTimeMemo: r.ptMemo,
    });
  }

  // f: フォームの値(この関数が直接書き換える) / redraw: 構造が変わった時に呼ぶ再描画関数
  function build(emp, f, { locked, redraw }) {
    const out = h('div', {});
    const preview = h('div', { class: 'alert info' });

    const refresh = () => {
      const calc = R.computeRequest({ ...f, pattern: emp.pattern });
      clear(out);
      if (calc.value) {
        const v = calc.value;
        if (v.workType === 'parttime') out.append(h('div', { class: 'alert ok' }, `✅ 所定 ${F(v.ptBaseMin)} ＋ 申請残業 ${F(v.ptOverMin)} ＝ 合計 ${F(v.ptBaseMin + v.ptOverMin)}`));
        else if (v.slots.length) out.append(h('div', { class: 'alert ' + (v.isMatch ? 'ok' : 'ng') }, `残業合計 ${F(v.normalMin + v.nightMin)}(うち深夜 ${F(v.nightMin)})`));
      }
      (calc.errors || []).forEach(e => out.append(h('div', { class: 'alert ng' }, '🚨 ' + e)));
      (calc.warnings || []).forEach(w => out.append(h('div', { class: 'alert warn' }, '⚠ ' + w)));
      const dow = R.isDateStr(f.date) ? R.dayOfWeek(f.date) : '';
      const rule = f.workType === 'parttime' ? null : R.getShiftRule({ date: f.date, workType: f.workType, pattern: emp.pattern, halfShift: f.halfShift });
      preview.textContent = !R.isDateStr(f.date) ? '日付を選択してください'
        : f.workType === 'parttime' ? `${dow}曜 パート所定: ${f.ptStart}〜${f.ptEnd}`
        : rule ? `${dow}曜 ${f.workType === 'half' ? '半日' : '定時'}: ${rule.label}${rule.note ? ' / ' + rule.note : ''}` : '定時: -';
    };
    const bind = (el, obj, key, cast) => { el.addEventListener('input', () => { obj[key] = cast ? cast(el.value) : el.value; refresh(); }); return el; };

    const typeSel = h('select', { class: 'input', disabled: locked || emp.kind === 'part' },
      ...(emp.kind === 'part' ? [['parttime', 'パート勤務']] : [['normal', '通常出勤'], ['half', '半日出勤'], ['holiday', '休日出勤']])
        .map(([v, l]) => h('option', { value: v, selected: f.workType === v }, l)));
    typeSel.addEventListener('change', () => { f.workType = typeSel.value; f.breakMinutes = f.workType === 'half' ? 0 : (f.breakMinutes || 90); redraw(); });

    const body = h('div', { class: 'card' });
    if (f.workType === 'half') {
      const hs = h('select', { class: 'input', disabled: locked }, ...Object.entries(R.HALF_SHIFTS).map(([k, v]) => h('option', { value: k, selected: f.halfShift === k }, v.label)));
      bind(hs, f, 'halfShift');
      body.append(h('div', { class: 'panel sky' }, h('div', { class: 'label' }, '🕐 半日勤務時間'), hs,
        h('p', { class: 'note' }, '※月・金の14:30開始は17:50以降を残業申請できます。土曜の14:50開始は18:30終了です。')));
    }
    if (f.workType === 'parttime') {
      body.append(h('div', { class: 'panel green' }, h('div', { class: 'label' }, '⚙️ パート所定時間'),
        h('div', { class: 'range' }, bind(h('input', { class: 'input', type: 'time', value: f.ptStart, disabled: locked }), f, 'ptStart'), '〜', bind(h('input', { class: 'input', type: 'time', value: f.ptEnd, disabled: locked }), f, 'ptEnd')),
        h('div', { class: 'field mt' }, h('label', { class: 'label' }, '休憩時間(分)'),
          bind(h('input', { class: 'input', type: 'number', min: '0', step: '5', inputmode: 'numeric', value: f.breakMinutes, disabled: locked }), f, 'breakMinutes', Number))));
      body.append(h('div', { class: 'panel amber' }, h('div', { class: 'label' }, '📝 所定外労働の申請'),
        h('p', { class: 'note' }, '※終了時刻以降や休憩中の勤務は、申請がない限り労働時間に反映されません。'),
        h('div', { class: 'field' }, h('label', { class: 'label' }, '残業時間(分)'),
          bind(h('input', { class: 'input', type: 'number', min: '0', step: '5', inputmode: 'numeric', value: f.partTimeOverMin, disabled: locked }), f, 'partTimeOverMin', Number)),
        h('label', { class: 'label' }, '残業理由・業務説明'),
        bind(h('textarea', { class: 'input', rows: '2', maxlength: '300', disabled: locked }, f.partTimeMemo), f, 'partTimeMemo')));
    } else {
      body.append(h('div', { class: 'card-title' }, h('span', {}, '残業申請枠(最大4枠)'), h('span', { class: 'small' }, '23:59まで')));
      f.slots.forEach((s, i) => body.append(h('div', { class: 'slot' },
        h('div', { class: 'slot-head' }, h('span', {}, `残業枠 ${i + 1}`),
          !locked && (f.slots.length > 1 || s.start || s.end || s.memo) ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { if (f.slots.length > 1) f.slots.splice(i, 1); else f.slots[0] = { start: '', end: '', memo: '' }; redraw(); } }, 'クリア') : null),
        h('div', { class: 'range' },
          bind(h('input', { class: 'input', type: 'time', value: s.start, disabled: locked }), s, 'start'), '〜',
          bind(h('input', { class: 'input', type: 'time', value: s.end, disabled: locked }), s, 'end')),
        h('div', { class: 'mt' }, bind(h('input', { class: 'input', type: 'text', maxlength: '200', placeholder: '残業内容・理由メモ', value: s.memo, disabled: locked }), s, 'memo')))));
      if (!locked && f.slots.length < 4) body.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => { f.slots.push({ start: '', end: '', memo: '' }); redraw(); } }, '＋ 残業枠を追加'));
    }
    const el = h('div', {}, h('div', { class: 'field' }, h('label', { class: 'label' }, '勤務区分'), typeSel), preview, body, out);
    refresh();
    return { el, refresh };
  }

  window.RequestForm = { build, emptyForm, fromRequest };
})();
