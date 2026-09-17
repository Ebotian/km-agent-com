import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as id from '../lib/identity.mjs';
import * as posts from '../lib/posts.mjs';
import { makeTmpHome, cleanup, runCli } from './helpers.mjs';

/**
 * 造一棵假 /proc（不跨测试文件 import，保持本文件自足）。
 * `/proc/<pid>/cmdline` 的真实格式是「每个 argv 元素一个 NUL 终止符」，
 * 所以填充时必须整体追加一个 `\0`，而不是逐字符插 NUL。
 */
function seedProc(root, entries) {
  for (const { pid, comm, ppid, cmdline } of entries) {
    const d = join(root, String(pid));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0\n`);
    writeFileSync(join(d, 'cmdline'), cmdline + '\0');
  }
}

/**
 * 窗口 me/other 与 me 的 watcher 都必须落在假 /proc 里：
 * watcherPid 用 process.pid 是失真的——那是测试进程，cmdline 不是 bus.mjs watch，
 * `deaf` 会被正确判成 'dead' 而非 null。
 */
function seedHome() {
  const home = makeTmpHome();
  const procRoot = join(home, 'proc');
  seedProc(procRoot, [
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 200, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 500, comm: 'node', ppid: 100, cmdline: 'node /x/bin/bus.mjs watch --session me' },
  ]);

  const db = openDb(join(home, 'agent-bus', 'bus.db'));
  id.upsertPresence(db, { tuiPid: 100, sessionId: 'me', sessionTitle: 'A', cwd: '/p/agent-com', handle: 'agent-com' });
  id.setWatcher(db, { tuiPid: 100, watcherPid: 500, watcherUntil: 9e15 });
  id.upsertPresence(db, { tuiPid: 200, sessionId: 'other', sessionTitle: 'B', cwd: '/p/other', handle: 'other' });
  posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
  db.close();
  return { home, procRoot };
}

test('whoami 解析出 --session 指定的身份', () => {
  const { home, procRoot } = seedHome();
  try {
    const r = runCli(['whoami', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(r.status, 0);
    const o = JSON.parse(r.stdout);
    assert.equal(o.sessionId, 'me');
    assert.equal(o.handle, 'agent-com');
    assert.deepEqual(o.subscriptions, ['agent-com']);
    assert.equal(o.deaf, null);
  } finally { cleanup(home); }
});

test('peers 列出窗口并标出聋状态', () => {
  const { home, procRoot } = seedHome();
  try {
    const r = runCli(['peers', '--session', 'me', '--json', '--home', home], { home, procRoot });
    const o = JSON.parse(r.stdout);
    const bySid = Object.fromEntries(o.peers.map(p => [p.sessionId, p]));
    assert.equal(bySid.me.deaf, null);
    assert.equal(bySid.other.deaf, 'never');
  } finally { cleanup(home); }
});

test('post 写入后可被收件人 poll 到', () => {
  const { home, procRoot } = seedHome();
  try {
    const r = runCli(['post', '--topic', 'agent-com', '--kind', 'finding',
      '--title', '结论是 X', '--body', '见 lib/db.mjs:88',
      '--session', 'other', '--json', '--home', home], { home, procRoot });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).seq, 1);
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    const got = posts.poll(db, { reader: 'me' });
    assert.equal(got.total, 1);
    assert.equal(got.weak[0].title, '结论是 X');
    db.close();
  } finally { cleanup(home); }
});

test('post 缺 --title 时以退出码 1 失败', () => {
  const { home, procRoot } = seedHome();
  try {
    const r = runCli(['post', '--topic', 'agent-com', '--kind', 'finding', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /title/);
  } finally { cleanup(home); }
});

test('digest 默认推进游标，--peek 不推进', () => {
  const { home, procRoot } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    posts.createPost(db, { topic: 'agent-com', authorSession: 'other', authorCwd: '/p/other',
      origin: 'agent', kind: 'finding', title: 'hello', now: 1 });
    db.close();

    const peek = runCli(['digest', '--peek', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(JSON.parse(peek.stdout).total, 1);
    const again = runCli(['digest', '--peek', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(JSON.parse(again.stdout).total, 1, 'peek 不得推进游标');

    const real = runCli(['digest', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(JSON.parse(real.stdout).total, 1);
    const after = runCli(['digest', '--peek', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(JSON.parse(after.stdout).total, 0, '非 peek 必须推进游标');
  } finally { cleanup(home); }
});

test('read 输出 frontmatter，--full 才带正文', () => {
  const { home, procRoot } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    posts.createPost(db, { topic: 'agent-com', authorSession: 'other', authorCwd: '/p/other',
      origin: 'agent', kind: 'finding', title: 'T', body: 'DETAIL', now: 1 });
    db.close();
    const brief = runCli(['read', '1', '--session', 'me', '--home', home], { home, procRoot });
    assert.match(brief.stdout, /seq: 1/);
    assert.equal(brief.stdout.includes('DETAIL'), false);
    const full = runCli(['read', '1', '--full', '--session', 'me', '--home', home], { home, procRoot });
    assert.match(full.stdout, /DETAIL/);
  } finally { cleanup(home); }
});

test('subscribe / subs / unsubscribe 闭环', () => {
  const { home, procRoot } = seedHome();
  try {
    assert.equal(runCli(['subscribe', 'general/x', '--session', 'me', '--home', home], { home, procRoot }).status, 0);
    const list = runCli(['subs', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.deepEqual(JSON.parse(list.stdout).subscriptions, ['agent-com', 'general/x']);
    assert.equal(runCli(['unsubscribe', 'general/x', '--session', 'me', '--home', home], { home, procRoot }).status, 0);
    const list2 = runCli(['subs', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.deepEqual(JSON.parse(list2.stdout).subscriptions, ['agent-com']);
  } finally { cleanup(home); }
});

test('post --to 支持 handle，解析不到时退出码 1 并列出候选', () => {
  const { home, procRoot } = seedHome();
  try {
    const ok = runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', '帮我跑测试',
      '--to', 'other', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(ok.status, 0);
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    assert.equal(posts.poll(db, { reader: 'other' }).strong.length, 1);
    db.close();

    const bad = runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', 'x',
      '--to', 'nobody', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /agent-com/);
  } finally { cleanup(home); }
});

test('未识别的命令以退出码 1 失败并打印用法', () => {
  const home = makeTmpHome();
  try {
    const r = runCli(['nope', '--home', home], { home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /用法/);
  } finally { cleanup(home); }
});
