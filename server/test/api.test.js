'use strict';
// APIの結合テスト(一時フォルダのDBを使うので、本番データには触らない)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kintai-test-'));
Object.assign(process.env, {
  DB_PATH: path.join(tmp, 'test.db'), BACKUP_DIR: path.join(tmp, 'bk'), BACKUP_KEEP_DAYS: '30',
  TOKEN_SECRET: 'x'.repeat(40), SESSION_SECRET: 'y'.repeat(40), PORT: '0', BASE_URL: 'http://test.local',
  QR_TTL_SECONDS: '2', PUNCH_COOLDOWN_SECONDS: '1', LOGIN_MAX_FAILS: '3', LOGIN_LOCK_MINUTES: '15',
});
const { config } = require('../src/config');
config.OVERTIME_AUTO_APPROVE = false; // 既定は自動承認。承認フローの試験では手動承認にして確認する
const db = require('../src/db');
const C = require('../src/crypto');
const auth = require('../src/auth');
const { App, createServer } = require('../src/http');
const R = require('../public/js/rules');
const { jstDate } = require('../src/time');

db.open();
const app = new App();
app.authHook = auth.authHook;
require('../src/routes-user').register(app);
require('../src/routes-admin').register(app);
const server = createServer(app);
let base;

class Client {
  constructor() { this.c = {}; }
  async f(p, o = {}) {
    const headers = { 'X-Requested-With': 'kintai', 'Content-Type': 'application/json', cookie: Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join('; '), ...(o.headers || {}) };
    const r = await fetch(base + p, { method: o.method || 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined });
    for (const s of r.headers.getSetCookie()) { const [kv] = s.split(';'); const i = kv.indexOf('='); this.c[kv.slice(0, i)] = kv.slice(i + 1); }
    const buf = Buffer.from(await r.arrayBuffer());
    let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
    return { s: r.status, j, buf, h: r.headers };
  }
  post(p, body) { return this.f(p, { method: 'POST', body: body || {} }); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeUser(code, name, { role = 'employee', kind = 'full', pw = 'Passw0rd-x', must = 0, pattern = 'pattern1' } = {}) {
  const now = Date.now();
  const r = db.run(`INSERT INTO employees(code,name,kind,pattern,role,pw_hash,must_change_pw,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)`,
    code, name, kind, pattern, role, C.hashPassword(pw), must, now, now);
  return { id: Number(r.lastInsertRowid), code, pw };
}
async function loggedIn(u) { const c = new Client(); const r = await c.post('/api/login', { code: u.code, password: u.pw }); assert.strictEqual(r.s, 200, JSON.stringify(r.j)); return c; }

test.before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.open().close(); });

let admin, admin2, emp, other, part, tabletClient, tabletId;

test('管理者・社員・タブレットの準備', async () => {
  admin = makeUser('A1', '管理者一', { role: 'admin' });
  admin2 = makeUser('A2', '管理者二', { role: 'admin' });
  emp = makeUser('E1', '山田 太郎');
  other = makeUser('E2', '鈴木 次郎');
  part = makeUser('P1', '佐藤 花子', { kind: 'part' });
  const a = await loggedIn(admin);
  const t = await a.post('/api/admin/tablets', { name: 'T1' });
  assert.strictEqual(t.s, 200);
  tabletClient = new Client();
  const reg = await tabletClient.post('/api/tablet/register', { code: t.j.registerUrl.split('reg=')[1] });
  assert.strictEqual(reg.s, 200);
  tabletId = t.j.id;
  // 登録コードは1回しか使えない
  assert.strictEqual((await new Client().post('/api/tablet/register', { code: t.j.registerUrl.split('reg=')[1] })).s, 400);
});

test('未登録のブラウザはQR画面のデータを取得できない', async () => {
  assert.strictEqual((await new Client().f('/api/tablet/qr')).s, 403);
  // 偽の端末Cookie
  const c = new Client(); c.c.kintai_tablet = `${tabletId}.forged`;
  assert.strictEqual((await c.f('/api/tablet/qr')).s, 403);
});

