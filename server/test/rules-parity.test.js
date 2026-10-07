'use strict';
// 既存HTML(残業管理システム_スマホ版.html)の計算と、移植した rules.js が一致することを確認する。
// 既存HTMLのスクリプトをそのまま(画面部品だけ偽物にして)動かし、同じ入力を両方に与えて比べる。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const R = require('../public/js/rules');

const LEGACY = process.env.LEGACY_HTML || path.join(__dirname, 'legacy', 'overtime-legacy.html');

function loadLegacy() {
  const html = fs.readFileSync(LEGACY, 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const els = {};
  const stub = id => (els[id] ||= new Proxy({ value: '', id, classList: { toggle() {}, add() {}, remove() {} }, dataset: {}, style: {}, textContent: '', innerHTML: '', className: '', disabled: false },
    { get: (t, k) => (k in t ? t[k] : (() => stub(id + '.' + String(k)))) , set: (t, k, v) => { t[k] = v; return true; } }));
  const sandbox = {
    document: { getElementById: stub, querySelector: () => stub('q'), querySelectorAll: () => [], createElement: () => stub('ce'), body: stub('body') },
    window: { scrollTo() {} }, localStorage: { getItem: () => '[]', setItem() {}, removeItem() {} },
    console, alert() {}, confirm: () => true, setTimeout, clearTimeout, URL: { createObjectURL() {}, revokeObjectURL() {} }, Blob: class {},
    TextEncoder, Uint8Array, Uint32Array,
  };
  const ctx = vm.createContext(sandbox);
  stub('pattern').value = 'pattern1'; stub('workType').value = 'normal'; stub('date').value = '2026-09-01'; stub('halfShift').value = 'am0900'; stub('breakMinutes').value = '90';
  vm.runInContext(script, ctx);
  return { ctx, els, stub };
}

test('既存HTMLと同じ結果になる(勤務ルール・深夜・休日・不整合判定)', { skip: !fs.existsSync(LEGACY) }, () => {
  const { ctx, stub } = loadLegacy();
  const set = (id, v) => { stub(id).value = v; };
  const run = code => vm.runInContext(code, ctx);

  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const hhmm = m => R.minutesToTime(m);
  const dates = [];
  for (let i = 0; i < 60; i++) dates.push(R.addDays('2026-09-01', i));

  let compared = 0;
  for (const date of dates) {
    for (const workType of ['normal', 'half', 'holiday']) {
      for (const pattern of ['pattern1', 'pattern2']) {
        for (const halfShift of workType === 'half' ? Object.keys(R.HALF_SHIFTS) : ['am0900']) {
          for (let trial = 0; trial < 6; trial++) {
            // ランダムな残業枠(1〜3枠、重ならない、同日内)
            const slots = [];
            let cursor = rnd(10 * 60);
            for (let i = 0; i < 1 + rnd(3); i++) {
              const s = cursor + rnd(180);
              const e = s + 15 + rnd(400);
              if (e > 23 * 60 + 59) break;
              slots.push({ start: hhmm(s), end: hhmm(e), memo: '' });
              cursor = e + 1;
            }
            if (!slots.length) continue;
            // 既存側
            set('date', date); set('workType', workType); set('pattern', pattern); set('halfShift', halfShift); set('breakMinutes', '90');
            for (let i = 1; i <= 4; i++) { set(`s${i}Start`, slots[i - 1]?.start || ''); set(`s${i}End`, slots[i - 1]?.end || ''); }
            const legacyMatch = run('validateDiscrepancy()');
            let ln = 0, lnight = 0;
            for (const s of slots) { const r = run(`calculateSlotMinutes(${JSON.stringify(s.start)}, ${JSON.stringify(s.end)})`); ln += r.normalMin; lnight += r.nightMin; }
            const lsplit = run(`getHolidaySplitMinutes(${ln + lnight})`);
            // 移植側
            const out = R.computeRequest({ date, workType, pattern, halfShift, breakMinutes: 90, slots });
            const v = out.value;
            assert.ok(out.ok, JSON.stringify(out.errors));
            const label = `${date} ${workType} ${pattern} ${halfShift} ${JSON.stringify(slots)}`;
            assert.strictEqual(v.isMatch, legacyMatch, '不整合判定が違う: ' + label);
            assert.strictEqual(v.normalMin, ln, '通常分が違う: ' + label);
            assert.strictEqual(v.nightMin, lnight, '深夜分が違う: ' + label);
            if (workType === 'holiday') {
              assert.strictEqual(v.holidayWithin8Min, lsplit.within8Min, label);
              assert.strictEqual(v.holidayOver8Min, lsplit.over8Min, label);
            }
            compared++;
          }
        }
      }
    }
  }
  assert.ok(compared > 1000, `比較件数が少なすぎます: ${compared}`);
  console.log(`  既存HTMLと一致: ${compared}パターン`);
});

test('締め期間(16日〜翌月15日)が既存HTMLと一致する', { skip: !fs.existsSync(LEGACY) }, () => {
  const { ctx } = loadLegacy();
  for (let i = 0; i < 800; i++) {
    const d = R.addDays('2025-01-01', i);
    const legacy = vm.runInContext(`getPayrollPeriod(${JSON.stringify(d)})`, ctx);
    assert.deepStrictEqual(R.getPayrollPeriod(d), { start: legacy.start, end: legacy.end }, d);
  }
});

test('パートの所定時間・深夜・日またぎ入力の拒否', () => {
  const p = R.computeRequest({ date: '2026-10-07', workType: 'parttime', ptStart: '09:00', ptEnd: '18:30', breakMinutes: 90, partTimeOverMin: 30, partTimeMemo: '患者対応' });
  assert.strictEqual(p.value.ptBaseMin, 480);
  assert.strictEqual(p.value.ptOverMin, 30);
  const night = R.computeRequest({ date: '2026-10-07', workType: 'normal', pattern: 'pattern1', slots: [{ start: '21:00', end: '23:30' }] });
  assert.strictEqual(night.value.nightMin, 90);
  assert.strictEqual(night.value.normalMin, 60);
  const cross = R.computeRequest({ date: '2026-10-07', workType: 'normal', pattern: 'pattern1', slots: [{ start: '23:00', end: '01:00' }] });
  assert.ok(!cross.ok);
  const hol = R.computeRequest({ date: '2026-10-11', workType: 'holiday', slots: [{ start: '09:00', end: '19:00' }] });
  assert.strictEqual(hol.value.holidayWithin8Min, 480);
  assert.strictEqual(hol.value.holidayOver8Min, 120);
  const holNight = R.computeRequest({ date: '2026-10-11', workType: 'holiday', slots: [{ start: '20:00', end: '23:00' }] });
  assert.ok(holNight.warnings.some(w => w.includes('深夜')), '休日深夜の警告が出ること');
});
