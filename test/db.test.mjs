import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../lib/db.mjs';
import { makeTmpHome, cleanup } from './helpers.mjs';

test('openDb 建出全部 5 张表', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.deepEqual(names, ['claims', 'posts', 'presence', 'read_cursor', 'subs']);
  } finally { cleanup(home); }
});

test('openDb 开启 WAL 并设置 busy_timeout', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  } finally { cleanup(home); }
});

test('migrate 对已建好的库幂等', () => {
  const home = makeTmpHome();
  try {
    const p = join(home, 'agent-bus', 'bus.db');
    openDb(p).close();
    const db = openDb(p);                       // 第二次打开会再跑一次 migrate
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  } finally { cleanup(home); }
});

test('openDb 会创建缺失的父目录', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'deep', 'nested', 'bus.db'));
    assert.ok(db);
  } finally { cleanup(home); }
});