test('権限: 未ログイン401・社員は管理APIに403・社員は他人のデータを見られない', async () => {
  assert.strictEqual((await new Client().f('/api/admin/employees')).s, 401);
  assert.strictEqual((await new Client().f('/api/me/period')).s, 401);
  const e = await loggedIn(emp);
  for (const p of ['/api/admin/employees', '/api/admin/day', '/api/admin/period', '/api/admin/audit', '/api/admin/export.xlsx', '/api/admin/backups', '/api/admin/tablets', '/api/admin/missing', '/api/admin/overtime']) {
    assert.strictEqual((await e.f(p)).s, 403, p);
  }
  assert.strictEqual((await e.post('/api/admin/employees', { code: 'X', name: 'x', kind: 'full', pattern: 'pattern1' })).s, 403);
  assert.strictEqual((await e.post('/api/admin/punch-fix', { employeeId: other.id })).s, 403);
  // 他人の申請は取り消せない
  const o = await loggedIn(other);
  const d = jstDate(Date.now());
  const made = await o.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] });
  assert.strictEqual(made.s, 200);
  assert.strictEqual((await e.post(`/api/me/overtime/${made.j.request.id}/delete`)).s, 404);
  // 自分の期間データに他人の申請が混ざらない
  const mine = await e.f('/api/me/period');
  assert.ok(mine.j.days.every(x => !x.request || x.request.employeeId === emp.id));
});

test('CSRF: 独自ヘッダなし・別オリジンの変更リクエストは拒否', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403);
  const r2 = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kintai', Origin: 'http://evil.example' }, body: '{}' });
  assert.strictEqual(r2.status, 403);
});

test('ログイン失敗が続くと一時ロック(正しいパスワードでも入れない)', async () => {
  const u = makeUser('L1', 'ロック確認');
  const c = new Client();
  for (let i = 0; i < 3; i++) assert.strictEqual((await c.post('/api/login', { code: 'L1', password: 'wrong' + i })).s, 401);
  const locked = await c.post('/api/login', { code: 'L1', password: u.pw });
  assert.strictEqual(locked.s, 429);
  assert.match(locked.j.error, /ロック/);
});

test('QR打刻: 出勤・退勤・警告・二重打刻・使い回し・期限切れ・改ざん', async () => {
  const e = await loggedIn(emp);
  const q = async () => (await tabletClient.f('/api/tablet/qr')).j.token;

  let tk = await q();
  // 出勤前の退勤は警告(確認なしでは記録されない)
  let r = await e.post('/api/punch', { type: 'out', token: tk });
  assert.strictEqual(r.s, 409); assert.ok(r.j.needConfirm);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM punches').n, 0);
  // 出勤
  r = await e.post('/api/punch', { type: 'in', token: tk });
  assert.strictEqual(r.s, 200);
  assert.match(r.j.punch.hhmm, /^\d\d:\d\d$/);
  // 同じトークンの使い回し
  r = await loggedIn(other).then(c => c.post('/api/punch', { type: 'in', token: tk }));
  assert.strictEqual(r.s, 400); assert.ok(r.j.retryQr);
  // 短時間の二重打刻
  tk = await q();
  r = await e.post('/api/punch', { type: 'out', token: tk, confirm: true });
  assert.strictEqual(r.s, 429);
  await sleep(1100);
  // 出勤済みで再出勤は警告
  r = await e.post('/api/punch', { type: 'in', token: tk });
  assert.strictEqual(r.s, 409);
  // 改ざん
  r = await e.post('/api/punch', { type: 'out', token: tk.slice(0, -2) + 'AA' });
  assert.strictEqual(r.s, 400);
  // 期限切れ(TTL=2秒)
  await sleep(2100);
  r = await e.post('/api/punch', { type: 'out', token: tk });
  assert.strictEqual(r.s, 400); assert.match(r.j.error, /有効期限/);
  // 新しいQRで退勤
  tk = await q();
  r = await e.post('/api/punch', { type: 'out', token: tk });
  assert.strictEqual(r.s, 200);
  // 打刻時刻は必ずサーバー時刻(クライアントが時刻を送っても無視される)
  tk = await q(); await sleep(1100);
  const fake = await e.post('/api/punch', { type: 'out', token: tk, confirm: true, hhmm: '03:00', ts: 1 });
  assert.strictEqual(fake.s, 200);
  assert.notStrictEqual(fake.j.punch.hhmm, '03:00');
});

test('解除したタブレットのQRは使えない', async () => {
  const a = await loggedIn(admin);
  const t2 = await a.post('/api/admin/tablets', { name: 'T2' });
  const c2 = new Client(); await c2.post('/api/tablet/register', { code: t2.j.registerUrl.split('reg=')[1] });
  const tk = (await c2.f('/api/tablet/qr')).j.token;
  assert.strictEqual((await a.post(`/api/admin/tablets/${t2.j.id}/revoke`)).s, 200);
  assert.strictEqual((await c2.f('/api/tablet/qr')).s, 403);
  const e = await loggedIn(part);
  assert.strictEqual((await e.post('/api/punch', { type: 'in', token: tk })).s, 400);
});

