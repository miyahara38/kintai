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
  for (const p of ['/api/admin/employees', '/api/admin/day', '/api/admin/period', '/api/admin/audit', '/api/admin/backups', '/api/admin/tablets', '/api/admin/missing']) {
    assert.strictEqual((await e.f(p)).s, 403, p);
  }
  assert.strictEqual((await e.post('/api/admin/employees', { code: 'X', name: 'x', kind: 'full', pattern: 'pattern1' })).s, 403);
  assert.strictEqual((await e.post('/api/admin/punch-fix', { employeeId: other.id })).s, 403);
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

test('既存アプリ(v61)用の出力: 社員本人の打刻JSON(残業は含めない)と管理者用CSV(数式無害化・BOM)・氏名の空白除去', async () => {
  const a = await loggedIn(admin);
  // 氏名は空白を除いて保存される
  const cr = await a.post('/api/admin/employees', { code: 'S1', name: '宮原 侑 希', kind: 'full', pattern: 'pattern1' });
  assert.strictEqual(cr.j.employee.name, '宮原侑希');
  const s1 = db.get('SELECT * FROM employees WHERE code=?', 'S1');
  const date = '2026-09-20'; // 締め期間(9/16〜10/15)の中ほど。今日の日付に左右されないよう固定
  const now = Date.now();
  db.run("INSERT INTO punches(employee_id,type,ts,work_date,hhmm,source,created_at) VALUES(?,'in',?,?,'09:00','admin',?)", s1.id, now - 1e6, date, now);
  db.run("INSERT INTO punches(employee_id,type,ts,work_date,hhmm,source,created_at) VALUES(?,'out',?,?,'20:10','admin',?)", s1.id, now - 5e5, date, now);
  // 過去に承認された残業が残っていても、出力には含めない
  const emp = db.get('SELECT * FROM employees WHERE id=?', s1.id);
  require('../src/overtime').save({ actor: emp, emp, input: { date, workType: 'normal', slots: [{ start: '19:00', end: '22:30', memo: '=1+1' }] }, asAdmin: true, reason: 'test' });
  // 打刻だけの日
  const date2 = R.addDays(date, -1);
  db.run("INSERT INTO punches(employee_id,type,ts,work_date,hhmm,source,created_at) VALUES(?,'in',?,?,'09:05','admin',?)", s1.id, now - 9e6, date2, now);

  // 本人としてログイン(自分の分だけを書き出せる)
  db.run('UPDATE employees SET pw_hash=?, must_change_pw=0 WHERE id=?', C.hashPassword('Passw0rd-x'), s1.id);
  const me1 = await loggedIn({ code: 'S1', pw: 'Passw0rd-x' });
  const j = await me1.f(`/api/me/export-v61.json?anchor=${date}`);
  assert.strictEqual(j.s, 200);
  assert.match(j.h.get('content-disposition'), /attachment/);
  const out = JSON.parse(j.buf.toString('utf8'));
  assert.strictEqual(out.format, 'kintai-server-export');
  assert.ok(out.records.every(r => r.staffName === '宮原侑希' && r.overtimeFromRequest === false && r.slots.length === 0), '本人の打刻だけ・残業は含めない');
  const full = out.records.find(r => r.date === date), punchOnly = out.records.find(r => r.date === date2);
  assert.strictEqual(full.clockIn, '09:00'); assert.strictEqual(full.clockOut, '20:10');
  assert.strictEqual(punchOnly.clockIn, '09:05'); assert.strictEqual(punchOnly.clockOut, '');
  // 他の社員の分は出ない
  const other1 = await (await loggedIn({ code: 'E2', pw: other.pw })).f(`/api/me/export-v61.json?anchor=${date}`);
  assert.ok(other1.s === 404 || JSON.parse(other1.buf.toString('utf8')).records.every(r => r.staffCode === 'E2'));

  const c = await a.f(`/api/admin/export-punches.csv?anchor=${date}&employeeId=${s1.id}`);
  assert.strictEqual(c.s, 200);
  const text = c.buf.toString('utf8');
  assert.ok(text.startsWith('﻿'), 'Excelで文字化けしないBOM付き');
  assert.ok(text.includes('宮原侑希') && text.includes('09:00') && text.includes('20:10'));
  assert.ok(text.includes('退勤の打刻漏れ'), '打刻漏れが備考に出る');
  const { csvCell } = require('../src/export-v61');
  assert.strictEqual(csvCell('=SUM(A1)'), "'=SUM(A1)"); assert.strictEqual(csvCell('a,b'), '"a,b"');
  // 権限: 社員は取得できない
  assert.strictEqual((await new Client().f('/api/me/export-v61.json')).s, 401);
  assert.strictEqual((await a.f('/api/admin/export-v61.json')).s, 404, '管理者用の全員分ファイルはない');
  assert.strictEqual((await new Client().f('/api/admin/export-punches.csv')).s, 401);
  function emp0() { return { code: 'E2', pw: other.pw }; }
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
