/* 社員用(スマホ)画面: ログイン・打刻・打刻一覧 */
(function () {
  'use strict';
  const { h, clear, $, api, toast, F } = UI;
  const R = Rules;
  const main = $('main');
  const qs = new URLSearchParams(location.search);
  let token = qs.get('t') || '';
  let me = null;           // ログイン中の社員
  let punch = null;        // 今日の打刻状態
  let today = '';
  let tab = token ? 'punch' : 'punch';
  let anchor = '';


  const TABS = [['punch', '🕘', '打刻'], ['days', '📋', '打刻一覧'], ['settings', '⚙️', '設定']];

  function showTabs(on) {
    const tb = $('tabbar');
    tb.classList.toggle('hidden', !on);
    clear(tb);
    if (on) TABS.forEach(([k, ic, label]) => tb.append(h('button', { type: 'button', class: k === tab ? 'active' : '', onclick: () => { tab = k; render(); } }, h('span', { class: 'ic' }, ic), label)));
  }

  async function boot() {
    try {
      const r = await api('/api/me');
      me = r.user; punch = r.punch; today = r.today || '';
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
        const s = await api('/api/me'); punch = s.punch; today = s.today;
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

  // ---------- 打刻一覧 ----------
  async function renderDays() {
    if (!anchor) anchor = today;
    const box = h('div', {}, h('div', { class: 'muted' }, '読み込み中…'));
    main.append(box);
    let d;
    try { d = await api('/api/me/period?anchor=' + anchor); } catch (e) { clear(box).append(h('div', { class: 'alert ng' }, e.message)); return; }
    clear(box);
    box.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '🕘 打刻の一覧'),
      UI.periodNav(d.period, dir => { anchor = (R.shiftPeriod(d.period, dir)).start; render(); }, () => { anchor = today; render(); }, today),
      h('a', { class: 'btn linkbtn', href: `/api/me/export-v61.json?anchor=${d.period.start}` }, '📤 自分の打刻を、既存アプリ用に保存'),
      h('p', { class: 'note' }, '締め日のあとに、この期間のファイルを保存して、パソコンの既存アプリ(残業・公休・有給管理)の「サーバーの打刻・残業を取り込む」で読み込みます。')));
    const days = d.days.filter(x => x.clockIn || x.clockOut || x.warnings.some(w => w.code === 'MISSING_IN' || w.code === 'MISSING_OUT'));
    if (!days.length) box.append(h('div', { class: 'card muted center' }, 'この期間の打刻はありません'));
    for (const day of days.slice().reverse()) {
      box.append(h('div', { class: 'day' },
        h('div', { class: 'day-top' }, h('div', { class: 'date' }, `${day.date}(${day.dow})`)),
        h('div', { class: 'punches' }, `出勤 ${day.clockIn || '--:--'} / 退勤 ${day.clockOut || '--:--'}`),
        ...day.warnings.filter(w => w.code === 'MISSING_IN' || w.code === 'MISSING_OUT').map(w => h('div', { class: 'warnline' }, '⚠ ' + w.text))));
    }
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