test('残業申請: 本人入力→承認待ち→管理者が承認/差し戻し、自己承認は不可、承認後は本人が修正不可', async () => {
  const e = await loggedIn(emp);
  const d = R.addDays(jstDate(Date.now()), -2);
  const bad = await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '23:00', end: '01:00' }] });
  assert.strictEqual(bad.s, 400);
  const tooOld = await e.post('/api/me/overtime', { date: R.addDays(jstDate(Date.now()), -40), workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] });
  assert.strictEqual(tooOld.s, 400);
  const ok = await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '22:30', memo: '=HYPERLINK("x")' }], normalMin: 99999 });
  assert.strictEqual(ok.s, 200);
  assert.strictEqual(ok.j.request.normalMin, 180, '計算はサーバー側で行い、クライアントの値は信用しない');
  assert.strictEqual(ok.j.request.nightMin, 30);
  assert.strictEqual(ok.j.request.status, 'pending');
  const id = ok.j.request.id;
  const a = await loggedIn(admin);
  // 差し戻しには理由が必要
  assert.strictEqual((await a.post(`/api/admin/overtime/${id}/review`, { status: 'rejected' })).s, 400);
  assert.strictEqual((await a.post(`/api/admin/overtime/${id}/review`, { status: 'rejected', comment: '時間を確認して' })).s, 200);
  const re = await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '21:00' }] });
  assert.strictEqual(re.j.request.status, 'pending');
  assert.strictEqual((await a.post(`/api/admin/overtime/${id}/review`, { status: 'approved' })).s, 200);
  assert.strictEqual((await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] })).s, 403);
  // 自分の申請は承認できない
  const own = await a.post('/api/admin/overtime', { employeeId: admin.id, date: d, workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] });
  assert.strictEqual(own.s, 200);
  db.run("UPDATE overtime_requests SET status='pending' WHERE id=?", own.j.request.id);
  assert.strictEqual((await a.post(`/api/admin/overtime/${own.j.request.id}/review`, { status: 'approved' })).s, 403);
});

test('食い違い警告: 申請終了が退勤より後は警告。「定時後の打刻で申請なし」は既定で出ない(設定で復活可)', async () => {
  const att = require('../src/attendance');
  config.WARN_NO_REQUEST = true; // 設定を有効にした場合の動作
  const emp1 = db.get('SELECT * FROM employees WHERE code=?', 'E1');
  const date = '2026-10-07'; // 水曜 パターン1 = 定時 18:30
  const dayOf = (inT, outT, req) => att.buildDay(emp1, date, [
    ...(inT ? [{ type: 'in', hhmm: inT }] : []), ...(outT ? [{ type: 'out', hhmm: outT }] : [])], req, '2026-10-08');
  const rq = (slots, status = 'approved') => ({ workType: 'normal', pattern: 'pattern1', halfShift: 'am0900', status, slots, nightMin: 0 });
  assert.ok(dayOf('09:00', '18:31', null).warnings.some(w => w.code === 'NO_REQUEST'), '定時後1分でも警告');
  assert.ok(!dayOf('09:00', '18:30', null).warnings.some(w => w.code === 'NO_REQUEST'));
  assert.ok(dayOf('09:00', '20:59', rq([{ start: '19:00', end: '21:00' }])).warnings.some(w => w.code === 'REQ_AFTER_OUT'), '申請終了が退勤より1分後でも警告');
  assert.ok(!dayOf('09:00', '21:00', rq([{ start: '19:00', end: '21:00' }])).warnings.length);
  assert.ok(dayOf('09:00', '21:01', rq([{ start: '19:00', end: '21:00' }])).warnings.some(w => w.code === 'NO_REQUEST'));
  assert.ok(dayOf('19:01', '21:00', rq([{ start: '19:00', end: '21:00' }])).warnings.some(w => w.code === 'REQ_BEFORE_IN'));
  assert.ok(dayOf('09:00', '', null).warnings.some(w => w.code === 'MISSING_OUT'), '過去日の退勤漏れ');
  assert.ok(dayOf('', '18:00', null).warnings.some(w => w.code === 'MISSING_IN'));
  assert.ok(dayOf('', '', rq([{ start: '19:00', end: '21:00' }])).warnings.some(w => w.code === 'NO_PUNCH'));
  assert.ok(att.buildDay(emp1, '2026-10-11', [{ type: 'in', hhmm: '10:00' }, { type: 'out', hhmm: '12:00' }], null, '2026-10-12').warnings.some(w => w.code === 'HOLIDAY_NO_REQUEST'), '日曜の打刻');

  // 既定(WARN_NO_REQUEST なし): 「申請がない」警告は出ないが、申請が打刻より後・打刻漏れの警告は残る
  config.WARN_NO_REQUEST = false;
  assert.ok(!dayOf('09:00', '18:31', null).warnings.some(w => w.code === 'NO_REQUEST'), '定時後の打刻で申請なしの警告は出ない');
  assert.ok(!dayOf('09:00', '21:01', rq([{ start: '19:00', end: '21:00' }])).warnings.some(w => w.code === 'NO_REQUEST'));
  assert.ok(dayOf('09:00', '20:59', rq([{ start: '19:00', end: '21:00' }])).warnings.some(w => w.code === 'REQ_AFTER_OUT'), '申請終了が退勤より後は警告');
  assert.ok(dayOf('19:01', '21:00', rq([{ start: '19:00', end: '21:00' }])).warnings.some(w => w.code === 'REQ_BEFORE_IN'));
  assert.ok(dayOf('09:00', '', null).warnings.some(w => w.code === 'MISSING_OUT'), '打刻漏れは警告');
  assert.ok(dayOf('', '18:00', null).warnings.some(w => w.code === 'MISSING_IN'));
});

