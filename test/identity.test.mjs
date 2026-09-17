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

/**
 * 生产形态：引擎用 `shell: true` 起 hook，而 `/bin/sh -c "单条命令"` 会把命令 **exec 掉**，
 * 于是 hook 的直接父进程**就是** kimi-code 窗口自己——祖先链上只有一层。
 *
 * 所以起点必须是**含**自己的：`resolveWindow` 的默认 `startPid` 是 `process.pid`
 * （"从我自己往上找"），实现却只查父链、把起点那一层跳过去 ⇒ 传 ppid 就等于从窗口的
 * 父进程开始找，整条 walk 落空，窗口**静默**不登记。
 */
test('kimi-code ← node（shell 被 exec 掉）：起点自己就在链上，认得出窗口', () => {
  const root = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 300, comm: 'node', ppid: 100, cmdline: 'node hook.mjs' },
  ]);
  try {
    assert.equal(id.findKimiAncestor(300, root), 100);
    assert.equal(id.findKimiAncestor(100, root), 100, '起点本身就是窗口时也要认得自己');
  } finally { cleanup(root); }
});

test('resolveWindow：两种祖先链形态都解得出窗口，显式 pid 优先', () => {
  const withShell = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 200, comm: 'sh', ppid: 100, cmdline: 'sh -c node hook.mjs' },
    { pid: 300, comm: 'node', ppid: 200, cmdline: 'node hook.mjs' },
  ]);
  const execd = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 300, comm: 'node', ppid: 100, cmdline: 'node hook.mjs' },
  ]);
  try {
    assert.equal(id.resolveWindow({ procRoot: withShell, startPid: 300 }), 100, '中间隔着 shell');
    assert.equal(id.resolveWindow({ procRoot: execd, startPid: 300 }), 100, 'shell 被 exec 掉');
    assert.equal(id.resolveWindow({ procRoot: execd, startPid: 300, pid: 999 }), 999,
      '显式指定的 pid（AGENT_BUS_TUI_PID / --tui-pid）优先，且不查 /proc');
    assert.equal(id.resolveWindow({ procRoot: execd, startPid: 300, pid: '0' }), 100,
      '0 / 空 / 非法值一律当作"没给"，不能当成 pid 0');
    assert.equal(id.resolveWindow({ procRoot: execd, startPid: 300, pid: '' }), 100);
    assert.equal(id.resolveWindow({ procRoot: execd, startPid: 300, pid: 'abc' }), 100);
  } finally { cleanup(withShell); cleanup(execd); }
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

test('alive 走 cmdline 校验：pid 被复用不算活窗口', () => {
  const home = makeTmpHome();
  const root = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 600, comm: 'node', ppid: 1, cmdline: 'node /tmp/other.js' },   // 复用了他人的 pid
  ]);
  try {
    const db = openDb(join(home, 'bus.db'));
    id.upsertPresence(db, { tuiPid: 100, sessionId: 'real', sessionTitle: '', cwd: '/p', handle: 'a' });
    id.upsertPresence(db, { tuiPid: 600, sessionId: 'reused', sessionTitle: '', cwd: '/p', handle: 'b' });

    const bySid = Object.fromEntries(
      id.listPresence(db, { now: 1000, procRoot: root }).map(r => [r.sessionId, r]));
    assert.equal(bySid.real.alive, true, 'cmdline 是 kimi-code ⇒ 真窗口');
    assert.equal(bySid.reused.alive, false, '目录存在但 cmdline 不是 kimi-code ⇒ pid 被复用，不算活窗口');

    assert.equal(id.reapDead(db, { procRoot: root }), 1, '只回收被复用的那行');
    assert.deepEqual(id.listPresence(db, { now: 1000, procRoot: root }).map(r => r.sessionId), ['real']);
  } finally { cleanup(home); cleanup(root); }
});

test('watcher pid 被复用（cmdline 不是 bus.mjs watch）判为 dead', () => {
  const home = makeTmpHome();
  const root = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 601, comm: 'node', ppid: 1, cmdline: 'node /tmp/other.js' },                     // 复用
    { pid: 602, comm: 'node', ppid: 1, cmdline: 'node /x/bin/bus.mjs watch --session s' },  // 真 watcher
  ]);
  try {
    const db = openDb(join(home, 'bus.db'));
    id.upsertPresence(db, { tuiPid: 100, sessionId: 's1', sessionTitle: '', cwd: '/p/a', handle: 'a' });

    id.setWatcher(db, { tuiPid: 100, watcherPid: 601, watcherUntil: 999999 });
    assert.equal(id.listPresence(db, { now: 1000, procRoot: root })[0].deaf, 'dead',
      '租约没过期，但 watcher 的 cmdline 不是 bus.mjs watch ⇒ 复用');

    id.setWatcher(db, { tuiPid: 100, watcherPid: 602, watcherUntil: 999999 });
    assert.equal(id.listPresence(db, { now: 1000, procRoot: root })[0].deaf, null,
      'cmdline 含 bus.mjs watch 的真 watcher 不算聋');
  } finally { cleanup(home); cleanup(root); }
});

