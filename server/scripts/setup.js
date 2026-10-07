'use strict';
// 初期設定: .env を作り、秘密鍵を自動生成する(すでにある場合は何も壊さない)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

if (fs.existsSync(envPath)) {
  console.log('.env はすでにあります。変更しません。');
  process.exit(0);
}
let text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const key = () => crypto.randomBytes(48).toString('base64url');
text = text.replace(/^TOKEN_SECRET=.*$/m, `TOKEN_SECRET=${key()}`).replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${key()}`);
fs.writeFileSync(envPath, text, { mode: 0o600 });
console.log('.env を作成しました。BASE_URL(サーバーPCのIPアドレス)を、メモ帳で開いて正しい値に直してください。');
