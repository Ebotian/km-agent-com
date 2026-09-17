import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../lib/db.mjs';
import * as id from '../lib/identity.mjs';
import * as posts from '../lib/posts.mjs';
import { CLI, makeTmpHome, cleanup, runCli, seedWindow } from './helpers.mjs';

/**
 * 造一棵假 /proc（不跨测试文件 import，保持本文件自足）——只给**故意不成对**的用例用：
 * 比如「pid 不在 /proc 里的窗口行应被清扫」。正常种窗口一律走 helpers.seedWindow。
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
 * `deaf` 会被正确判成 'dead' 而非 null。成对由 seedWindow 保证（见 helpers.mjs）。
 */
function seedHome() {
  const home = makeTmpHome();
  const procRoot = seedWindow(home, {
    pid: 100, sessionId: 'me', sessionTitle: 'A', cwd: '/p/agent-com',
    handle: 'agent-com', subscribes: ['agent-com'],
    watcherPid: 500, watcherUntil: 9e15,
  });
  seedWindow(home, { pid: 200, sessionId: 'other', sessionTitle: 'B', cwd: '/p/other', handle: 'other' });
  return { home, procRoot };
}

/**
 * 持有者 handle 撑到 256KB 的家目录：冲突文案（`已被 <handle> 占用，…`）因此必然
 * 超过管道缓冲（64KB），于是「大 stdout」与「非零退出码」两件事可以同时考。
 */
