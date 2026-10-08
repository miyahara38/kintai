/* 打刻用タブレット画面: QRを全画面表示し、30秒ごとに切り替える */
(function () {
  'use strict';
  const { h, clear, api } = UI;
  const root = document.getElementById('root');
  const SVGNS = 'http://www.w3.org/2000/svg';
  let currentToken = '';
  let rotateSec = 30;
  let lastIssued = 0;
  let timeOffset = 0;
  let view = null;

  function message(title, sub, err) {
    clear(root).append(h('div', { class: 'msg' }, h('div', {}, title), sub ? h('small', {}, sub) : null, err ? h('div', { class: 'err' }, err) : null));
  }

  async function registerIfNeeded() {
    const reg = new URLSearchParams(location.search).get('reg');
    if (!reg) return;
    message('タブレットを登録しています…');
    try {
      await api('/api/tablet/register', { method: 'POST', body: { code: reg } });
      history.replaceState(null, '', '/tablet');
    } catch (e) {
      history.replaceState(null, '', '/tablet');
      message('登録できませんでした', '管理画面で新しい登録コードを発行し、もう一度開いてください。', e.message);
      throw e;
    }
  }

  function buildLayout() {
    const clock = h('div', { class: 'clock', id: 'clock' }, '--:--');
    const date = h('div', { class: 'date', id: 'date' }, '');
    const bar = h('i', {});
    const list = h('ul', { class: 'recent', id: 'recent' });
    const qrbox = h('div', { class: 'qrbox', id: 'qrbox' });
    clear(root).append(h('div', { class: 'wrap' },
      qrbox,
      h('div', { class: 'side' },
        clock, date,
        h('div', { class: 'guide' }, 'スマホのカメラでQRコードを読み取って、打刻してください。'),
        h('div', { class: 'bar' }, bar),
        h('h2', {}, '最近の打刻'), list)));
    view = { clock, date, bar, list, qrbox };
  }

  function drawQr(qr) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${qr.size} ${qr.size}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '打刻用QRコード');
    const bg = document.createElementNS(SVGNS, 'rect');
    bg.setAttribute('width', qr.size); bg.setAttribute('height', qr.size); bg.setAttribute('fill', '#fff');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', qr.path); p.setAttribute('fill', '#000');
    svg.append(bg, p);
    clear(view.qrbox).append(svg);
  }

  let fetching = false;
  let lastTry = 0;
  let ttlSec = 60;
  let offline = false;

  function showWaiting() {
    // 期限切れのQRを出したままにしない(読み取っても使えないため)
    clear(view.qrbox).append(h('div', { class: 'msg' }, h('div', {}, 'サーバーに接続できません'), h('small', {}, '自動で再接続しています。しばらくお待ちください。')));
    view.bar.style.transition = 'none'; view.bar.style.width = '0%';
    qrShown = false;
  }

  let qrShown = false;
  async function refreshQr() {
    if (fetching || !view) return;
    fetching = true; lastTry = Date.now();
    try {
      const r = await api('/api/tablet/qr');
      currentToken = r.token; rotateSec = r.rotateSec; ttlSec = r.ttlSec || 60; lastIssued = Date.now(); offline = false; qrShown = true;
      drawQr(r.qr);
      view.bar.style.transition = 'none'; view.bar.style.width = '100%';
      void view.bar.offsetWidth;
      view.bar.style.transition = `width ${rotateSec}s linear`; view.bar.style.width = '0%';
    } catch (e) {
      if (e.data && e.data.unregistered) { stop(); showUnregistered(); }
      else { offline = true; if (view && (!lastIssued || Date.now() - lastIssued > ttlSec * 1000) && qrShown) showWaiting(); else if (view && !qrShown) showWaiting(); }
    } finally { fetching = false; }
  }

  const pad = n => String(n).padStart(2, '0');
  function tickClock() {
    if (!view) return;
    const now = new Date(Date.now() + timeOffset);
    // サーバー時刻(日本時間)で表示する。タブレット自身の時計やタイムゾーンは使わない
    const j = new Date(now.getTime() + 9 * 3600e3);
    view.clock.textContent = `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}:${pad(j.getUTCSeconds())}`;
    const w = ['日', '月', '火', '水', '木', '金', '土'][j.getUTCDay()];
    view.date.textContent = `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日(${w})`;
    const age = lastIssued ? Date.now() - lastIssued : Infinity;
    if (age >= rotateSec * 1000 && Date.now() - lastTry >= (offline ? 3000 : 0)) refreshQr();
    if (offline && age > ttlSec * 1000 && qrShown) showWaiting();
  }

  async function pollState() {
    try {
      const s = await api('/api/tablet/state?t=' + encodeURIComponent(currentToken));
      timeOffset = s.nowMs - Date.now();
      clear(view.list).append(...s.recent.map(r => h('li', {},
        h('span', {}, `${r.name}さん`), h('span', { class: r.type }, r.type === 'in' ? '出勤' : '退勤'), h('span', { class: 't' }, r.hhmm))));
      if (s.tokenUsed || offline) refreshQr(); // 使われたQR・接続が戻った直後は、すぐ新しいものに替える
    } catch (e) {
      if (e.data && e.data.unregistered) { stop(); showUnregistered(); }
      else offline = true;
    }
  }

  let timers = [];
  function stop() { timers.forEach(clearInterval); timers = []; }
  function showUnregistered() {
    view = null;
    message('このタブレットは登録されていません', '管理画面の「タブレット」で登録用のアドレスを発行し、このタブレットで開いてください。');
  }

  (async function start() {
    try { await registerIfNeeded(); } catch { return; }
    buildLayout();
    timers.push(setInterval(tickClock, 500), setInterval(pollState, 2000));
    await refreshQr();
    if (!view) return;
    await pollState();
    tickClock();
    // スリープから戻った・ネットワークが戻った時は、すぐに取り直す
    const wake = () => { if (view) { lastIssued = 0; refreshQr(); pollState(); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
  })();
})();
