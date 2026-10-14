/* 管理画面(管理者のみ)。権限チェックはサーバー側で行われ、この画面はその結果を表示するだけ。 */
(function () {
  'use strict';
  const { h, clear, $, api, toast, F, sheet, dayCard, statusLabel, typeLabel } = UI;
  const R = Rules;
  const main = $('main');
  let me = null, today = '';
  let tab = 'day';
  let dayDate = '', anchor = '';
  let detailEmp = null;

  const TABS = [['day', '日別'], ['period', '月別(締め期間)'], ['pending', '残業の承認'], ['missing', '打刻漏れ'],
    ['employees', '社員'], ['tablets', 'タブレット'], ['audit', '修正履歴'], ['data', 'データ(取込・バックアップ)']];

  const fmtTs = ms => { const d = new Date(ms + 9 * 3600e3); const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
  const errBox = e => h('div', { class: 'alert ng' }, e.message || String(e));

  async function boot() {
    try { const r = await api('/api/me'); me = r.user; today = r.today; } catch (e) { main.append(errBox(e)); return; }
    $('btnMe').onclick = () => { location.href = '/me'; };
    $('btnLogout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
    if (!me) return renderLogin();
    if (me.mustChangePw) { main.append(h('div', { class: 'alert warn' }, '最初にパスワードを変更してください。'), h('a', { class: 'btn linkbtn', href: '/me' }, 'パスワードを変更する')); return; }
    if (me.role !== 'admin') { main.append(h('div', { class: 'alert ng' }, 'この画面は管理者専用です。')); return; }
    $('who').textContent = me.name; $('btnLogout').classList.remove('hidden');
    dayDate = today; anchor = today;
    render();
  }

  function renderLogin() {
    const code = h('input', { class: 'input', autocomplete: 'username', maxlength: '20' });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: '100' });
    const msg = h('div', {});
    main.append(h('div', { class: 'login-wrap' }, h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault(); clear(msg);
      try { await api('/api/login', { method: 'POST', body: { code: code.value.trim(), password: pw.value } }); location.reload(); }
      catch (err) { msg.append(errBox(err)); }
    } }, h('div', { class: 'card-title' }, '管理者ログイン'),
      h('div', { class: 'field' }, h('label', { class: 'label' }, '社員コード'), code),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'パスワード'), pw), msg,
      h('button', { class: 'btn', type: 'submit' }, 'ログイン'))));
  }

  function render() {
    clear(main);
    main.append(h('div', { class: 'admin-nav' }, ...TABS.map(([k, l]) => h('button', { type: 'button', class: k === tab ? 'active' : '', onclick: () => { tab = k; render(); } }, l))));
    const box = h('div', {}); main.append(box);
    const fn = { day: tabDay, period: tabPeriod, pending: tabPending, missing: tabMissing, employees: tabEmployees, tablets: tabTablets, audit: tabAudit, data: tabData }[tab];
    fn(box).catch(e => { clear(box).append(errBox(e)); });
  }

  // ---------- ダイアログ ----------
  function reasonField() { return h('textarea', { class: 'input', rows: '2', maxlength: '300', placeholder: '例: 打刻を忘れたため本人申告で修正' }); }

  function punchFixSheet(emp, date, day, after) {
    const inT = h('input', { class: 'input', type: 'time', value: day.clockIn });
    const outT = h('input', { class: 'input', type: 'time', value: day.clockOut });
    const reason = reasonField(); const msg = h('div', {});
    const s = sheet(`打刻の修正: ${emp.name} ${date}`, h('div', {},
      h('p', { class: 'note' }, '修正しても元の打刻は消えず、履歴に残ります。時刻を空にすると、その打刻を無効にします。'),
      h('div', { class: 'row2 field' }, h('div', {}, h('label', { class: 'label' }, '出勤'), inT), h('div', {}, h('label', { class: 'label' }, '退勤'), outT)),
      h('div', { class: 'field' }, h('label', { class: 'label' }, '修正の理由(必須)'), reason), msg,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        clear(msg);
        try {
          if (inT.value !== day.clockIn) await api('/api/admin/punch-fix', { method: 'POST', body: { employeeId: emp.id, date, type: 'in', hhmm: inT.value, reason: reason.value } });
          if (outT.value !== day.clockOut) await api('/api/admin/punch-fix', { method: 'POST', body: { employeeId: emp.id, date, type: 'out', hhmm: outT.value, reason: reason.value } });
          s.close(); toast('修正しました'); after();
        } catch (e) { msg.append(errBox(e)); }
      } }, '修正する'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'キャンセル')));
  }

  function requestSheet(emp, date, existing, after) {
    const f = RequestForm.fromRequest(emp, date, existing);
    const reason = reasonField(); const msg = h('div', {});
    const holder = h('div', {});
    let s;
    const draw = () => {
      clear(holder);
      const rf = RequestForm.build(emp, f, { locked: false, redraw: draw });
      holder.append(rf.el);
    };
    draw();
    s = sheet(`残業の${existing ? '修正' : '代理入力'}: ${emp.name} ${date}`, h('div', {},
      existing ? h('div', { class: 'alert info' }, `現在の状態: ${statusLabel[existing.status]}。修正すると履歴に残ります。`) : h('div', { class: 'alert info' }, '代理入力した申請は、そのまま承認済みになります。'),
      holder,
      h('div', { class: 'field' }, h('label', { class: 'label' }, existing ? '修正の理由(必須)' : '理由(任意)'), reason), msg,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        clear(msg);
        try {
          const r = await api('/api/admin/overtime', { method: 'POST', body: { ...f, employeeId: emp.id, reason: reason.value } });
          s.close(); toast('保存しました'); if (r.warnings.length) alert(r.warnings.map(w => '⚠ ' + w).join('\n')); after();
        } catch (e) { msg.append(errBox(e)); }
      } }, '保存する'),
      existing ? h('button', { class: 'btn red', type: 'button', onclick: async () => {
        clear(msg);
        if (!reason.value.trim()) { msg.append(errBox(new Error('取り消しの理由を入力してください。'))); return; }
        if (!confirm('この申請を取り消しますか?(履歴には残ります)')) return;
        try { await api(`/api/admin/overtime/${existing.id}/delete`, { method: 'POST', body: { reason: reason.value } }); s.close(); toast('取り消しました'); after(); }
        catch (e) { msg.append(errBox(e)); }
      } }, '申請を取り消す') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'キャンセル')));
  }

  function reviewButtons(item, after, rejectOnly) {
    const r = item.request;
    return h('div', { class: 'btnrow mt' },
      rejectOnly ? null : h('button', { class: 'btn sm green', type: 'button', onclick: async () => {
        try { await api(`/api/admin/overtime/${r.id}/review`, { method: 'POST', body: { status: 'approved' } }); toast('承認しました'); after(); } catch (e) { alert(e.message); }
      } }, '承認'),
      h('button', { class: 'btn sm red', type: 'button', onclick: () => {
        const c = h('textarea', { class: 'input', rows: '2', maxlength: '300', placeholder: '差し戻しの理由(社員に表示されます)' });
        const msg = h('div', {});
        const s = sheet('差し戻し', h('div', {}, c, msg,
          h('button', { class: 'btn red mt', type: 'button', onclick: async () => {
            try { await api(`/api/admin/overtime/${r.id}/review`, { method: 'POST', body: { status: 'rejected', comment: c.value } }); s.close(); toast('差し戻しました'); after(); }
            catch (e) { clear(msg).append(errBox(e)); }
          } }, '差し戻す')));
      } }, '差し戻し'));
  }

  function dayActions(emp, d, after) {
    return h('div', { class: 'btnrow mt' },
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => punchFixSheet(emp, d.date, d, after) }, '打刻を修正'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => requestSheet(emp, d.date, d.request, after) }, d.request ? '残業を修正' : '残業を代理入力'));
  }

  // ---------- 日別 ----------
  async function tabDay(box) {
    const d = await api('/api/admin/day?date=' + dayDate);
    const dateIn = h('input', { class: 'input', type: 'date', value: d.date });
    dateIn.addEventListener('change', () => { if (R.isDateStr(dateIn.value)) { dayDate = dateIn.value; render(); } });
    const shift = n => { dayDate = R.addDays(dayDate, n); render(); };
    box.append(h('div', { class: 'card' },
      h('div', { class: 'period' }, h('button', { class: 'pbtn', onclick: () => shift(-1) }, '◀'), dateIn, h('button', { class: 'pbtn', onclick: () => shift(1) }, '▶'),
        h('button', { class: 'pbtn', onclick: () => { dayDate = today; render(); } }, '今日')),
      h('div', { class: 'tscroll' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ...['社員', '出勤', '退勤', '残業申請', '警告', '操作'].map(t => h('th', {}, t)))),
        h('tbody', {}, ...d.rows.map(r => h('tr', {},
          h('td', {}, r.employee.name, UI.badge(r.employee.kind === 'part' ? 'パート' : '正社員', r.employee.kind === 'part' ? 'b-part' : 'b-gray')),
          h('td', {}, r.clockIn || '-'), h('td', {}, r.clockOut || '-'),
          h('td', {}, r.request ? [UI.badge(typeLabel[r.request.workType], 'b-gray'), UI.badge(statusLabel[r.request.status], UI.statusClass[r.request.status]), h('div', { class: 'small' }, UI.slotsText(r.request))] : '-'),
          h('td', {}, r.warnings.length ? r.warnings.map(w => h('div', { class: 'warnline' }, '⚠ ' + w.text)) : ''),
          h('td', {}, dayActions(r.employee, r, render)))))))));
  }

  // ---------- 月別 ----------
  async function tabPeriod(box) {
    const d = await api('/api/admin/period?anchor=' + anchor);
    const exportBtn = (label, empId) => h('a', { class: 'btn sm green linkbtn', href: `/api/admin/export.xlsx?anchor=${anchor}${empId ? '&employeeId=' + empId : ''}` }, label);
    box.append(h('div', { class: 'card' },
      UI.periodNav(d.period, dir => { anchor = R.shiftPeriod(d.period, dir).start; render(); }, () => { anchor = today; render(); }, today),
      h('div', { class: 'btnrow' }, exportBtn('📊 Excel出力(全員・承認済みのみ)')),
      h('div', { class: 'card-title mt' }, '既存アプリ(残業・公休・有給管理)へ渡すファイル'),
      h('div', { class: 'btnrow' },
        h('a', { class: 'btn sm linkbtn', href: `/api/admin/export-v61.json?anchor=${anchor}` }, '📤 打刻と残業(既存アプリ用)'),
        h('a', { class: 'btn sm ghost linkbtn', href: `/api/admin/export-punches.csv?anchor=${anchor}` }, '📄 打刻一覧(CSV)')),
      h('p', { class: 'note' }, '締め日のあとに、この期間のファイルを保存して、既存アプリの「サーバーの打刻・残業を取り込む」で読み込みます。'),
      h('p', { class: 'note' }, '集計は「承認済み」の残業申請だけが対象です。社員名の行を押すと、日ごとの詳細と修正ができます。')));
    box.append(h('div', { class: 'card tscroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ...['社員', '出勤日数', '通常残業', '深夜', '半日', '休日8h内', '休日8h超', 'パート合計', '承認待ち', '警告'].map(t => h('th', {}, t)))),
      h('tbody', {}, ...d.rows.map(r => h('tr', {},
        h('td', {}, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => detailSheet(r, d.period) }, r.employee.name)),
        h('td', {}, String(r.workDays)), h('td', {}, F(r.totals.normal)), h('td', {}, F(r.totals.night)), h('td', {}, F(r.totals.half)),
        h('td', {}, F(r.totals.holiday)), h('td', {}, F(r.totals.holidayOver8)), h('td', {}, F(r.totals.part)),
        h('td', {}, r.pending ? UI.badge(String(r.pending), 'b-wait') : '0'), h('td', {}, r.warnings ? UI.badge(String(r.warnings), 'b-ng') : '0'))),
        h('tr', {}, h('td', {}, h('b', {}, '合計')), h('td', {}), h('td', {}, F(d.grand.normal)), h('td', {}, F(d.grand.night)), h('td', {}, F(d.grand.half)),
          h('td', {}, F(d.grand.holiday)), h('td', {}, F(d.grand.holidayOver8)), h('td', {}, F(d.grand.part)), h('td', {}), h('td', {}))))));
  }

  function detailSheet(row, period) {
    const body = h('div', {});
    const after = () => { s.close(); render(); };
    body.append(h('div', { class: 'btnrow' }, h('a', { class: 'btn sm green linkbtn', href: `/api/admin/export.xlsx?anchor=${period.start}&employeeId=${row.employee.id}` }, '📊 この人のExcel出力')));
    body.append(UI.totalsTiles(row.totals));
    body.append(h('div', { class: 'mt' }));
    if (!row.days.length) body.append(h('p', { class: 'muted' }, 'この期間のデータはありません'));
    for (const day of row.days) body.append(h('div', {}, dayCard(day), dayActions(row.employee, day, after)));
    body.append(h('button', { class: 'btn ghost mt', onclick: () => s.close() }, '閉じる'));
    const s = sheet(`${row.employee.name}さんの詳細`, body);
  }

  // ---------- 承認 ----------
  let pendingStatus = 'pending';
  async function tabPending(box) {
    const d = await api('/api/admin/overtime?status=' + pendingStatus);
    const sel = h('select', { class: 'input' }, ...[['pending', '承認待ち'], ['approved', '承認済み(新しい順)'], ['rejected', '差し戻し中']].map(([v, l]) => h('option', { value: v, selected: v === pendingStatus }, l)));
    sel.addEventListener('change', () => { pendingStatus = sel.value; render(); });
    box.append(h('div', { class: 'card' }, h('label', { class: 'label' }, '表示する状態'), sel,
      h('p', { class: 'note' }, '社員が申請した残業は、自動で承認済みになります(設定で変更できます)。内容に問題がある申請は、「差し戻し」で社員に戻せます。承認済みの内容の修正は、「月別」「日別」から行えます。')));
    if (!d.items.length) box.append(h('div', { class: 'card muted center' }, '該当する申請はありません'));
    for (const it of d.items) {
      const emp = { id: it.employee.id, name: it.employee.name, kind: it.employee.kind };
      box.append(h('div', {}, dayCard(it, { extra: `${it.employee.name}(${it.employee.code})` }),
        reviewButtons(it, render, it.request.status === 'approved'),
        h('div', { class: 'mt' })));
    }
  }

  // ---------- 打刻漏れ ----------
  async function tabMissing(box) {
    const d = await api('/api/admin/missing?anchor=' + anchor);
    box.append(h('div', { class: 'card' },
      UI.periodNav(d.period, dir => { anchor = R.shiftPeriod(d.period, dir).start; render(); }, () => { anchor = today; render(); }, today),
      h('p', { class: 'note' }, '出勤だけで退勤がない日、退勤だけで出勤がない日の一覧です(当日は含みません)。')));
    if (!d.items.length) { box.append(h('div', { class: 'card muted center' }, '打刻漏れはありません')); return; }
    box.append(h('div', { class: 'card tscroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ...['日付', '社員', '出勤', '退勤', '内容', '操作'].map(t => h('th', {}, t)))),
      h('tbody', {}, ...d.items.map(i => h('tr', {}, h('td', {}, `${i.date}(${i.dow})`), h('td', {}, i.employee.name), h('td', {}, i.clockIn || '-'), h('td', {}, i.clockOut || '-'), h('td', {}, i.text),
        h('td', {}, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => punchFixSheet(i.employee, i.date, i, render) }, '打刻を修正'))))))));
  }

  // ---------- 社員マスタ ----------
  async function tabEmployees(box) {
    const d = await api('/api/admin/employees');
    box.append(h('div', { class: 'card' }, h('button', { class: 'btn', type: 'button', onclick: () => employeeSheet(null) }, '＋ 社員を追加'),
      h('p', { class: 'note' }, '退職などの場合は削除せず「無効」にします(過去の記録は残ります)。')));
    box.append(h('div', { class: 'card tscroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ...['コード', '氏名', '区分', '勤務体系/所定', '権限', '状態', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, ...d.employees.map(e => h('tr', {},
        h('td', {}, e.code), h('td', {}, e.name), h('td', {}, e.kind === 'part' ? 'パート' : '正社員'),
        h('td', {}, e.kind === 'part' ? `${e.ptStart}〜${e.ptEnd}(休憩${e.ptBreak}分)` : (e.pattern === 'pattern1' ? 'パターン1' : 'パターン2')),
        h('td', {}, e.role === 'admin' ? '管理者' : '社員'), h('td', {}, e.active ? '有効' : UI.badge('無効', 'b-ng'), e.mustChangePw ? UI.badge('初回PW未変更', 'b-wait') : null),
        h('td', {}, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => employeeSheet(e) }, '編集'))))))));
  }

  function employeeSheet(e) {
    const f = e ? { ...e } : { code: '', name: '', kind: 'full', pattern: 'pattern1', ptStart: '09:00', ptEnd: '18:30', ptBreak: 90, role: 'employee', active: true };
    const msg = h('div', {});
    const body = h('div', {});
    let s;
    const draw = () => {
      clear(body);
      const inp = (key, attrs = {}) => { const el = h('input', { class: 'input', value: f[key], ...attrs }); el.addEventListener('input', () => { f[key] = el.value; }); return el; };
      const sel = (key, opts) => { const el = h('select', { class: 'input' }, ...opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l))); el.addEventListener('change', () => { f[key] = el.value; if (key === 'kind') draw(); }); return el; };
      body.append(
        h('div', { class: 'field' }, h('label', { class: 'label' }, '社員コード(半角英数字)'), inp('code', { maxlength: '20' })),
        h('div', { class: 'field' }, h('label', { class: 'label' }, '氏名(姓と名の間に空白を入れない。例: 宮原侑希)'), inp('name', { maxlength: '50' })),
        h('div', { class: 'row2 field' },
          h('div', {}, h('label', { class: 'label' }, '勤務区分'), sel('kind', [['full', '正社員'], ['part', 'パート']])),
          h('div', {}, h('label', { class: 'label' }, '権限'), sel('role', [['employee', '社員'], ['admin', '管理者']]))),
        f.kind === 'full'
          ? h('div', { class: 'field' }, h('label', { class: 'label' }, '勤務体系パターン'), sel('pattern', [['pattern1', 'パターン1(月金09:00 / 火木土09:20)'], ['pattern2', 'パターン2(月金09:20 / 火木土09:00)']]))
          : h('div', { class: 'panel green' }, h('div', { class: 'label' }, 'パートの所定時間(初期値。日ごとの申請で変更できます)'),
            h('div', { class: 'range' }, inp('ptStart', { type: 'time' }), '〜', inp('ptEnd', { type: 'time' })),
            h('div', { class: 'field mt' }, h('label', { class: 'label' }, '休憩(分)'), inp('ptBreak', { type: 'number', min: '0', step: '5' }))),
        e ? (() => { const c = h('input', { type: 'checkbox', checked: f.active }); c.addEventListener('change', () => { f.active = c.checked; }); return h('label', { class: 'field' }, c, ' 有効(外すと無効になり、ログインできなくなります)'); })() : null);
    };
    draw();
    s = sheet(e ? `社員の編集: ${e.name}` : '社員の追加', h('div', {}, body, msg,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        clear(msg);
        try {
          const payload = { code: f.code, name: f.name, kind: f.kind, pattern: f.kind === 'part' ? (f.pattern || 'pattern1') : f.pattern, role: f.role, ptStart: f.ptStart, ptEnd: f.ptEnd, ptBreak: Number(f.ptBreak) };
          if (e) {
            await api('/api/admin/employees/' + e.id, { method: 'PUT', body: { ...payload, active: f.active } });
            s.close(); toast('保存しました'); render();
          } else {
            const r = await api('/api/admin/employees', { method: 'POST', body: payload });
            s.close(); tempPwSheet(r.employee.name, r.employee.code, r.tempPassword); render();
          }
        } catch (err) { msg.append(errBox(err)); }
      } }, '保存する'),
      e ? h('button', { class: 'btn amber', type: 'button', onclick: async () => {
        if (!confirm(`${e.name}さんのパスワードを再設定しますか?(現在のログインは解除されます)`)) return;
        try { const r = await api(`/api/admin/employees/${e.id}/reset-password`, { method: 'POST', body: {} }); s.close(); tempPwSheet(e.name, e.code, r.tempPassword); render(); }
        catch (err) { msg.append(errBox(err)); }
      } }, 'パスワードを再設定') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'キャンセル')));
  }

  function tempPwSheet(name, code, pw) {
    const s = sheet('仮パスワードを発行しました', h('div', { class: 'center' },
      h('p', {}, `${name}さん(社員コード: ${code})`), h('p', { class: 'mt' }, h('span', { class: 'pw' }, pw)),
      h('p', { class: 'note' }, 'この画面を閉じると二度と表示されません。本人にだけ伝えてください。初回ログイン時に、本人がパスワードを変更します。'),
      h('button', { class: 'btn mt', type: 'button', onclick: () => s.close() }, '控えた(閉じる)')));
  }

  // ---------- タブレット ----------
  async function tabTablets(box) {
    const d = await api('/api/admin/tablets');
    const name = h('input', { class: 'input', maxlength: '50', placeholder: '例: 受付タブレット' });
    box.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'タブレットを登録する'),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'タブレット名'), name),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { const r = await api('/api/admin/tablets', { method: 'POST', body: { name: name.value } }); regSheet(r.registerUrl); render(); } catch (e) { alert(e.message); }
      } }, '登録用アドレスを発行'),
      h('p', { class: 'note' }, '発行されたアドレスを、打刻用タブレットのブラウザで開くと登録されます(15分以内・1回だけ有効)。登録済みのタブレットだけがQR画面を開けます。')));
    box.append(h('div', { class: 'card tscroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ...['名前', '状態', '登録日時', '最終表示', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, ...d.tablets.map(t => h('tr', {}, h('td', {}, t.name),
        h('td', {}, !t.active ? UI.badge('解除済み', 'b-ng') : t.registered ? UI.badge('登録済み', 'b-ok') : UI.badge(t.regPending ? '登録待ち' : '期限切れ', 'b-wait')),
        h('td', {}, t.registeredAt ? fmtTs(t.registeredAt) : '-'), h('td', {}, t.lastSeenAt ? fmtTs(t.lastSeenAt) : '-'),
        h('td', {}, t.active ? h('div', { class: 'btnrow' },
          h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => { if (!confirm('登録用アドレスを再発行します。いまの登録は無効になります。よろしいですか?')) return; const r = await api(`/api/admin/tablets/${t.id}/reissue`, { method: 'POST', body: {} }); regSheet(r.registerUrl); render(); } }, '再登録'),
          h('button', { class: 'btn sm red', type: 'button', onclick: async () => { if (!confirm(`${t.name} を解除しますか?`)) return; await api(`/api/admin/tablets/${t.id}/revoke`, { method: 'POST', body: {} }); toast('解除しました'); render(); } }, '解除')) : '')))))));
  }
  function regSheet(url) {
    const s = sheet('登録用アドレス', h('div', {},
      h('p', {}, '打刻用タブレットのブラウザで、次のアドレスを開いてください(15分以内)。'),
      h('p', { class: 'mt' }, h('span', { class: 'pw' }, url)),
      h('button', { class: 'btn mt', type: 'button', onclick: () => s.close() }, '閉じる')));
  }

  // ---------- 修正履歴 ----------
  const actionLabel = { 'overtime.create': '残業申請', 'overtime.update': '残業修正', 'overtime.delete': '残業取消', 'overtime.approve': '承認', 'overtime.reject': '差し戻し',
    'overtime.import': '取り込み', 'punch.fix': '打刻修正', 'employee.create': '社員登録', 'employee.update': '社員編集', 'employee.password_reset': 'PW再設定', 'employee.password_change': 'PW変更',
    'tablet.create': 'タブレット登録', 'tablet.reissue': 'タブレット再登録', 'tablet.revoke': 'タブレット解除', 'backup.manual': '手動バックアップ', 'auth.lock': 'ログインロック', 'auth.login': '管理者ログイン' };
  const fmtObj = o => o ? Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' / ') : '';
  async function tabAudit(box) {
    const emps = (await api('/api/admin/employees')).employees;
    const sel = h('select', { class: 'input' }, h('option', { value: '' }, 'すべての社員'), ...emps.map(e => h('option', { value: e.id }, e.name)));
    const list = h('div', {});
    const load = async () => {
      const d = await api('/api/admin/audit' + (sel.value ? '?employeeId=' + sel.value : ''));
      clear(list);
      if (!d.items.length) list.append(h('div', { class: 'card muted center' }, '履歴はありません'));
      for (const i of d.items) list.append(h('div', { class: 'card' },
        h('div', { class: 'day-top' }, h('b', {}, `${actionLabel[i.action] || i.action}`), h('span', { class: 'small' }, fmtTs(i.at))),
        h('div', { class: 'small' }, `操作: ${i.actor}${i.targetName ? ` / 対象: ${i.targetName}` : ''}${i.workDate ? ` / 日付: ${i.workDate}` : ''}`),
        i.before ? h('div', { class: 'small' }, '変更前: ' + fmtObj(i.before)) : null,
        i.after ? h('div', { class: 'small' }, '変更後: ' + fmtObj(i.after)) : null,
        i.reason ? h('div', { class: 'small' }, '理由: ' + i.reason) : null));
    };
    sel.addEventListener('change', load);
    box.append(h('div', { class: 'card' }, h('label', { class: 'label' }, '社員で絞り込み'), sel,
      h('p', { class: 'note' }, '誰が・いつ・何を・なぜ修正したかの記録です。この履歴は削除できません。')), list);
    await load();
  }

  // ---------- データ(取り込み・バックアップ) ----------
  async function tabData(box) {
    const emps = (await api('/api/admin/employees')).employees;
    const impBox = h('div', {});
    const file = h('input', { type: 'file', accept: '.json,application/json,.txt', class: 'input' });
    const ta = h('textarea', { class: 'input', rows: '3', placeholder: 'またはここにデータを貼り付け' });
    file.addEventListener('change', async () => { if (file.files[0]) ta.value = await file.files[0].text(); });
    box.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, '📥 既存の残業管理(HTML)のデータ取り込み'),
      h('p', { class: 'note' }, '古いHTML版の「データ書き出し」で保存したファイル(overtime_records)を選びます。取り込んだ分は「承認済み」になります。同じ社員・同じ日のデータがすでにある場合は取り込みません。'),
      h('div', { class: 'field mt' }, file), ta,
      h('button', { class: 'btn mt', type: 'button', onclick: () => previewImport(ta.value, impBox, emps) }, '内容を確認する'), impBox));

    const bk = (await api('/api/admin/backups')).backups;
    box.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, '💾 バックアップ'),
      h('p', { class: 'note' }, '毎日自動でバックアップされます(保存先・保存日数は .env で変更)。いますぐ取る場合は下のボタンを押します。'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api('/api/admin/backups', { method: 'POST', body: {} }); toast('バックアップしました'); render(); } catch (e) { alert(e.message); } } }, 'いますぐバックアップ'),
      h('div', { class: 'mt tscroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'ファイル'), h('th', {}, 'サイズ'))),
        h('tbody', {}, ...bk.slice(0, 40).map(b => h('tr', {}, h('td', {}, b.file), h('td', {}, `${Math.round(b.size / 1024)} KB`))))))));
  }

  function parseLegacy(text) {
    let v;
    try { v = JSON.parse(text); } catch { throw new Error('データの形式が正しくありません。書き出したファイルをそのまま選んでください。'); }
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.overtime_records)) return v.overtime_records;
    if (v && Array.isArray(v.records)) return v.records;
    throw new Error('overtime_records のデータが見つかりません。');
  }

  async function previewImport(text, box, emps) {
    clear(box);
    try {
      const records = parseLegacy(text);
      const p = await api('/api/admin/import/preview', { method: 'POST', body: { records } });
      const mapping = {};
      const rows = p.names.map(n => {
        const sel = h('select', { class: 'input' }, h('option', { value: '' }, '取り込まない'), ...emps.filter(e => e.active).map(e => h('option', { value: e.id, selected: e.id === n.employeeId }, `${e.name}(${e.code})`)));
        mapping[n.name] = n.employeeId || '';
        sel.addEventListener('change', () => { mapping[n.name] = sel.value; });
        return h('tr', {}, h('td', {}, n.name), h('td', {}, `${n.count}件`), h('td', {}, sel));
      });
      box.append(h('p', { class: 'mt' }, `${p.valid}件を取り込めます(形式が違う${p.invalid}件は除外)。旧データの名前と、社員マスタの社員を対応づけてください。`),
        h('div', { class: 'tscroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, '旧データの名前'), h('th', {}, '件数'), h('th', {}, '取り込み先の社員'))), h('tbody', {}, ...rows))),
        h('button', { class: 'btn green mt', type: 'button', onclick: async () => {
          if (!confirm('取り込みを実行しますか?(実行前に、バックアップを取ることをおすすめします)')) return;
          try {
            const r = await api('/api/admin/import/commit', { method: 'POST', body: { records, mapping } });
            clear(box).append(h('div', { class: 'alert ok' }, `取り込み完了: ${r.imported}件 / 既存あり等でスキップ: ${r.skipped}件 / 対応先なし: ${r.unmatched}件 / 打刻: ${r.punches}件`),
              r.recomputeDiff.length ? h('div', { class: 'alert warn' }, '確認が必要なデータ:\n' + r.recomputeDiff.join('\n')) : null);
          } catch (e) { box.append(errBox(e)); }
        } }, '取り込みを実行'));
    } catch (e) { box.append(errBox(e)); }
  }

  boot();
})();
