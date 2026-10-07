'use strict';
// SQLite(Node.js標準機能)。データは1ファイルに保存される。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('full','part')),
  pattern TEXT NOT NULL DEFAULT 'pattern1' CHECK (pattern IN ('pattern1','pattern2')),
  pt_start TEXT NOT NULL DEFAULT '09:00',
  pt_end TEXT NOT NULL DEFAULT '18:30',
  pt_break INTEGER NOT NULL DEFAULT 90,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
  pw_hash TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_emp ON sessions(employee_id);

CREATE TABLE IF NOT EXISTS login_fails (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tablets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  secret_hash TEXT,
  reg_code_hash TEXT,
  reg_expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  registered_at INTEGER,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS used_tokens (
  token_id TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

-- 打刻。修正しても元の行は消さず、voided=1 にして新しい行を追加する。
CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL CHECK (type IN ('in','out')),
  ts INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  hhmm TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('qr','admin','import')),
  token_id TEXT,
  tablet_id INTEGER,
  warning TEXT,
  voided INTEGER NOT NULL DEFAULT 0,
  voided_at INTEGER,
  voided_by INTEGER,
  void_reason TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_punch_emp_date ON punches(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_punch_date ON punches(work_date);

CREATE TABLE IF NOT EXISTS overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  work_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  half_shift TEXT NOT NULL,
  break_min INTEGER NOT NULL DEFAULT 0,
  slots TEXT NOT NULL DEFAULT '[]',
  normal_min INTEGER NOT NULL DEFAULT 0,
  night_min INTEGER NOT NULL DEFAULT 0,
  holiday_within8_min INTEGER NOT NULL DEFAULT 0,
  holiday_over8_min INTEGER NOT NULL DEFAULT 0,
  pt_start TEXT NOT NULL DEFAULT '',
  pt_end TEXT NOT NULL DEFAULT '',
  pt_base_min INTEGER NOT NULL DEFAULT 0,
  pt_over_min INTEGER NOT NULL DEFAULT 0,
  pt_memo TEXT NOT NULL DEFAULT '',
  is_match INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_id INTEGER,
  reviewed_at INTEGER,
  review_comment TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'app',
  legacy_history TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_ot_date ON overtime_requests(work_date);
CREATE INDEX IF NOT EXISTS idx_ot_status ON overtime_requests(status);

-- 修正履歴(追記専用。このテーブルを消す・書き換える機能は作らない)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  target_employee_id INTEGER,
  work_date TEXT,
  before TEXT,
  after TEXT,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_emp ON audit_log(target_employee_id, work_date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db;
function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
  db = new DatabaseSync(config.DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // 追記専用の約束をDB側でも守る
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, '修正履歴は変更できません'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, '修正履歴は削除できません'); END;
    CREATE TRIGGER IF NOT EXISTS punch_no_delete BEFORE DELETE ON punches BEGIN SELECT RAISE(ABORT, '打刻記録は削除できません'); END;
  `);
  return db;
}

function tx(fn) {
  const d = open();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

const all = (sql, ...p) => open().prepare(sql).all(...p);
const get = (sql, ...p) => open().prepare(sql).get(...p);
const run = (sql, ...p) => open().prepare(sql).run(...p);

function audit({ actor, action, entity, entityId = null, targetEmployeeId = null, workDate = null, before = null, after = null, reason = '' }) {
  run(
    `INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_id, target_employee_id, work_date, before, after, reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    Date.now(), actor ? actor.id : null, actor ? `${actor.name}(${actor.code})` : 'システム', action, entity, entityId,
    targetEmployeeId, workDate, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason || ''
  );
}

function getSetting(key, def) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

module.exports = { open, tx, all, get, run, audit, getSetting, setSetting };