test('残業の自動承認: 申請と同時に承認済み・本人が修正でき、履歴が残る。手動承認の設定にも戻せる', async () => {
  config.OVERTIME_AUTO_APPROVE = true;
  try {
    const e = await loggedIn(other);
    const d = R.addDays(jstDate(Date.now()), -5);
    const r1 = await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] });
    assert.strictEqual(r1.s, 200);
    assert.strictEqual(r1.j.request.status, 'approved');
    assert.strictEqual(r1.j.request.reviewComment, '自動承認');
    // 承認済みでも、本人が自分で直せる
    const r2 = await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '20:30' }] });
    assert.strictEqual(r2.s, 200); assert.strictEqual(r2.j.request.normalMin, 90); assert.strictEqual(r2.j.request.status, 'approved');
    assert.ok(db.get("SELECT 1 AS x FROM audit_log WHERE action='overtime.update' AND reason LIKE '%自動承認%'"), '変更の履歴が残る');
    // 管理者は差し戻せる → 本人が直して再提出すると、また自動承認
    const a = await loggedIn(admin);
    assert.strictEqual((await a.post(`/api/admin/overtime/${r1.j.request.id}/review`, { status: 'rejected', comment: '時間を確認' })).s, 200);
    const r3 = await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] });
    assert.strictEqual(r3.j.request.status, 'approved');
    // 自動承認でも、今までどおり日付の範囲・日またぎ・不正入力は拒否
    assert.strictEqual((await e.post('/api/me/overtime', { date: R.addDays(jstDate(Date.now()), -40), workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] })).s, 400);
    // 他人の申請は触れない
    assert.strictEqual((await (await loggedIn(emp)).post(`/api/me/overtime/${r1.j.request.id}/delete`)).s, 404);
    // 手動承認に戻すと、承認済みは本人が直せない
    config.OVERTIME_AUTO_APPROVE = false;
    assert.strictEqual((await e.post('/api/me/overtime', { date: d, workType: 'normal', slots: [{ start: '19:00', end: '20:00' }] })).s, 403);
    assert.strictEqual((await e.f('/api/me')).j.autoApprove, false);
  } finally { config.OVERTIME_AUTO_APPROVE = false; }
});

test('打刻修正: 元の記録は消えず、理由必須・履歴が残る。履歴は改ざん不可', async () => {
  const a = await loggedIn(admin);
  const date = jstDate(Date.now());
  assert.strictEqual((await a.post('/api/admin/punch-fix', { employeeId: emp.id, date, type: 'in', hhmm: '08:55' })).s, 400, '理由なしは拒否');
  const before = db.get('SELECT COUNT(*) AS n FROM punches').n;
  assert.strictEqual((await a.post('/api/admin/punch-fix', { employeeId: emp.id, date, type: 'in', hhmm: '00:01', reason: '打刻時刻の誤り(本人申告)' })).s, 200);
  assert.ok(db.get('SELECT COUNT(*) AS n FROM punches').n > before, '行が増える(元の行は残る)');
  assert.ok(db.get('SELECT COUNT(*) AS n FROM punches WHERE voided=1 AND employee_id=?', emp.id).n >= 1);
  const log = db.get("SELECT * FROM audit_log WHERE action='punch.fix' ORDER BY id DESC LIMIT 1");
  assert.ok(log.reason.includes('本人申告') && log.actor_name.includes('A1'));
  assert.throws(() => db.run('DELETE FROM audit_log'), /削除できません/);
  assert.throws(() => db.run("UPDATE audit_log SET reason='x'"), /変更できません/);
  assert.throws(() => db.run('DELETE FROM punches'), /削除できません/);
});

