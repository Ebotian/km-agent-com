import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

test('§5 的列级约束与索引在运行时强制', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));

    assert.throws(() => db.prepare(
      'INSERT INTO presence (tui_pid, session_id, cwd, handle) VALUES (?, ?, ?, ?)'
    ).run(1, null, '/tmp', 'me'), /NOT NULL/);

    assert.throws(() => db.prepare(
      'INSERT INTO posts (seq, topic, author_session, origin, kind, title, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(1, 't', 's', 'agent', 'status', 'x', 1), /CHECK constraint failed/);

    assert.throws(() => db.prepare(
      'INSERT INTO posts (seq, topic, author_session, origin, kind, title, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(2, 't', 's', 'system', 'request', 'x', 1), /CHECK constraint failed/);

    assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name='posts_topic_seq'"
    ).get());
  } finally { cleanup(home); }
});

test('6 个进程并发首开同一个冷库全部成功', async () => {
  const home = makeTmpHome();
  try {
    const dbPath = join(home, 'agent-bus', 'bus.db');
    const libDb = new URL('../lib/db.mjs', import.meta.url).href;
    // 共用起跑线：6 个子进程各自 boot 后自旋到同一时刻，才一起进 openDb。
    // 没有它这里的竞争就退化成"偶发"（实测旧代码下 10 次只红 5 次），失去牙齿。
    const startAt = Date.now() + 500;

    const child = `
import { openDb } from ${JSON.stringify(libDb)};
const [dbPath, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) {}
const db = openDb(dbPath);
const n = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
if (n !== 5) throw new Error('tables=' + n);
db.close();
`;

    const runOne = () => new Promise(resolve => {
      const cp = spawn(process.execPath,
        ['--input-type=module', '-e', child, dbPath, String(startAt)],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      cp.stderr.on('data', d => { err += d; });
      cp.on('close', code => resolve({ code, err: err.trim() }));
    });

    const results = await Promise.all(Array.from({ length: 6 }, runOne)); // 先全部 spawn，再一起 await

    const failed = results.filter(r => r.code !== 0);
    const brief = failed.map(r =>
      (r.err.split('\n').find(l => /Error:/.test(l)) || r.err.slice(0, 80)).trim());
    assert.deepEqual(failed.map(r => r.code), [],
      `${brief.length}/6 个子进程并发首开失败：${brief.join(' | ')}`);

    const db = openDb(dbPath);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 5);
  } finally { cleanup(home); }
});
