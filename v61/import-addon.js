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
      var msg = '打刻システムのデータを取り込みます。\n' + (period ? '期間: ' + period + '\n' : '') + '件数: ' + incoming.length + '件\n\n' + lines.join('\n') +
        '\n\n・同じ名前・同じ日の記録は、出勤・退勤の時刻と、申請された残業を更新します(履歴に残ります)。\n・公休・有給の記録は変更しません。\n・取り込む前の状態を、バックアップファイルとして自動で保存します。\n\n取り込みますか?';
      if (!confirm(msg)) return;
      saveBackup('v61_before-import');
      var res = applyImport(incoming);
      saveAndRender();
      alert('取り込みました。\n\n新しく追加: ' + res.added + '件\n更新: ' + res.updated + '件\n変更なし: ' + res.unchanged + '件' +
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
    addButton(holder, '📥 サーバーの打刻・残業を取り込む', 'bg-indigo-600 hover:bg-indigo-700', function () { importInput.click(); }).id = 'btnImportServer';
    addButton(holder, '💾 データ全体をバックアップ', 'bg-slate-600 hover:bg-slate-700', function () { saveBackup('v61_backup'); }).id = 'btnBackupAll';
    addButton(holder, '📂 バックアップから復元', 'bg-amber-600 hover:bg-amber-700', function () { restoreInput.click(); }).id = 'btnRestoreAll';
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(holder, anchor.nextSibling);
    else { holder.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;background:#fff;padding:8px;border:1px solid #cbd5e1;border-radius:8px'; document.body.appendChild(holder); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
