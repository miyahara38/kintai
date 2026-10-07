'use strict';
const { assertSecrets } = require('../src/config');
const db = require('../src/db');
const backup = require('../src/backup');
db.open();
console.log('バックアップを作成しました:', backup.runBackup());