test('社員マスタ: 登録・仮パスワード・初回変更必須・無効化でログイン不可・最後の管理者は守る', async () => {
  const a = await loggedIn(admin);
  assert.strictEqual((await a.post('/api/admin/employees', { code: 'E1', name: '重複', kind: 'full', pattern: 'pattern1' })).s, 400);
  assert.strictEqual((await a.post('/api/admin/employees', { code: 'bad code!', name: 'x', kind: 'full', pattern: 'pattern1' })).s, 400);
  const created = await a.post('/api/admin/employees', { code: 'N1', name: '新人 一郎', kind: 'full', pattern: 'pattern2' });
  assert.strictEqual(created.s, 200);
  const nc = new Client();
  assert.strictEqual((await nc.post('/api/login', { code: 'N1', password: created.j.tempPassword })).s, 200);
  assert.strictEqual((await nc.f('/api/me/period')).s, 403, '初回パスワード変更前は他の機能を使えない');
  assert.strictEqual((await nc.post('/api/me/password', { current: created.j.tempPassword, next: '12345678' })).s, 400, '数字のみは不可');
  assert.strictEqual((await nc.post('/api/me/password', { current: created.j.tempPassword, next: 'Better-pw-9' })).s, 200);
  assert.strictEqual((await nc.f('/api/me/period')).s, 200);
  // パスワードは平文で保存されていない
  const row = db.get('SELECT pw_hash FROM employees WHERE code=?', 'N1');
  assert.ok(row.pw_hash.startsWith('scrypt$') && !row.pw_hash.includes('Better-pw-9'));
  // 無効化
  const id = created.j.employee.id;
  assert.strictEqual((await a.f(`/api/admin/employees/${id}`, { method: 'PUT', body: { active: false } })).s, 200);
  assert.strictEqual((await nc.f('/api/me/period')).s, 401, '無効化するとログイン状態も無効');
  assert.strictEqual((await new Client().post('/api/login', { code: 'N1', password: 'Better-pw-9' })).s, 401);
  // 自分自身は無効化できない
  assert.strictEqual((await a.f(`/api/admin/employees/${admin.id}`, { method: 'PUT', body: { active: false } })).s, 400);
  // パスワード再設定
  const rs = await a.post(`/api/admin/employees/${emp.id}/reset-password`);
  assert.strictEqual(rs.s, 200); assert.ok(rs.j.tempPassword.length >= 8);
  assert.strictEqual((await new Client().post('/api/login', { code: 'E1', password: emp.pw })).s, 401);
});

test('Excel出力: 正社員・パートシート、打刻列、数式として実行されない', async () => {
  const a = await loggedIn(admin);
  const d = R.addDays(jstDate(Date.now()), -2);
  const pt = await (await loggedIn(part)).post('/api/me/overtime', { date: d, partTimeOverMin: 30, partTimeMemo: '=1+1 患者対応' });
  assert.strictEqual(pt.s, 200, JSON.stringify(pt.j));
  assert.strictEqual((await a.post(`/api/admin/overtime/${pt.j.request.id}/review`, { status: 'approved' })).s, 200);
  const r = await a.f(`/api/admin/export.xlsx?anchor=${d}`);
  assert.strictEqual(r.s, 200);
  assert.strictEqual(r.buf.slice(0, 2).toString(), 'PK');
  assert.match(r.h.get('content-type'), /spreadsheetml/);
  const { execFileSync } = require('node:child_process');
  const f = path.join(tmp, 'out.xlsx'); fs.writeFileSync(f, r.buf);
  let xml = '';
  try { xml = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/workbook.xml'].map(n => execFileSync('unzip', ['-p', f, n]).toString()).join('\n'); } catch { /* unzipがない環境 */ }
  if (xml) {
    assert.ok(xml.includes('出勤打刻') && xml.includes('退勤打刻'));
    assert.ok(xml.includes('正社員') && xml.includes('パート'));
    assert.ok(!/<f>/.test(xml), '数式セルが含まれない');
    assert.ok(xml.includes("'=1+1"), '先頭が = の文字は文字列として無害化される');
  }
});

test('バックアップ → 破損検査 → 復元', async () => {
  const backup = require('../src/backup');
  const file = backup.runBackup();
  assert.ok(fs.existsSync(file) && backup.verifyFile(file));
  const n = db.get('SELECT COUNT(*) AS n FROM employees').n;
  assert.ok(n >= 5);
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.strictEqual(copy.prepare('SELECT COUNT(*) AS n FROM employees').get().n, n);
  copy.close();
  // 世代管理: 古いファイルは消える
  const old = path.join(process.env.BACKUP_DIR, 'kintai-20200101-020000.db');
  fs.copyFileSync(file, old); fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
  backup.prune();
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(file));
});

