/* ===== サーバー連携アドオン(勤怠・残業管理 v61 に追加) =====
 * 打刻システム(サーバー)が出力した「既存アプリ用ファイル(.json)」を取り込み、
 * 出勤・退勤の時刻と、社員本人が申請した残業を、このアプリの記録に反映する。
 * あわせて、データ全体のバックアップ保存・復元ボタンを追加する。
 * 既存の計算・画面・保存形式は変更しない(ボタンと、ここの処理を追加しただけ)。
 */
(function () {
  'use strict';
  var KEYS_EXACT = ['overtime_records', 'public_paid_leave_records_v4', 'staff_work_modes_v52', 'paidTotalAdjust_v6',
    'leave_period_history_cutoff_v8', 'leave_period_dedup_migrated_v8', 'overtime_supervisor_pin_hash_v2'];
  var TIME_RE = /^\d{2}:\d{2}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var norm = function (s) { return String(s == null ? '' : s).replace(/[\s　]+/g, ''); };
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  var isAppKey = function (k) { return KEYS_EXACT.indexOf(k) >= 0 || /^public_paid_leave_records/.test(k) || /^leave_period_/.test(k); };

  function stamp() { var d = new Date(); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()); }
  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function dumpAll() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (isAppKey(k)) data[k] = localStorage.getItem(k); }
    return { format: 'kintai-v61-backup', version: 1, exportedAt: new Date().toISOString(), data: data };
  }
  function saveBackup(prefix) { download(prefix + '_' + stamp() + '.json', JSON.stringify(dumpAll())); }
  function readJsonFile(file, cb) {
    var fr = new FileReader();
    fr.onload = function () { var v; try { v = JSON.parse(String(fr.result).replace(/^﻿/, '')); } catch (e) { return cb(e); } cb(null, v); };
    fr.onerror = function () { cb(new Error('read')); };
    fr.readAsText(file);
  }
  var slotsText = function (s) { return (s || []).map(function (x) { return x.start + '〜' + x.end + (x.memo ? '(' + x.memo + ')' : ''); }).join(' / ') || 'なし'; };

  // ---------- サーバーのファイルを取り込む ----------
  function cleanIncoming(raw) {
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var name = norm(r.staffName), date = String(r.date || '');
      if (!name || !DATE_RE.test(date)) return;
      var t = function (v) { return TIME_RE.test(String(v || '')) ? String(v) : ''; };
      var n = function (v) { v = Number(v); return isFinite(v) && v >= 0 ? v : 0; };
      var slots = (Array.isArray(r.slots) ? r.slots : []).filter(function (s) { return s && TIME_RE.test(String(s.start)) && TIME_RE.test(String(s.end)); })
        .slice(0, 4).map(function (s) { return { start: s.start, end: s.end, memo: String(s.memo || '').slice(0, 200), normalMin: n(s.normalMin), nightMin: n(s.nightMin) }; });
      out.push({
        staffName: name, staffKind: r.staffKind === 'part' ? 'part' : 'full', date: date,
        clockIn: t(r.clockIn), clockOut: t(r.clockOut), overtimeFromRequest: r.overtimeFromRequest === true,
        workType: ['normal', 'half', 'holiday', 'parttime'].indexOf(r.workType) >= 0 ? r.workType : 'normal',
        pattern: r.pattern === 'pattern2' ? 'pattern2' : 'pattern1', halfShift: String(r.halfShift || 'am0900'),
        breakMinutes: n(r.breakMinutes), slots: slots, totalNormalMin: n(r.totalNormalMin), totalNightMin: n(r.totalNightMin),
        holidayOver8Min: n(r.holidayOver8Min), partTimeBaseMin: n(r.partTimeBaseMin), partTimeOverMin: n(r.partTimeOverMin),
        partTimeMemo: String(r.partTimeMemo || '').slice(0, 300), ptStart: t(r.ptStart) || '09:00', ptEnd: t(r.ptEnd) || '18:30', isMatch: r.isMatch !== false
      });
    });
    return out;
  }

  var OT_FIELDS = ['workType', 'pattern', 'halfShift', 'breakMinutes', 'isMatch', 'slots', 'totalNormalMin', 'totalNightMin', 'holidayOver8Min',
    'partTimeBaseMin', 'partTimeOverMin', 'partTimeMemo', 'ptStart', 'ptEnd'];

  function applyImport(incoming) {
    var res = { added: 0, updated: 0, unchanged: 0, leaveSkipped: 0 };
    var index = {};
    overtimeRecords.forEach(function (r, i) { var k = norm(r.staffName) + '|' + r.date; if (!(k in index)) index[k] = i; });
    var when = new Date().toLocaleString('ja-JP');
    incoming.forEach(function (r) {
      var key = r.staffName + '|' + r.date;
      var i = index[key];
      if (i === undefined) {
        var rec = r.overtimeFromRequest ? {
          id: Date.now() + Math.floor(Math.random() * 100000), staffName: r.staffName, date: r.date, workType: r.workType, pattern: r.pattern,
          halfShift: r.halfShift, clockIn: r.clockIn, clockOut: r.clockOut, breakMinutes: r.breakMinutes, isMatch: r.isMatch, slots: r.slots,
          totalNormalMin: r.totalNormalMin, totalNightMin: r.totalNightMin, holidayOver8Min: r.holidayOver8Min, partTimeBaseMin: r.partTimeBaseMin,
          partTimeOverMin: r.partTimeOverMin, partTimeMemo: r.partTimeMemo, ptStart: r.ptStart, ptEnd: r.ptEnd, history: [], amount: 0
        } : {
          id: Date.now() + Math.floor(Math.random() * 100000), staffName: r.staffName, date: r.date, pattern: r.pattern, clockIn: r.clockIn, clockOut: r.clockOut,
          slots: [], totalNormalMin: 0, totalNightMin: 0, partTimeOverMin: 0, partTimeMemo: '', amount: 0, isMatch: true
        };
        overtimeRecords.push(rec); index[key] = overtimeRecords.length - 1; res.added++;
        return;
      }
      var cur = overtimeRecords[i], changes = [];
      if (r.clockIn && cur.clockIn !== r.clockIn) { changes.push('出勤打刻: ' + (cur.clockIn || '') + ' → ' + r.clockIn); cur.clockIn = r.clockIn; }
      if (r.clockOut && cur.clockOut !== r.clockOut) { changes.push('退勤打刻: ' + (cur.clockOut || '') + ' → ' + r.clockOut); cur.clockOut = r.clockOut; }
      if (r.overtimeFromRequest) {
        if (cur.leaveType) { res.leaveSkipped++; }  // 公休・有給の日は、残業の内容を上書きしない
        else {
          var before = slotsText(cur.slots), after = slotsText(r.slots);
          var differs = before !== after || (cur.partTimeOverMin || 0) !== r.partTimeOverMin || (cur.workType || '') !== r.workType;
          OT_FIELDS.forEach(function (f) { cur[f] = r[f]; });
          if (differs) changes.push('残業申請: ' + before + ' → ' + after + (r.workType === 'parttime' ? '(パート残業 ' + r.partTimeOverMin + '分)' : ''));
        }
      }
      if (changes.length) {
        cur.history = Array.isArray(cur.history) ? cur.history : [];
        cur.history.push({ at: when, mode: 'サーバーから取り込み', changes: changes });
        res.updated++;
      } else res.unchanged++;
    });
    // パート社員は、既存アプリの「パート」区分を、未設定の場合だけ設定する
    try {
      var modes = JSON.parse(localStorage.getItem('staff_work_modes_v52') || '{}'), changed = false;
      incoming.forEach(function (r) {
        var k = typeof v52Norm === 'function' ? v52Norm(r.staffName) : r.staffName;
        if (r.staffKind === 'part' && modes[k] === undefined) { modes[k] = 'parttime'; changed = true; }
      });
      if (changed) localStorage.setItem('staff_work_modes_v52', JSON.stringify(modes));
    } catch (e) { /* 区分の設定に失敗しても、取り込みは続ける */ }
    return res;
  }

  function onImportFile(file) {
    readJsonFile(file, function (err, parsed) {
      if (err || !parsed) return alert('ファイルを読み込めませんでした。打刻システムから保存した「既存アプリ用」のファイル(.json)を選んでください。');
      var raw = Array.isArray(parsed) ? parsed : (parsed.format === 'kintai-server-export' ? parsed.records : null);
      if (!raw) return alert('打刻システムの「既存アプリ用」ファイルではありません。');
      var incoming = cleanIncoming(raw);
      if (!incoming.length) return alert('取り込めるデータがありませんでした。');
      // 名前の確認(間違った名前で、別の人として登録されるのを防ぐ)
      var known = {};
      overtimeRecords.forEach(function (r) { known[norm(r.staffName)] = true; });
      try { leaveRecords.forEach(function (r) { known[norm(r.staffName)] = true; }); } catch (e) { /* 公休・有給の記録がない場合 */ }
      var byStaff = {};
      incoming.forEach(function (r) { byStaff[r.staffName] = (byStaff[r.staffName] || 0) + 1; });
      var lines = Object.keys(byStaff).map(function (n) { return '・' + n + '(' + byStaff[n] + '日分)' + (known[n] ? '' : '  ← このアプリに、まだ無い名前(新しい人として追加されます)'); });
      var period = parsed.period ? parsed.period.start + ' 〜 ' + parsed.period.end : '';
      var msg = '打刻のデータを取り込みます。\n' + (period ? '期間: ' + period + '\n' : '') + '件数: ' + incoming.length + '件\n\n' + lines.join('\n') +
        '\n\n・同じ名前・同じ日の記録は、出勤・退勤の時刻を更新します(履歴に残ります)。\n・残業・公休・有給の記録は変更しません。\n・取り込む前の状態を、バックアップファイルとして自動で保存します。\n\n取り込みますか?';
      if (!confirm(msg)) return;
      saveBackup('v61_before-import');
      var res = applyImport(incoming);
      saveAndRender();
      var found = refreshPunchIssues(true) || { ot: [], leave: [] };
      alert((found.ot.length + found.leave.length ? '⚠️ 打刻と、残業・公休・有給の記録に、食い違いが ' + (found.ot.length + found.leave.length) + '件 あります。\n画面の上の警告を確認してください。\n\n' : '') + '取り込みました。\n\n新しく追加: ' + res.added + '件\n更新: ' + res.updated + '件\n変更なし: ' + res.unchanged + '件' +
        (res.leaveSkipped ? '\n公休・有給の日のため、残業の内容を更新しなかった: ' + res.leaveSkipped + '件' : ''));
    });
  }

  function onRestoreFile(file) {
    readJsonFile(file, function (err, parsed) {
      if (err || !parsed || parsed.format !== 'kintai-v61-backup' || !parsed.data || typeof parsed.data !== 'object') {
        return alert('このアプリで保存した「データ全体のバックアップ」ファイルを選んでください。');
      }
      var keys = Object.keys(parsed.data).filter(isAppKey);
      if (!keys.length) return alert('復元できるデータがありません。');
      var o = {}; try { o = JSON.parse(parsed.data.overtime_records || '[]'); } catch (e) { /* 空として扱う */ }
      if (!confirm('バックアップ(' + (parsed.exportedAt || '').slice(0, 16).replace('T', ' ') + ' 保存)から、データを復元します。\n勤怠・残業 ' + (Array.isArray(o) ? o.length : 0) +
        '件と、公休・有給のデータが、現在のデータと置き換わります。\n復元の前に、いまのデータを、バックアップファイルとして自動で保存します。\n\n復元しますか?')) return;
      saveBackup('v61_before-restore');
      var del = []; for (var i = 0; i < localStorage.length; i++) { if (isAppKey(localStorage.key(i))) del.push(localStorage.key(i)); }
      del.forEach(function (k) { localStorage.removeItem(k); });
      keys.forEach(function (k) { if (typeof parsed.data[k] === 'string') localStorage.setItem(k, parsed.data[k]); });
      alert('復元しました。画面を再読み込みします。');
      location.reload();
    });
  }

  // ---------- 打刻と、残業・公休・有給の食い違いチェック ----------
  // 取り込んだ出勤・退勤の打刻と、このアプリの残業・公休・有給の記録を見比べて、食い違いを警告する。
  // 警告は、「残業」の一覧の上と、「公休・有給管理」の上に表示する(記録は変更しない)。
  var toMin = function (t) { var m = /^(\d{2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  var hhmm = function (m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); };
  // 食い違いの一覧。level: 'red'=要確認(打刻漏れ・公休有給)、'amber'=残業と打刻のずれ
  function findPunchIssues() {
    var items = [], today = todayStr();
    var recs = (typeof overtimeRecords !== 'undefined' && Array.isArray(overtimeRecords)) ? overtimeRecords : [];
    recs.forEach(function (r) {
      if (!r || !DATE_RE.test(String(r.date || ''))) return;
      var add = function (kind, level, text) { items.push({ kind: kind, level: level, name: r.staffName, key: norm(r.staffName) + '|' + r.date, date: r.date, text: text }); };
      var cin = toMin(r.clockIn), cout = toMin(r.clockOut), hasIn = cin !== null, hasOut = cout !== null;
      if (r.workType === 'off' || r.workType === 'paid') {
        if (hasIn || hasOut) add('leave', 'red', (r.workType === 'off' ? '公休' : '有給') + 'の日に、出勤・退勤の打刻があります');
        return;
      }
      var slots = (Array.isArray(r.slots) ? r.slots : []).filter(function (x) { return x && toMin(x.start) !== null && toMin(x.end) !== null; });
      var ptOver = r.workType === 'parttime' && Number(r.partTimeOverMin) > 0;
      if ((slots.length || ptOver) && !hasIn && !hasOut) { add('ot', 'red', '残業の記録があるのに、出勤・退勤の打刻がありません'); return; }
      if (r.date < today && (hasIn !== hasOut) && r.workType !== 'half') add('ot', 'red', (hasIn ? '退勤' : '出勤') + 'の打刻がありません(打刻漏れ)');
      if (slots.length) {
        var first = Math.min.apply(null, slots.map(function (x) { return toMin(x.start); }));
        var last = Math.max.apply(null, slots.map(function (x) { return toMin(x.end); }));
        if (hasOut && last > cout) add('ot', 'amber', '残業の終了(' + hhmm(last) + ')が、退勤の打刻(' + r.clockOut + ')より後になっています');
        if (hasIn && first < cin) add('ot', 'amber', '残業の開始(' + hhmm(first) + ')が、出勤の打刻(' + r.clockIn + ')より前になっています');
      }
    });
    var sorter = function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0; };
    items.sort(sorter);
    var line = function (x) { return x.name + ' ' + x.date + ': ' + x.text; };
    return {
      items: items,
      ot: items.filter(function (x) { return x.kind === 'ot'; }).map(function (x) { return { level: x.level, text: line(x) }; }),
      leave: items.filter(function (x) { return x.kind === 'leave'; }).map(function (x) { return { level: x.level, text: line(x) }; })
    };
  }

  var COLORS = {
    red: { box: 'mb-3 p-3 rounded-lg border border-red-300 bg-red-50 text-red-700 text-sm', line: '#b91c1c', mark: '🔴' },
    amber: { box: 'mb-3 p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-sm', line: '#b45309', mark: '🟡' },
    ok: { box: 'mb-3 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-bold', line: '#047857', mark: '✅' }
  };
  // lines: [{level, text}]。赤(要確認)を先に、黄(残業と打刻のずれ)をあとに並べる。okText があれば、問題がないときに緑で表示する
  function drawIssueBox(id, title, lines, place, okText) {
    var box = document.getElementById(id);
    if (!box) { box = document.createElement('div'); box.id = id; place(box); }
    if (!box.parentNode) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!lines.length) {
      if (!okText) { box.style.display = 'none'; return; }
      box.style.display = ''; box.className = COLORS.ok.box; box.textContent = '✅ ' + okText; return;
    }
    box.style.display = '';
    var reds = lines.filter(function (x) { return x.level === 'red'; }), ambers = lines.filter(function (x) { return x.level !== 'red'; });
    box.className = (reds.length ? COLORS.red : COLORS.amber).box;
    var head = document.createElement('div'); head.className = 'font-bold';
    head.textContent = '⚠️ ' + title + '(' + lines.length + '件' + (reds.length && ambers.length ? ':🔴 ' + reds.length + '件 / 🟡 ' + ambers.length + '件' : '') + ')'; box.appendChild(head);
    var list = document.createElement('div'); list.className = 'font-normal mt-1'; list.style.cssText = 'max-height:12rem;overflow-y:auto';
    reds.concat(ambers).slice(0, 200).forEach(function (x) {
      var c = COLORS[x.level === 'red' ? 'red' : 'amber'];
      var d = document.createElement('div'); d.style.color = c.line; d.textContent = c.mark + ' ' + x.text; list.appendChild(d);
    });
    box.appendChild(list);
  }

  // ---------- 打刻の一覧表(1人分・16日〜翌月15日)とExcel保存 ----------
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];
  var tbl = { staff: '', start: '' };
  var dstr = function (y, m, d) { var t = new Date(y, m, d); return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()); };
  function periodOf(dateStr) {   // 16日〜翌月15日
    var y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7)) - 1, d = Number(dateStr.slice(8, 10));
    var sm = d >= 16 ? m : m - 1;
    return { start: dstr(y, sm, 16), end: dstr(y, sm + 1, 15) };
  }
  function shiftStart(start, dir) { return dstr(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1 + dir, 16); }
  function daysOf(p) {
    var out = [], y = Number(p.start.slice(0, 4)), m = Number(p.start.slice(5, 7)) - 1, d = 16;
    for (var i = 0; i < 40; i++) { var s2 = dstr(y, m, d + i); out.push(s2); if (s2 === p.end) break; }
    return out;
  }
  function dowOf(ds) { return DOW[new Date(Number(ds.slice(0, 4)), Number(ds.slice(5, 7)) - 1, Number(ds.slice(8, 10))).getDay()]; }
  function staffList() {
    var seen = {}, list = [];
    var add = function (n) { n = norm(n); if (n && !seen[n]) { seen[n] = 1; list.push(n); } };
    ((typeof overtimeRecords !== 'undefined' && Array.isArray(overtimeRecords)) ? overtimeRecords : []).forEach(function (r) { add(r.staffName); });
    return list.sort();
  }
  // 表の行(日ごと)を作る。note は、画面にもExcelにも出す確認の文
  function tableRows(name, p, issues) {
    var recs = (typeof overtimeRecords !== 'undefined' && Array.isArray(overtimeRecords)) ? overtimeRecords : [];
    var byDate = {}; recs.forEach(function (r) { if (norm(r.staffName) === name && !(r.date in byDate)) byDate[r.date] = r; });
    var iss = {}; issues.forEach(function (x) { if (norm(x.name) === name) (iss[x.date] = iss[x.date] || []).push(x); });
    return daysOf(p).map(function (ds) {
      var r = byDate[ds] || {}, label = r.workType === 'off' ? '公休' : r.workType === 'paid' ? '有給' : '';
      var list = iss[ds] || [];
      return { date: ds, dow: dowOf(ds), clockIn: r.clockIn || '', clockOut: r.clockOut || '', label: label, issues: list,
        note: [label].concat(list.map(function (x) { return x.text; })).filter(Boolean).join(' / ') };
    });
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function tableSection() {
    var sec = document.getElementById('kintaiPunchTable');
    if (sec) return sec;
    var anchor = document.getElementById('leaveManagement');
    if (!anchor) return null;
    sec = el('section', 'bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mt-6'); sec.id = 'kintaiPunchTable';
    var head = el('div', 'px-6 py-4 bg-slate-900 text-white');
    head.appendChild(el('h2', 'text-lg font-bold', '🕘 打刻した日時の一覧'));
    head.appendChild(el('p', 'text-xs text-slate-300 mt-1', '取り込んだ出勤・退勤の打刻を、16日〜翌月15日の全日で表示します(1人分)。Excelにして提出できます。'));
    var body = el('div', 'p-6'); body.id = 'kintaiPunchTableBody';
    sec.appendChild(head); sec.appendChild(body);
    anchor.parentNode.insertBefore(sec, anchor.nextSibling);
    return sec;
  }

  function drawPunchTable(res) {
    var sec = tableSection(); if (!sec) return;
    var body = document.getElementById('kintaiPunchTableBody'); while (body.firstChild) body.removeChild(body.firstChild);
    var names = staffList();
    if (!tbl.start) tbl.start = periodOf(todayStr()).start;
    if (!tbl.staff || names.indexOf(tbl.staff) < 0) {
      var saved = ''; try { saved = localStorage.getItem('kintai_punch_table_staff') || ''; } catch (e) { /* 保存できない環境 */ }
      var typed = norm((document.getElementById('staffName') || {}).value);
      tbl.staff = names.indexOf(saved) >= 0 ? saved : names.indexOf(typed) >= 0 ? typed : (names[0] || '');
    }
    var p = { start: tbl.start, end: dstr(Number(tbl.start.slice(0, 4)), Number(tbl.start.slice(5, 7)), 15) };
    var bar = el('div', 'flex flex-wrap items-center gap-2 mb-3');
    var sel = el('select', 'border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold');
    if (!names.length) sel.appendChild(el('option', '', '(打刻データがありません)'));
    names.forEach(function (n) { var o = el('option', '', n); o.value = n; if (n === tbl.staff) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { tbl.staff = sel.value; try { localStorage.setItem('kintai_punch_table_staff', tbl.staff); } catch (e) { /* 保存できない環境 */ } drawPunchTable(findPunchIssues()); });
    var btn = function (label, cls, fn) { var b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; };
    var gray = 'bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-bold px-3 py-2 rounded-lg';
    bar.appendChild(sel);
    bar.appendChild(btn('← 前の期間', gray, function () { tbl.start = shiftStart(tbl.start, -1); drawPunchTable(findPunchIssues()); }));
    bar.appendChild(el('span', 'text-sm font-bold text-slate-700', p.start + ' 〜 ' + p.end));
    bar.appendChild(btn('次の期間 →', gray, function () { tbl.start = shiftStart(tbl.start, 1); drawPunchTable(findPunchIssues()); }));
    bar.appendChild(btn('今期', gray, function () { tbl.start = periodOf(todayStr()).start; drawPunchTable(findPunchIssues()); }));
    var rows = tbl.staff ? tableRows(tbl.staff, p, res.items) : [];
    var ex = btn('📗 Excelで保存(提出用)', 'bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-3 py-2 rounded-lg', function () { saveTableExcel(tbl.staff, p, rows); });
    ex.disabled = !tbl.staff; bar.appendChild(ex);
    body.appendChild(bar);

    // この期間の確認事項(件数と一覧)
    var mine = rows.reduce(function (a, r) { return a.concat(r.issues.map(function (x) { return { level: x.level, text: x.date + ': ' + x.text }; })); }, []);
    var warn = el('div', ''); body.appendChild(warn);
    drawIssueBox('kintaiWarnPunchTable', 'この期間に確認事項があります', mine, function (b) { warn.appendChild(b); }, tbl.staff ? 'この期間の打刻に、確認事項はありません' : '');

    var wrap = el('div', 'overflow-x-auto'); var t = el('table', 'w-full text-sm border-collapse');
    var th = el('tr', 'bg-slate-100 text-slate-700');
    ['日付', '出勤', '退勤', '確認'].forEach(function (h) { th.appendChild(el('th', 'p-2 border border-slate-200 text-left whitespace-nowrap', h)); });
    var thead = el('thead'); thead.appendChild(th); t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var worst = r.issues.some(function (x) { return x.level === 'red'; }) ? 'red' : r.issues.length ? 'amber' : '';
      var tr = el('tr', worst === 'red' ? 'bg-red-50' : worst === 'amber' ? 'bg-amber-50' : (r.dow === '日' || r.dow === '土' ? 'bg-slate-50' : ''));
      var dc = el('td', 'p-2 border border-slate-200 whitespace-nowrap', r.date + '(' + r.dow + ')');
      if (r.dow === '日') dc.style.color = '#b91c1c'; else if (r.dow === '土') dc.style.color = '#1d4ed8';
      tr.appendChild(dc);
      tr.appendChild(el('td', 'p-2 border border-slate-200 text-center', r.clockIn));
      tr.appendChild(el('td', 'p-2 border border-slate-200 text-center', r.clockOut));
      var nc = el('td', 'p-2 border border-slate-200');
      if (r.label) { var lb = el('span', 'text-slate-500 mr-2', r.label); nc.appendChild(lb); }
      r.issues.forEach(function (x) { var d = el('div', '', (x.level === 'red' ? '🔴 ' : '🟡 ') + x.text); d.style.color = COLORS[x.level === 'red' ? 'red' : 'amber'].line; nc.appendChild(d); });
      tr.appendChild(nc); tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); body.appendChild(wrap);
    if (!names.length) body.appendChild(el('p', 'text-sm text-slate-500 mt-2', '「📥 打刻を取り込む」で、打刻のファイルを取り込むと、ここに表示されます。'));
  }

  // 最小のxlsxファイルを作る(JSZipを使用。文字はすべて「文字列」として保存するので、数式として実行されない)
  function saveTableExcel(name, p, rows) {
    if (typeof JSZip === 'undefined') return alert('Excelファイルを作る部品が読み込まれていません。');
    var esc = function (v) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var col = ['A', 'B', 'C', 'D'];
    var cell = function (c, r, v, st) { return '<c r="' + col[c] + r + '" t="inlineStr"' + (st ? ' s="' + st + '"' : '') + '><is><t xml:space="preserve">' + esc(v) + '</t></is></c>'; };
    var data = [];
    data.push('<row r="1">' + cell(0, 1, '打刻一覧  ' + name + '  ' + p.start + ' 〜 ' + p.end, 1) + '</row>');
    data.push('<row r="2">' + ['日付', '出勤', '退勤', '確認'].map(function (h, i) { return cell(i, 2, h, 2); }).join('') + '</row>');
    rows.forEach(function (r, i) {
      var n = i + 3;
      data.push('<row r="' + n + '">' + cell(0, n, r.date + '(' + r.dow + ')', 3) + cell(1, n, r.clockIn, 3) + cell(2, n, r.clockOut, 3) + cell(3, n, r.note, 3) + '</row>');
    });
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="3" width="10" customWidth="1"/><col min="4" max="4" width="60" customWidth="1"/></cols><sheetData>' + data.join('') + '</sheetData></worksheet>';
    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Meiryo UI"/></font><font><b/><sz val="11"/><name val="Meiryo UI"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF94A3B8"/></left><right style="thin"><color rgb="FF94A3B8"/></right><top style="thin"><color rgb="FF94A3B8"/></top><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    var zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>', { createFolders: false });
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', { createFolders: false });
    zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="打刻一覧" sheetId="1" r:id="rId1"/></sheets></workbook>', { createFolders: false });
    zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>', { createFolders: false });
    zip.file('xl/worksheets/sheet1.xml', sheet, { createFolders: false });
    zip.file('xl/styles.xml', styles, { createFolders: false });
    zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = '打刻一覧_' + name + '_' + p.start + '_' + p.end + '.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    });
  }

  var lastSig = null;
  function refreshPunchIssues(force) {
    var sig = ''; try { sig = (localStorage.getItem('overtime_records') || '') + todayStr(); } catch (e) { /* 保存できない環境 */ }
    if (!force && sig === lastSig) return; lastSig = sig;
    var res = findPunchIssues();
    drawIssueBox('kintaiWarnOvertime', '打刻と残業の記録に食い違いがあります', res.ot, function (box) {
      var title = document.getElementById('attendanceListTitle'), head = title && title.parentNode;
      if (head && head.parentNode) head.parentNode.insertBefore(box, head);
    });
    drawIssueBox('kintaiWarnLeave', '打刻と公休・有給の記録に食い違いがあります', res.leave, function (box) {
      var sec = document.getElementById('leaveManagement');
      if (sec && sec.firstElementChild) sec.insertBefore(box, sec.firstElementChild.nextSibling);
    });
    drawPunchTable(res);
    return res;
  }

  // ---------- ボタンの追加 ----------
  function addButton(parent, label, color, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = color + ' text-white text-sm font-bold px-4 py-2 rounded-lg shadow whitespace-nowrap';
    b.textContent = label; b.addEventListener('click', onClick); parent.appendChild(b); return b;
  }
  function addFileInput(parent, handler) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json'; inp.style.display = 'none';
    inp.addEventListener('change', function () { var f = inp.files && inp.files[0]; inp.value = ''; if (f) handler(f); });
    parent.appendChild(inp); return inp;
  }
  function init() {
    var anchor = document.getElementById('btnExportCsv');
    var holder = document.createElement('div');
    holder.id = 'kintaiServerTools';
    holder.className = 'flex flex-wrap items-center gap-2';
    var importInput = addFileInput(holder, onImportFile), restoreInput = addFileInput(holder, onRestoreFile);
    addButton(holder, '📥 打刻を取り込む', 'bg-indigo-600 hover:bg-indigo-700', function () { importInput.click(); }).id = 'btnImportServer';
    addButton(holder, '💾 データ全体をバックアップ', 'bg-slate-600 hover:bg-slate-700', function () { saveBackup('v61_backup'); }).id = 'btnBackupAll';
    addButton(holder, '📂 バックアップから復元', 'bg-amber-600 hover:bg-amber-700', function () { restoreInput.click(); }).id = 'btnRestoreAll';
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(holder, anchor.nextSibling);
    else { holder.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;background:#fff;padding:8px;border:1px solid #cbd5e1;border-radius:8px'; document.body.appendChild(holder); }
    // 食い違いの警告: 起動時・記録の保存時・公休有給の変更時に更新する
    try {
      if (typeof window.saveAndRender === 'function') {
        var prev = window.saveAndRender;
        window.saveAndRender = function () { var r = prev.apply(this, arguments); refreshPunchIssues(true); return r; };
      }
    } catch (e) { /* 警告の更新に失敗しても、アプリは動かす */ }
    refreshPunchIssues(true);
    setInterval(function () { refreshPunchIssues(false); }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
