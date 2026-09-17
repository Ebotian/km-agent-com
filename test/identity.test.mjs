import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as id from '../lib/identity.mjs';
import { makeTmpHome, cleanup } from './helpers.mjs';

/** 造一棵假 /proc。spec: [pid, comm, ppid, cmdline(空格填充版)] */
function fakeProc(entries) {
  const root = makeTmpHome();
  for (const { pid, comm, ppid, cmdline } of entries) {
    const d = join(root, String(pid));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0\n`);
    writeFileSync(join(d, 'cmdline'), cmdline + '\0');
  }
  return root;
}

test('parseStatPpid 从 comm 里带空格/括号的行中取 ppid', () => {
  assert.equal(id.parseStatPpid('42 (node) S 7 1 1 0 -1\n'), 7);
  assert.equal(id.parseStatPpid('42 (my (weird) name) S 99 1 1 0 -1\n'), 99);
  assert.equal(id.parseStatPpid('garbage'), null);
});

test('cmdlineRole 认得 kimi-code 的尾部空格填充', () => {
  assert.equal(id.cmdlineRole('kimi-code            '), 'kimi-code');
  assert.equal(id.cmdlineRole('kimi-code'), 'kimi-code');
  assert.equal(id.cmdlineRole('node /x/bin/bus.mjs watch --session s'), 'bus-watch');
  assert.equal(id.cmdlineRole('bash'), null);
  assert.equal(id.cmdlineRole('kimi-code-helper'), null);
});

test('findKimiAncestor 跳过中间的 shell，找到 kimi-code 祖先', () => {
  const root = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code      ' },
    { pid: 200, comm: 'sh', ppid: 100, cmdline: 'sh -c node hook.mjs' },
    { pid: 300, comm: 'node', ppid: 200, cmdline: 'node hook.mjs' },
  ]);
  try {
    assert.equal(id.findKimiAncestor(300, root), 100);
  } finally { cleanup(root); }
});

test('findKimiAncestor 找不到时返回 null，且不会因环而挂死', () => {
  const root = fakeProc([
    { pid: 1, comm: 'init', ppid: 1, cmdline: 'init' },
    { pid: 300, comm: 'node', ppid: 1, cmdline: 'node hook.mjs' },
  ]);
  try {
    assert.equal(id.findKimiAncestor(300, root), null);
  } finally { cleanup(root); }
});

test('handleFromCwd 冲突时加后缀', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'bus.db'));
    assert.equal(id.handleFromCwd(db, '/p/agent-com'), 'agent-com');
    id.upsertPresence(db, { tuiPid: 1, sessionId: 's1', sessionTitle: 't', cwd: '/p/agent-com', handle: 'agent-com' });
    assert.equal(id.handleFromCwd(db, '/q/agent-com'), 'agent-com-2');
    id.upsertPresence(db, { tuiPid: 2, sessionId: 's2', sessionTitle: 't', cwd: '/q/agent-com', handle: 'agent-com-2' });
    assert.equal(id.handleFromCwd(db, '/r/agent-com'), 'agent-com-3');
  } finally { cleanup(home); }
});

test('listPresence 标出三种聋状态与存活', () => {
  const home = makeTmpHome();
  const root = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 500, comm: 'node', ppid: 100, cmdline: 'node bin/bus.mjs watch' },
  ]);
  try {
    const db = openDb(join(home, 'bus.db'));
    id.upsertPresence(db, { tuiPid: 100, sessionId: 's1', sessionTitle: 'A', cwd: '/p/a', handle: 'a' });
    id.setWatcher(db, { tuiPid: 100, watcherPid: 500, watcherUntil: 999999 });

    id.upsertPresence(db, { tuiPid: 101, sessionId: 's2', sessionTitle: 'B', cwd: '/p/b', handle: 'b' });
    id.setWatcher(db, { tuiPid: 101, watcherPid: 999, watcherUntil: 999999 });   // 进程不存在

    id.upsertPresence(db, { tuiPid: 102, sessionId: 's3', sessionTitle: 'C', cwd: '/p/c', handle: 'c' });
    id.setWatcher(db, { tuiPid: 102, watcherPid: 500, watcherUntil: 1 });        // 已超时

    id.upsertPresence(db, { tuiPid: 103, sessionId: 's4', sessionTitle: 'D', cwd: '/p/d', handle: 'd' });

    const rows = id.listPresence(db, { now: 1000, procRoot: root });
    const bySid = Object.fromEntries(rows.map(r => [r.sessionId, r]));
    assert.equal(bySid.s1.deaf, null);
    assert.equal(bySid.s2.deaf, 'dead');
    assert.equal(bySid.s3.deaf, 'expired');
    assert.equal(bySid.s4.deaf, 'never');
    assert.equal(bySid.s1.alive, true);
    assert.equal(bySid.s4.alive, false, 'pid 103 不在假 /proc 里');
  } finally { cleanup(home); cleanup(root); }
});

test('upsertPresence 按 tui_pid 覆盖而非插入新行', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'bus.db'));
    id.upsertPresence(db, { tuiPid: 7, sessionId: 'old', sessionTitle: 'x', cwd: '/p', handle: 'p' });
    id.upsertPresence(db, { tuiPid: 7, sessionId: 'new', sessionTitle: 'y', cwd: '/p2', handle: 'p2' });
    const rows = id.listPresence(db, { now: 0, procRoot: '/nonexistent' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, 'new');
    assert.equal(rows[0].watcherPid, null, '换会话后旧 watcher 登记应被清掉');
  } finally { cleanup(home); }
});

test('reapDead 删掉 /proc 里不存在的窗口', () => {
  const home = makeTmpHome();
  const root = fakeProc([{ pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' }]);
  try {
    const db = openDb(join(home, 'bus.db'));
    id.upsertPresence(db, { tuiPid: 100, sessionId: 'live', sessionTitle: '', cwd: '/p', handle: 'a' });
    id.upsertPresence(db, { tuiPid: 101, sessionId: 'dead', sessionTitle: '', cwd: '/p', handle: 'b' });
    assert.equal(id.reapDead(db, { procRoot: root }), 1);
    assert.deepEqual(id.listPresence(db, { now: 0, procRoot: root }).map(r => r.sessionId), ['live']);
  } finally { cleanup(home); cleanup(root); }
});