test('既存データの取り込み(名前の対応づけ・再計算・重複スキップ)', async () => {
  const a = await loggedIn(admin);
  const legacy = [
    { id: 1, staffName: '山田  太郎', date: '2026-08-20', workType: 'normal', pattern: 'pattern1', halfShift: 'am0900', clockIn: '09:00', clockOut: '20:00', breakMinutes: 90,
      slots: [{ start: '19:00', end: '22:30', memo: 'テスト', normalMin: 180, nightMin: 30 }], totalNormalMin: 180, totalNightMin: 30, history: [{ at: 'x', mode: 'y', changes: ['a'] }] },
    { id: 2, staffName: '知らない人', date: '2026-08-21', workType: 'normal', pattern: 'pattern1', slots: [{ start: '19:00', end: '20:00' }] },
    { id: 3, staffName: '佐藤 花子', date: '2026-08-22', workType: 'parttime', breakMinutes: 90, ptStart: '09:00', ptEnd: '18:30', partTimeOverMin: 30, partTimeMemo: '延長' },
    { bad: true },
  ];
  const p = await a.post('/api/admin/import/preview', { records: legacy });
  assert.strictEqual(p.s, 200);
  assert.strictEqual(p.j.valid, 3); assert.strictEqual(p.j.invalid, 1);
  const names = Object.fromEntries(p.j.names.map(n => [n.name, n.employeeId]));
  assert.strictEqual(names['山田  太郎'.replace(/\s+/g, ' ')] ?? names['山田  太郎'], db.get('SELECT id FROM employees WHERE code=?', 'E1').id, '空白の違いは同じ名前として照合');
  const mapping = {}; for (const n of p.j.names) mapping[n.name] = n.employeeId;
  const c = await a.post('/api/admin/import/commit', { records: legacy, mapping });
  assert.strictEqual(c.s, 200);
  assert.strictEqual(c.j.imported, 2); assert.strictEqual(c.j.unmatched, 1); assert.strictEqual(c.j.punches, 2);
  const row = db.get("SELECT * FROM overtime_requests WHERE work_date='2026-08-20'");
  assert.strictEqual(row.normal_min, 180); assert.strictEqual(row.night_min, 30); assert.strictEqual(row.status, 'approved');
  const again = await a.post('/api/admin/import/commit', { records: legacy, mapping });
  assert.strictEqual(again.j.imported, 0); assert.strictEqual(again.j.skipped, 2);
});

test('セキュリティヘッダと静的ファイルのパストラバーサル対策', async () => {
  const r = await fetch(base + '/tablet');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/../src/config.js', '/%2e%2e/src/config.js', '/..%2fsrc%2fconfig.js', '/js/../../.env', '/%00']) {
    const x = await fetch(base + p);
    assert.ok([400, 404].includes(x.status), p + ' -> ' + x.status);
  }
});

test('壊れた入力(壊れたCookie・URL・JSON)でもサーバーは落ちず・止まらず応答する', async () => {
  const r1 = await fetch(base + '/api/me', { headers: { cookie: 'kintai_sid=%E0%A4%A' } });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual((await fetch(base + '/%E0%A4%A')).status, 400);
  for (const body of ['null', '[1]', '"x"', '{', '12']) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'kintai', 'Content-Type': 'application/json' }, body });
    assert.strictEqual(r.status, 400, body);
  }
  const big = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'kintai', 'Content-Type': 'application/json' }, body: '{"a":"' + 'a'.repeat(2_000_000) + '"}' });
  assert.strictEqual(big.status, 413);
  const r2 = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'kintai', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: { a: 1 }, password: ['x'] }) });
  assert.strictEqual(r2.status, 401);
});