test('registerPresence 的 handle 在会话重启后保持稳定', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'bus.db'));
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's1', sessionTitle: 't', cwd: '/p/agent-com' }),
      'agent-com');
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's2', sessionTitle: 't', cwd: '/p/agent-com' }),
      'agent-com',
      '模拟 /new：同一窗口同一 cwd 再注册，不能因为看到自己那一行就换成 agent-com-2');

    const rows = id.listPresence(db, { now: 0, procRoot: '/nonexistent' });
    assert.equal(rows.length, 1, '同一 tui_pid 仍然只有一行');
    assert.equal(rows[0].handle, 'agent-com');
    assert.equal(rows[0].sessionId, 's2');
  } finally { cleanup(home); }
});

test('两个窗口的同名目录拿到不同 handle，且各自重复注册不漂移', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'bus.db'));
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's1', sessionTitle: '', cwd: '/p/agent-com' }),
      'agent-com');
    assert.equal(id.registerPresence(db, { tuiPid: 2, sessionId: 's2', sessionTitle: '', cwd: '/p/agent-com' }),
      'agent-com-2');
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's1b', sessionTitle: '', cwd: '/p/agent-com' }),
      'agent-com');
    assert.equal(id.registerPresence(db, { tuiPid: 2, sessionId: 's2b', sessionTitle: '', cwd: '/p/agent-com' }),
      'agent-com-2', '拿了 -2 的窗口重启后不能被降级回 agent-com');

    assert.deepEqual(
      id.listPresence(db, { now: 0, procRoot: '/nonexistent' }).map(r => r.handle),
      ['agent-com', 'agent-com-2'], '两行 handle 必须互不相同');
  } finally { cleanup(home); }
});

test('cwd 变了才换 handle', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'bus.db'));
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's1', sessionTitle: '', cwd: '/p/agent-com' }),
      'agent-com');
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's2', sessionTitle: '', cwd: '/q/other' }),
      'other');
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's3', sessionTitle: '', cwd: '/q/other' }),
      'other');

    const rows = id.listPresence(db, { now: 0, procRoot: '/nonexistent' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].handle, 'other');
  } finally { cleanup(home); }
});

test('registerPresence 失败时回滚，且不留下未结束的事务', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'bus.db'));
    assert.throws(
      () => id.registerPresence(db, { tuiPid: 1, sessionId: 's', sessionTitle: '', cwd: '/p/---' }),
      /无法从 cwd 推导主题/, '错误契约来自 topicFromCwd，不再是 topic 模块内部的「主题不能为空」');

    assert.deepEqual(id.listPresence(db, { now: 0, procRoot: '/nonexistent' }), []);
    assert.equal(id.registerPresence(db, { tuiPid: 1, sessionId: 's', sessionTitle: '', cwd: '/p/agent-com' }),
      'agent-com', '失败路径已 ROLLBACK，后续 BEGIN IMMEDIATE 不会撞上未结束的事务');
  } finally { cleanup(home); }
});

test('listPresence 可裸调（now 与 procRoot 都有默认值）', () => {
  const home = makeTmpHome();
  try {
    const db = openDb(join(home, 'bus.db'));
    id.registerPresence(db, { tuiPid: 1, sessionId: 's1', sessionTitle: '', cwd: '/p/agent-com' });

    const rows = id.listPresence(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].handle, 'agent-com');
    assert.equal(rows[0].deaf, 'never');
  } finally { cleanup(home); }
});

test('listPresence 省略 now 时用当前时间，不把过期租约报成不聋', () => {
  const home = makeTmpHome();
  const root = fakeProc([
    { pid: 100, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    { pid: 500, comm: 'node', ppid: 1, cmdline: 'node bin/bus.mjs watch' },
  ]);
  try {
    const db = openDb(join(home, 'bus.db'));
    id.registerPresence(db, { tuiPid: 100, sessionId: 's1', sessionTitle: '', cwd: '/p/a' });
    id.setWatcher(db, { tuiPid: 100, watcherPid: 500, watcherUntil: 1 });   // 1970 年就到期了

    const rows = id.listPresence(db, { procRoot: root });                   // 故意不传 now
    assert.equal(rows[0].deaf, 'expired', 'now 默认为当前时间 ⇒ 过期租约不能报成 null');
    assert.equal(rows[0].alive, true, '对照：窗口本身是活的');
  } finally { cleanup(home); cleanup(root); }
});
