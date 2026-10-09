/* 社員用(スマホ)画面: ログイン・打刻・勤怠一覧・残業申請 */
(function () {
  'use strict';
  const { h, clear, $, api, toast, F, typeLabel } = UI;
  const R = Rules;
  const main = $('main');
  const qs = new URLSearchParams(location.search);
  let token = qs.get('t') || '';
  let me = null;           // ログイン中の社員
  let punch = null;        // 今日の打刻状態
  let today = '';
  let tab = token ? 'punch' : 'punch';
  let anchor = '';
  let autoApprove = false; // 残業申請を自動承認する設定(サーバーの設定)         // 勤怠一覧の締め期間の基準日

  const TABS = [['punch', '🕘', '打刻'], ['days', '📋', '勤怠・申請'], ['settings', '⚙️', '設定']];

  function showTabs(on) {
    const tb = $('tabbar');
    tb.classList.toggle('hidden', !on);
    clear(tb);
    if (on) TABS.forEach(([k, ic, label]) => tb.append(h('button', { type: 'button', class: k === tab ? 'active' : '', onclick: () => { tab = k; render(); } }, h('span', { class: 'ic' }, ic), label)));
  }

  async function boot() {
    try {
      const r = await api('/api/me');
      me = r.user; punch = r.punch; today = r.today || ''; autoApprove = !!r.autoApprove;
    } catch (e) { me = null; main.append(h('div', { class: 'alert ng' }, e.message)); }
    $('btnLogout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = token ? '/p?t=' + encodeURIComponent(token) : '/me'; };
    $('btnAdmin').onclick = () => { location.href = '/admin'; };
    render();
  }

  function render() {
    $('who').textContent = me ? me.name : '';
    $('btnLogout').classList.toggle('hidden', !me);
    $('btnAdmin').classList.toggle('hidden', !(me && me.role === 'admin'));
    clear(main);
    if (!me) { showTabs(false); return renderLogin(); }
    if (me.mustChangePw) { showTabs(false); return renderPasswordChange(true); }
    showTabs(true);
    if (tab === 'punch') renderPunch();
    else if (tab === 'days') renderDays();
    else renderSettings();
  }

  // ---------- ログイン ----------
  function renderLogin() {
    const code = h('input', { class: 'input', id: 'code', autocomplete: 'username', autocapitalize: 'off', maxlength: '20', required: true });
    const pw = h('input', { class: 'input', id: 'pw', type: 'password', autocomplete: 'current-password', maxlength: '100', required: true });
    const msg = h('div', {});
    const btn = h('button', { class: 'btn', type: 'submit' }, 'ログイン');
    const form = h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault(); btn.disabled = true; clear(msg);
      try {
        const r = await api('/api/login', { method: 'POST', body: { code: code.value.trim(), password: pw.value } });
        me = r.user;
        const s = await api('/api/me'); punch = s.punch; today = s.today; autoApprove = !!s.autoApprove;
        render();
      } catch (err) { msg.append(h('div', { class: 'alert ng' }, err.message)); btn.disabled = false; }
    } },
      h('div', { class: 'card-title' }, 'ログイン(初回のみ)'),
      token ? h('div', { class: 'alert info' }, 'ログインすると、続けて打刻できます。(QRコードの有効時間は60秒です)') : null,
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'code' }, '社員コード'), code),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'pw' }, 'パスワード'), pw),
      msg, btn,
      h('p', { class: 'note' }, 'ログインした状態は、このスマホに保存されます。共用のスマホでは使わないでください。'));
    main.append(h('div', { class: 'login-wrap' }, form));
  }

  // ---------- パスワード変更 ----------
  function renderPasswordChange(forced) {
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: '100' });
    const n1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: '100' });
    const n2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: '100' });
    const msg = h('div', {});
    const form = h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault(); clear(msg);
      if (n1.value !== n2.value) { msg.append(h('div', { class: 'alert ng' }, '新しいパスワードが一致しません。')); return; }
      try {
        await api('/api/me/password', { method: 'POST', body: { current: cur.value, next: n1.value } });
        me.mustChangePw = false; toast('パスワードを変更しました'); render();
      } catch (err) { msg.append(h('div', { class: 'alert ng' }, err.message)); }
    } },
      h('div', { class: 'card-title' }, 'パスワードの変更'),
      forced ? h('div', { class: 'alert warn' }, '最初に、自分だけが知っているパスワードに変更してください。') : null,
      h('div', { class: 'field' }, h('label', { class: 'label' }, '現在のパスワード'), cur),
      h('div', { class: 'field' }, h('label', { class: 'label' }, '新しいパスワード(8文字以上・数字以外も含める)'), n1),
      h('div', { class: 'field' }, h('label', { class: 'label' }, '新しいパスワード(確認)'), n2),
      msg, h('button', { class: 'btn', type: 'submit' }, '変更する'));
    main.append(forced ? h('div', { class: 'login-wrap' }, form) : form);
  }

  // ---------- 打刻 ----------
  function stateBox() {
    const labels = { none: '本日はまだ打刻していません', working: '出勤中です', left: '退勤済みです' };
    return h('div', { class: 'status' },
      h('div', { class: 'small' }, `${today}`), h('b', {}, labels[punch.status]),
      punch.punches.length ? h('div', { class: 'small' }, punch.punches.map(p => `${p.type === 'in' ? '出勤' : '退勤'} ${p.hhmm}`).join(' / ')) : null);
  }

  async function renderPunch() {
    main.append(stateBox());
    if (!token) {
      main.append(h('div', { class: 'card' },
        h('div', { class: 'card-title' }, '打刻のしかた'),
        h('p', {}, '会社のタブレットに表示されたQRコードを、スマホの標準カメラで読み取ってください。開いたページで「出勤」または「退勤」を押します。'),
        h('p', { class: 'note' }, 'QRコードは30秒ごとに変わります。カメラで読み取ったら、すぐに打刻してください。')));
      return;
    }
    const box = h('div', {});
    main.append(box);
    let chk;
    try { chk = await api('/api/punch/check?t=' + encodeURIComponent(token)); }
    catch (e) { box.append(h('div', { class: 'alert ng' }, e.message)); return; }
    if (!chk.ok) {
      const why = { expired: 'QRコードの有効期限が切れています。', used: 'このQRコードはすでに使われました。', invalid: 'QRコードが正しくありません。' }[chk.reason] || '';
      box.append(h('div', { class: 'alert ng' }, `${why}\nもう一度QRコードを読み取ってください。`));
      return;
    }
    const msg = h('div', {});
    const mk = (type, label, cls) => h('button', { class: 'btn ' + cls, type: 'button', onclick: () => doPunch(type, false, btns, msg) }, label);
    const btns = [mk('in', '出勤', 'green'), mk('out', '退勤', 'amber')];
    box.append(h('div', { class: 'punch-big' }, ...btns), msg,
      h('p', { class: 'note center' }, '打刻の時刻は、サーバーの時刻で記録されます。'));
  }

  async function doPunch(type, confirmed, btns, msg) {
    btns.forEach(b => { b.disabled = true; }); clear(msg);
    try {
      const r = await api('/api/punch', { method: 'POST', body: { type, token, confirm: confirmed } });
      punch = r.state;
      token = ''; history.replaceState(null, '', '/me'); // 使い終わったQRは消す(再読み込みでの二重打刻を防ぐ)
      clear(main); main.append(stateBox(),
        h('div', { class: 'alert ok' }, `${type === 'in' ? '出勤' : '退勤'}を ${r.punch.hhmm} で記録しました。`),
        r.punch.warning ? h('div', { class: 'alert warn' }, '確認のうえ記録しました: ' + r.punch.warning) : null);
      showTabs(true);
    } catch (e) {
      if (e.data && e.data.needConfirm) {
        msg.append(h('div', { class: 'alert warn' }, '⚠ ' + e.message),
          h('div', { class: 'btnrow' },
            h('button', { class: 'btn', type: 'button', onclick: () => doPunch(type, true, btns, msg) }, 'このまま打刻する'),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => { clear(msg); btns.forEach(b => { b.disabled = false; }); } }, 'やめる')));
        return;
      }
      msg.append(h('div', { class: 'alert ng' }, e.message));
      if (!(e.data && e.data.retryQr) && e.status !== 429) btns.forEach(b => { b.disabled = false; });
      if (e.status === 429) setTimeout(() => btns.forEach(b => { b.disabled = false; }), 3000);
    }
  }

  // ---------- 勤怠一覧 ----------
  async function renderDays() {
    if (!anchor) anchor = today;
    const box = h('div', {}, h('div', { class: 'muted' }, '読み込み中…'));
    main.append(box);
    let d;
    try { d = await api('/api/me/period?anchor=' + anchor); } catch (e) { clear(box).append(h('div', { class: 'alert ng' }, e.message)); return; }
    clear(box);
    box.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '📊 期間集計(承認済み)'),
      UI.periodNav(d.period, dir => { anchor = (R.shiftPeriod(d.period, dir)).start; render(); }, () => { anchor = today; render(); }, today),
      UI.totalsTiles(d.totals),
      d.pendingCount ? h('p', { class: 'note' }, `承認待ちが ${d.pendingCount} 件あります(集計には含まれません)。`) : null),
      h('button', { class: 'btn', type: 'button', onclick: () => openForm(today) }, '＋ 残業を申請する'),
      h('div', { class: 'mt' }));
    if (!d.days.length) box.append(h('div', { class: 'card muted center' }, 'この期間のデータはありません'));
    for (const day of d.days.slice().reverse()) box.append(UI.dayCard(day, { onEdit: x => openForm(x.date) }));
  }

  // ---------- 残業申請フォーム ----------
  async function loadForm(date) {
    let f = RequestForm.emptyForm(me, date);
    let status = null, comment = '', id = null;
    if (R.isDateStr(date)) {
      try {
        const d = await api('/api/me/day?date=' + date);
        if (d.request) { f = RequestForm.fromRequest(me, date, d.request); status = d.request.status; comment = d.request.reviewComment; id = d.request.id; }
      } catch { /* 取得できなくても入力は続けられる */ }
    }
    return { f, status, comment, id };
  }

  async function openForm(date) {
    clear(main); showTabs(false);
    drawForm(await loadForm(date));
  }

  function drawForm(st) {
    const f = st.f;
    clear(main);
    const locked = st.status === 'approved' && !autoApprove;
    const dateIn = h('input', { class: 'input', type: 'date', value: f.date, required: true, disabled: locked });
    dateIn.addEventListener('change', async () => { if (R.isDateStr(dateIn.value)) drawForm(await loadForm(dateIn.value)); });
    const rf = RequestForm.build(me, f, { locked, redraw: () => drawForm(st) });
    const msg = h('div', {});
    const submit = h('button', { class: 'btn', type: 'submit', disabled: locked }, st.id ? '申請内容を保存する(再申請)' : '申請する');
    main.append(h('form', { onsubmit: async e => {
      e.preventDefault(); submit.disabled = true; clear(msg);
      try {
        const r = await api('/api/me/overtime', { method: 'POST', body: f });
        toast(st.id ? '申請を更新しました' : '申請しました');
        if (r.warnings && r.warnings.length) alert('申請しました。\n\n' + r.warnings.map(w => '⚠ ' + w).join('\n'));
        tab = 'days'; render();
      } catch (err) { msg.append(h('div', { class: 'alert ng' }, err.message)); submit.disabled = false; }
    } },
      h('div', { class: 'card' },
        h('div', { class: 'card-title' }, st.id ? '✏️ 残業申請の確認・修正' : '📝 残業申請'),
        st.status ? h('div', { class: 'alert ' + (st.status === 'approved' ? 'ok' : st.status === 'rejected' ? 'ng' : 'warn') },
          `状態: ${UI.statusLabel[st.status]}${st.comment ? '\nコメント: ' + st.comment : ''}${locked ? '\n承認済みのため修正できません。修正が必要な場合は管理者に依頼してください。' : ''}`) : null,
        h('div', { class: 'field' }, h('label', { class: 'label' }, '日付'), dateIn),
        rf.el),
      msg, submit,
      st.id && !locked ? h('button', { class: 'btn red', type: 'button', onclick: async () => {
        if (!confirm('この申請を取り消しますか?')) return;
        try { await api(`/api/me/overtime/${st.id}/delete`, { method: 'POST', body: {} }); toast('取り消しました'); tab = 'days'; render(); }
        catch (err) { msg.append(h('div', { class: 'alert ng' }, err.message)); }
      } }, '申請を取り消す') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { tab = 'days'; render(); } }, '戻る')));
  }

  // ---------- 設定 ----------
  function renderSettings() {
    main.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'アカウント'),
      h('dl', { class: 'kv' },
        h('dt', {}, '氏名'), h('dd', {}, me.name), h('dt', {}, '社員コード'), h('dd', {}, me.code),
        h('dt', {}, '勤務区分'), h('dd', {}, me.kind === 'part' ? 'パート' : '正社員'),
        h('dt', {}, '勤務体系'), h('dd', {}, me.kind === 'part' ? `${me.ptStart}〜${me.ptEnd}(休憩${me.ptBreak}分)` : (me.pattern === 'pattern1' ? 'パターン1' : 'パターン2')))));
    renderPasswordChange(false);
  }

  boot();
})();