function seedBigHandleHome() {
  const home = makeTmpHome();
  const procRoot = seedWindow(home, {
    pid: 300, sessionId: 'big', sessionTitle: 'big', cwd: '/p/big', handle: 'h'.repeat(256 * 1024),
  });
  seedWindow(home, { pid: 200, sessionId: 'other', sessionTitle: 'B', cwd: '/p/other', handle: 'other' });
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

test('post --to 命中重名 handle 时报歧义并列出候选，且不落库', () => {
  const { home, procRoot } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    // 模拟 Task 5 修 R-I1 之前可能留下的重名行：两个窗口共用 handle 'dup'。
    // session_id 与 handle 都不等于 'dup'，所以解析只能落在 handle 这一支。
    // R-O4 之后 CLI 每条命令都会顺带清扫活不下来的 presence 行，所以这两行必须
    // 在假 /proc 里各有对应的 kimi-code 进程，否则会被当成死窗口删掉。
    seedProc(procRoot, [
      { pid: 300, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
      { pid: 301, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' },
    ]);
    id.upsertPresence(db, { tuiPid: 300, sessionId: 'session_x1', sessionTitle: 'C', cwd: '/p/dup', handle: 'dup' });
    id.upsertPresence(db, { tuiPid: 301, sessionId: 'session_x2', sessionTitle: 'D', cwd: '/p/dup2', handle: 'dup' });
    db.close();

    const r = runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', 'x',
      '--to', 'dup', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /歧义/);
    assert.match(r.stderr, /session_x1/);
    assert.match(r.stderr, /session_x2/);

    const after = openDb(join(home, 'agent-bus', 'bus.db'));
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0,
      '重名时必须拒绝，绝不能猜一个收件人把帖子投出去');
    after.close();
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

// —— Task 8：认领命令、任务列表、审计日志 ——
// 注意所有 runCli 都带上了 seedHome 造的假 procRoot。R-O4 之后 CLI 的公共路径会跑
// identity.reapDead，不给 procRoot 时它拿真实 /proc 核对 pid 100/200（那里没有
// kimi-code），会把刚种下的 presence 行当死窗口删掉，其后的 resolveSelf 全部失败。

test('claim 成功后第二个窗口被拒，退出码 2 且报出持有者', () => {
  const { home, procRoot } = seedHome();
  try {
    const a = runCli(['claim', '/p/agent-com/lib/db.mjs', '--ttl', '30m', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(a.status, 0);
    assert.equal(JSON.parse(a.stdout).claimed, true);

    const b = runCli(['claim', '/p/agent-com/lib/db.mjs', '--ttl', '30m', '--session', 'other', '--home', home], { home, procRoot });
    assert.equal(b.status, 2);
    assert.match(b.stderr, /agent-com/);
  } finally { cleanup(home); }
});

test('claim 会同步出 claims.marker，release 后消失', () => {
  const { home, procRoot } = seedHome();
  try {
    const mp = join(home, 'agent-bus', 'claims.marker');
    assert.equal(existsSync(mp), false);
    runCli(['claim', '/p/agent-com/x', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(existsSync(mp), true);
    runCli(['release', '/p/agent-com/x', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(existsSync(mp), false);
  } finally { cleanup(home); }
});

test('busy 对空闲资源退出 0，对被占资源退出 2', () => {
  const { home, procRoot } = seedHome();
  try {
    assert.equal(runCli(['busy', '/p/agent-com/x', '--session', 'other', '--home', home], { home, procRoot }).status, 0);
    runCli(['claim', '/p/agent-com/x', '--session', 'me', '--ttl', '1h', '--home', home], { home, procRoot });
    const b = runCli(['busy', '/p/agent-com/x', '--session', 'other', '--home', home], { home, procRoot });
    assert.equal(b.status, 2);
    assert.match(b.stdout, /agent-com/);
  } finally { cleanup(home); }
});

test('--ttl 解析 s/m/h', () => {
  const { home, procRoot } = seedHome();
  try {
    runCli(['claim', '/p/agent-com/x', '--ttl', '2h', '--session', 'me', '--json', '--home', home], { home, procRoot });
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    const row = db.prepare('SELECT lease_until FROM claims WHERE resource = ?').get('/p/agent-com/x');
    const delta = row.lease_until - Date.now();
    assert.ok(delta > 7_000_000 && delta <= 7_200_000, `2h 应约等于 7200000ms，实际 ${delta}`);
    db.close();
  } finally { cleanup(home); }
});

test('tasks 列出开放任务，done 之后消失', () => {
  const { home, procRoot } = seedHome();
  try {
    runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', '跑 pytest',
      '--session', 'me', '--json', '--home', home], { home, procRoot });
    const before = JSON.parse(runCli(['tasks', '--session', 'me', '--json', '--home', home], { home, procRoot }).stdout);
    assert.equal(before.tasks.length, 1);
    assert.equal(before.tasks[0].post.title, '跑 pytest');

    assert.equal(runCli(['claim', 'task:1', '--session', 'other', '--home', home], { home, procRoot }).status, 0);
    const claimed = JSON.parse(runCli(['tasks', '--session', 'me', '--json', '--home', home], { home, procRoot }).stdout);
    assert.equal(claimed.tasks.length, 0, '被认领的任务不在开放列表里');

    assert.equal(runCli(['done', '1', '--session', 'other', '--home', home], { home, procRoot }).status, 0);
    const finished = JSON.parse(runCli(['tasks', '--session', 'me', '--json', '--home', home], { home, procRoot }).stdout);
    assert.equal(finished.tasks.length, 0, '完成的任务不在开放列表里');
  } finally { cleanup(home); }
});

test('done 对非本人持有的任务退出码 2', () => {
  const { home, procRoot } = seedHome();
  try {
    runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', 'x', '--session', 'me', '--home', home], { home, procRoot });
    runCli(['claim', 'task:1', '--session', 'other', '--home', home], { home, procRoot });
    const r = runCli(['done', '1', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(r.status, 2);
  } finally { cleanup(home); }
});

test('--ttl 缺省 30m，接受 90s 与纯毫秒，非法值退出码 1', () => {
  const { home, procRoot } = seedHome();
  try {
    const t0 = Date.now();
    runCli(['claim', '/p/t-default', '--session', 'me', '--home', home], { home, procRoot });
    runCli(['claim', '/p/t-sec', '--ttl', '90s', '--session', 'me', '--home', home], { home, procRoot });
    runCli(['claim', '/p/t-ms', '--ttl', '1500', '--session', 'me', '--home', home], { home, procRoot });
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    const leaseOf = res => db
      .prepare('SELECT lease_until FROM claims WHERE resource = ?').get(res).lease_until - t0;
    assert.ok(leaseOf('/p/t-default') >= 1_800_000 && leaseOf('/p/t-default') < 1_805_000,
      `缺省应为 30m，实际 ${leaseOf('/p/t-default')}`);
    assert.ok(leaseOf('/p/t-sec') >= 90_000 && leaseOf('/p/t-sec') < 95_000,
      `90s 应为 90000ms，实际 ${leaseOf('/p/t-sec')}`);
    assert.ok(leaseOf('/p/t-ms') >= 1_500 && leaseOf('/p/t-ms') < 6_500,
      `纯数字应为毫秒，实际 ${leaseOf('/p/t-ms')}`);
    db.close();

    const bad = runCli(['claim', '/p/t-bad', '--ttl', '5x', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ttl/);
  } finally { cleanup(home); }
});

test('已完成资源渲染成「已完成」，不打印 1970 时间戳', () => {
  const { home, procRoot } = seedHome();
  try {
    runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', 'x', '--session', 'me', '--home', home], { home, procRoot });
    runCli(['claim', 'task:1', '--session', 'other', '--home', home], { home, procRoot });
    runCli(['done', '1', '--session', 'other', '--home', home], { home, procRoot });

    const b = runCli(['busy', 'task:1', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(b.status, 2);
    assert.match(b.stdout, /已完成/);
    assert.equal(b.stdout.includes('1970'), false, 'leaseUntil 为 null 时不得渲染成 epoch');

    const c = runCli(['claim', 'task:1', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(c.status, 2);
    assert.match(c.stderr, /已完成/);
    assert.equal(c.stderr.includes('1970'), false, 'leaseUntil 为 null 时不得渲染成 epoch');

    const j = runCli(['claim', 'task:1', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(j.status, 2);
    assert.deepEqual(JSON.parse(j.stdout), { claimed: false, holder: 'other', leaseUntil: null });
  } finally { cleanup(home); }
});

test('done --result 回一条 finding 给任务发起人', () => {
  const { home, procRoot } = seedHome();
  try {
    runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', '跑 pytest', '--session', 'me', '--home', home], { home, procRoot });
    runCli(['claim', 'task:1', '--session', 'other', '--home', home], { home, procRoot });
    const r = runCli(['done', '1', '--result', '全绿 87/87', '--session', 'other', '--home', home], { home, procRoot });
    assert.equal(r.status, 0);

    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    const reply = db.prepare('SELECT * FROM posts WHERE reply_to = 1').get();
    db.close();
    assert.equal(reply.topic, 'agent-com');
    assert.equal(reply.kind, 'finding');
    assert.equal(reply.to_session, 'me', '结果定向回任务发起人');
    assert.equal(reply.author_session, 'other');
    assert.equal(reply.body, '全绿 87/87');
  } finally { cleanup(home); }
});

test('任何命令都顺带清扫死窗口的 presence 行', () => {
  const home = makeTmpHome();
  try {
    const procRoot = join(home, 'proc');
    seedProc(procRoot, [{ pid: 200, comm: 'kimi-code', ppid: 1, cmdline: 'kimi-code' }]);
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    id.upsertPresence(db, { tuiPid: 100, sessionId: 'me', sessionTitle: 'A', cwd: '/p/agent-com', handle: 'agent-com' });
    id.upsertPresence(db, { tuiPid: 200, sessionId: 'other', sessionTitle: 'B', cwd: '/p/other', handle: 'other' });
    db.close();

    assert.equal(runCli(['whoami', '--session', 'other', '--home', home], { home, procRoot }).status, 0);

    const after = openDb(join(home, 'agent-bus', 'bus.db'));
    const pids = after.prepare('SELECT tui_pid FROM presence ORDER BY tui_pid').all().map(r => r.tui_pid);
    after.close();
    assert.deepEqual(pids, [200], 'pid 不在 /proc 里的窗口行应由任何一次 bus 命令清掉');
  } finally { cleanup(home); }
});

test('log 读审计日志：最新在前、--limit 生效、缺文件不报错', () => {
  const { home, procRoot } = seedHome();
  try {
    const none = runCli(['log', '--home', home], { home, procRoot });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /无审计记录/);

    for (const title of ['t1', 't2', 't3']) {
      runCli(['post', '--topic', 'agent-com', '--kind', 'finding', '--title', title, '--session', 'me', '--home', home], { home, procRoot });
    }

    const human = runCli(['log', '--limit', '2', '--home', home], { home, procRoot });
    const lines = human.stdout.trim().split('\n');
    assert.equal(lines.length, 2, '--limit 2 只输出两行');
    assert.match(lines[0], /post\t3 agent-com finding/, '最新的在最前');
    assert.match(lines[1], /post\t2 agent-com finding/);

    const json = runCli(['log', '--limit', '2', '--json', '--home', home], { home, procRoot });
    const entries = JSON.parse(json.stdout);
    assert.ok(Array.isArray(entries), '--json 输出数组');
    assert.deepEqual(entries.map(e => e.detail), ['3 agent-com finding', '2 agent-com finding']);
    assert.equal(entries[0].actor, 'me');

    const all = JSON.parse(runCli(['log', '--json', '--home', home], { home, procRoot }).stdout);
    assert.equal(all.length, 3, '默认取最后 20 条');
  } finally { cleanup(home); }
});

test('stdout 被下游提前关闭时，EPIPE 不把退出码 2 改写成 0', () => {
  const { home, procRoot } = seedBigHandleHome();
  try {
    assert.equal(runCli(['claim', '/p/agent-com/x', '--session', 'big', '--home', home], { home, procRoot }).status, 0);

    // 下游（head -c 0）在读之前就关掉读端 → 写必以 EPIPE 失败，这条链不靠时序运气。
    const r = spawnSync('/bin/bash', ['-c',
      `"${process.execPath}" "${CLI}" busy /p/agent-com/x --session other --home "${home}" | head -c 0; exit \${PIPESTATUS[0]}`],
      { encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home, AGENT_BUS_PROC_ROOT: procRoot } });
    assert.equal(r.status, 2, `EPIPE 处理器必须保留 busy 已置的 2，实际 ${r.status}`);
  } finally { cleanup(home); }
});

test('冲突路径上超过管道缓冲的 stdout 也被完整写出（用 exitCode 而非 process.exit）', () => {
  const { home, procRoot } = seedBigHandleHome();
  try {
    runCli(['claim', '/p/agent-com/x', '--session', 'big', '--home', home], { home, procRoot });
    const r = runCli(['claim', '/p/agent-com/x', '--session', 'other', '--home', home], { home, procRoot });
    assert.equal(r.status, 2);
    assert.ok(r.stdout.length > 256 * 1024,
      `失败路径的 stdout 被截断在管道容量（${r.stdout.length} 字节）`);
    assert.equal(r.stdout.endsWith('\n'), true, '整行都写完了');
    assert.ok(r.stderr.length > 256 * 1024, `stderr 同样被截断（${r.stderr.length} 字节）`);
  } finally { cleanup(home); }
});

// —— R-P2：三条同族加固（见 task-9 裁决）——

test('--ttl 0 与荒谬上界在写库之前就被拒，资源不被污染', () => {
  const { home, procRoot } = seedHome();
  try {
    // 0ms：claim 会返回 claimed:true 但租约当场过期（幽灵成功）。
    // 99999999999h：lease_until ≈ 3.6e17，过了写库，随后的成功文案 toISOString 抛
    // RangeError ⇒ 成功被报成 exit 1，且该资源此后任何 busy/claim 都崩（中毒资源）。
    for (const ttl of ['0', '0ms', '99999999999h', '400d', '99999999999999999999999ms']) {
      const r = runCli(['claim', '/p/t-ghost', '--ttl', ttl, '--session', 'me', '--home', home], { home, procRoot });
      assert.equal(r.status, 1, `--ttl ${ttl} 应被拒，实际 ${r.status}`);
      assert.match(r.stderr, /ttl/, `--ttl ${ttl} 的错误文案要能自查`);
    }

    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM claims WHERE resource = ?').get('/p/t-ghost').n, 0,
      '拒绝必须发生在写库之前：一行租约都不能留下');
    db.close();

    assert.equal(runCli(['busy', '/p/t-ghost', '--session', 'me', '--home', home], { home, procRoot }).status, 0,
      '被拒之后资源仍应是空闲（不能变成既不是 2 也不是 0 的状态）');
    assert.equal(runCli(['claim', '/p/t-ghost', '--ttl', '30m', '--session', 'me', '--home', home], { home, procRoot }).status, 0);

    // 上界本身必须还能用：8760h = 365 天正好是上限
    const t0 = Date.now();
    assert.equal(runCli(['claim', '/p/t-max', '--ttl', '8760h', '--session', 'me', '--home', home], { home, procRoot }).status, 0);
    const db2 = openDb(join(home, 'agent-bus', 'bus.db'));
    const leaseMs = db2.prepare('SELECT lease_until FROM claims WHERE resource = ?').get('/p/t-max').lease_until - t0;
    db2.close();
    assert.ok(leaseMs >= 31_536_000_000 && leaseMs < 31_536_005_000, `8760h 应约等于 365 天，实际 ${leaseMs}`);
  } finally { cleanup(home); }
});

test('log 跳过非有限/超出 Date 范围的时间戳，不因坏行崩掉', () => {
  const { home, procRoot } = seedHome();
  try {
    mkdirSync(join(home, 'agent-bus'), { recursive: true });
    writeFileSync(join(home, 'agent-bus', 'log.jsonl'), [
      '{"ts":1e999,"actor":"x","action":"infinity","detail":"JSON.parse 得到 Infinity"}',
      '{"ts":1e18,"actor":"x","action":"out-of-range","detail":"超出 Date 表示范围"}',
      '{"ts":1,"actor":"me","action":"post","detail":"ok"}',
    ].join('\n') + '\n');

    const r = runCli(['log', '--json', '--home', home], { home, procRoot });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).map(e => e.action), ['post'], '坏行跳过，好行照读');
    const human = runCli(['log', '--home', home], { home, procRoot });
    assert.equal(human.status, 0);
    assert.match(human.stdout, /ok/);
  } finally { cleanup(home); }
});

test('非 EPIPE 的 stdout 写错误不覆盖已置的退出码，也不让失败变成功', () => {
  const { home, procRoot } = seedHome();
  // /dev/full 上的写必以 ENOSPC 失败，不靠时序运气。
  const fd = openSync('/dev/full', 'w');
  try {
    assert.equal(runCli(['claim', '/p/agent-com/x', '--session', 'me', '--home', home], { home, procRoot }).status, 0);

    const busy = spawnSync(process.execPath,
      [CLI, 'busy', '/p/agent-com/x', '--session', 'other', '--home', home],
      { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8',
        env: { ...process.env, KIMI_CODE_HOME: home, AGENT_BUS_PROC_ROOT: procRoot } });
    assert.equal(busy.status, 2, `ENOSPC 不得把 busy 已置的 2 改写成 1，实际 ${busy.status}`);

    const ok = spawnSync(process.execPath,
      [CLI, 'whoami', '--session', 'me', '--home', home],
      { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8',
        env: { ...process.env, KIMI_CODE_HOME: home, AGENT_BUS_PROC_ROOT: procRoot } });
    assert.equal(ok.status, 1, '输出没送达就不能以 0 退出');
  } finally { closeSync(fd); cleanup(home); }
});
