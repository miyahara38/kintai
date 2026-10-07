'use strict';
// 最初の管理者を作る(以降は管理画面から追加できる)
//   使い方: node scripts/create-admin.js 社員コード 氏名
const readline = require('node:readline');
const { assertSecrets } = require('../src/config');
assertSecrets();
const db = require('../src/db');
const C = require('../src/crypto');
const auth = require('../src/auth');

function ask(q, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

(async () => {
  db.open();
  const code = process.argv[2] || await ask('管理者の社員コード(半角英数字): ');
  const name = process.argv[3] || await ask('氏名: ');
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(code) || !name) { console.error('社員コードまたは氏名が正しくありません。'); process.exit(1); }
  if (db.get('SELECT 1 AS x FROM employees WHERE code=?', code)) { console.error('その社員コードはすでにあります。'); process.exit(1); }
  const pw = process.env.ADMIN_PASSWORD || await ask('初期パスワード(8文字以上・数字以外も含める。空ならランダム生成): ');
  const password = pw || C.generatePassword();
  const err = auth.validatePassword(password);
  if (err) { console.error(err); process.exit(1); }
  const now = Date.now();
  db.run(`INSERT INTO employees(code,name,kind,pattern,role,pw_hash,must_change_pw,active,created_at,updated_at)
          VALUES(?,?,'full','pattern1','admin',?,1,1,?,?)`, code, name, C.hashPassword(password), now, now);
  db.audit({ actor: null, action: 'employee.create', entity: 'employee', reason: `管理者 ${code} を初期作成(スクリプト)` });
  console.log(`管理者を作成しました。社員コード: ${code} / 初期パスワード: ${password}`);
  console.log('初回ログイン時にパスワード変更を求められます。');
})();
