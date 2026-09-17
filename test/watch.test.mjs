import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as identity from '../lib/identity.mjs';
import * as posts from '../lib/posts.mjs';
import { makeTmpHome, cleanup, CLI, REPO, runCli, seedWindow } from './helpers.mjs';

/**
 * 窗口 me（pid 100）用成对夹具一次种下假 /proc 与 presence 行。
 * 必须成对：CLI 每条命令的公共路径（ctx → identity.reapDead）会拿 procRoot 核对
 * 每个 presence 行的 tui_pid 是不是活着的 kimi-code；pid 100 在真实 /proc 里不存在，
 * 只写 presence 的话它会在 watcher 刚启动时就被清掉（症状：resolveSelf exit 1）。
 */
function seedHome() {
  const home = makeTmpHome();
  const procRoot = seedWindow(home, {
    pid: 100, sessionId: 'me', sessionTitle: 'A', cwd: '/p/agent-com',
    handle: 'agent-com', subscribes: ['agent-com'],
  });
  return { home, procRoot };
}

function startWatch(home, procRoot, extra = []) {
  const child = spawn(process.execPath, [CLI, 'watch', '--session', 'me', '--home', home,
    '--proc-root', procRoot, '--interval', '50', ...extra], {
    env: { ...process.env, KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: REPO, AGENT_BUS_PROC_ROOT: procRoot },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function waitExit(child, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('watch 没有在预期时间内退出')), ms);
    child.on('exit', code => { clearTimeout(t); resolve(code); });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function presenceRow(home, sessionId = 'me') {
  const db = openDb(join(home, 'agent-bus', 'bus.db'));
  const row = db.prepare('SELECT watcher_pid, watcher_until FROM presence WHERE session_id = ?').get(sessionId);
  db.close();
  return row;
}

test('watch 启动后自注册 watcher_pid', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  try {
    await sleep(300);
    const row = presenceRow(home);
    assert.equal(row.watcher_pid, w.child.pid);
    assert.ok(row.watcher_until > Date.now());
  } finally { w.child.kill('SIGKILL'); cleanup(home); }
});

test('weak 消息不唤醒，进程继续等', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  try {
    await sleep(250);
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    posts.createPost(db, { topic: 'agent-com', authorSession: 'other', authorCwd: '/p/other',
      origin: 'agent', kind: 'finding', title: 'FYI', now: Date.now() });
    db.close();
    await sleep(400);
    assert.equal(w.child.exitCode, null, 'weak 不应该让 watcher 退出');
  } finally { w.child.kill('SIGKILL'); cleanup(home); }
});

test('strong 消息让 watcher 退出 0 并打印 seq', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  try {
    await sleep(250);
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    posts.createPost(db, { topic: 'agent-com', authorSession: 'other', authorCwd: '/p/other',
      origin: 'agent', kind: 'request', toSession: 'me', title: '帮我跑测试', now: Date.now() });
    db.close();
    const code = await waitExit(w.child);
    assert.equal(code, 0, w.stderr);
    const payload = JSON.parse(w.stdout.trim().split('\n').pop());
    assert.equal(payload.total, 1);
    assert.equal(payload.strong[0].title, '帮我跑测试');
  } finally { cleanup(home); }
});

test('一串 strong 合并成一次退出（批量投递）', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  try {
    await sleep(250);
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    for (let i = 0; i < 5; i++) {
      posts.createPost(db, { topic: 'agent-com', authorSession: 'other', authorCwd: '/p/other',
        origin: 'agent', kind: 'request', toSession: 'me', title: `ask${i}`, now: Date.now() });
    }
    db.close();
    const code = await waitExit(w.child);
    assert.equal(code, 0, w.stderr);
    const payload = JSON.parse(w.stdout.trim().split('\n').pop());
    assert.equal(payload.total, 5, '一次退出应带上全部待处理');
  } finally { cleanup(home); }
});

test('退出时清掉自己的 watcher 登记', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  await sleep(250);
  // 前置断言：没有它，「登记=null」在 setWatcher 整个坏掉时也会绿（空断言）
  assert.equal(presenceRow(home).watcher_pid, w.child.pid, '退出前必须先登记上');
  const db = openDb(join(home, 'agent-bus', 'bus.db'));
  posts.createPost(db, { topic: 'agent-com', authorSession: 'other', authorCwd: '/p/other',
    origin: 'agent', kind: 'request', toSession: 'me', title: 'x', now: Date.now() });
  db.close();
  await waitExit(w.child);
  assert.equal(presenceRow(home).watcher_pid, null);
  cleanup(home);
});

test('--max-wait 到点仍未命中则退出 3 且清理登记', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot, ['--max-wait', '400']);
  try {
    await sleep(250);
    assert.equal(presenceRow(home).watcher_pid, w.child.pid, '退出前必须先登记上');
    const code = await waitExit(w.child);
    assert.equal(code, 3, w.stderr);
    assert.match(w.stdout, /本轮无消息/, 'M5：任何终态都别留空 stdout（空 stdout = 一次没有内容的唤醒）');
    assert.equal(presenceRow(home).watcher_pid, null);
  } finally { cleanup(home); }
});

/**
 * R-Q4：exit 0 必须意味着"stdout 里确实有东西给你"。命中后、合并窗口内那条 strong 被
 * 读走（Task 10 的 UserPromptSubmit 先取，或用户此刻跑 digest），watcher 不能投一份空
 * triage 出去——那按 spec §3.3 就是一次 113k token 的空轮。
 *
 * 用例构造不靠时序运气：post 在 watcher 启动**之前**就落库，所以启动时的那次 poll 必
 * 定命中并进入合并窗口；`--interval 1500` 把窗口放大到 1.5s，消费动作稳稳落在窗口内。
 */
test('合并窗口内被消费掉的 strong 仍然照投，不产生空唤醒', async () => {
  const { home, procRoot } = seedHome();
  const db0 = openDb(join(home, 'agent-bus', 'bus.db'));
  posts.createPost(db0, { topic: 'agent-com', authorSession: 'other', authorCwd: '/p/other',
    origin: 'agent', kind: 'request', toSession: 'me', title: '帮我跑测试', now: Date.now() });
  db0.close();

  const w = startWatch(home, procRoot, ['--interval', '1500']);
  try {
    await sleep(400);   // 此时 watcher 已在合并窗口里（窗口还剩 >1s）
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    posts.ack(db, { reader: 'me', seq: 1 });
    // 证明场景真的发生了：库里此刻已无待处理，watcher 的二次 poll 必然是空的
    assert.equal(posts.poll(db, { reader: 'me' }).total, 0, '消费必须真的把帖子读走');
    db.close();

    const code = await waitExit(w.child);
    assert.equal(code, 0, w.stderr);
    const payload = JSON.parse(w.stdout.trim().split('\n').pop());
    assert.equal(payload.total, 1, 'exit 0 不能是空唤醒');
    assert.equal(payload.strong[0].title, '帮我跑测试');
  } finally { cleanup(home); }
});

/**
 * R-Q1：watcher 的识别建立在自己的 argv 文本上，所以进程**绝不能**改写 process.title
 * （那会改掉 /proc/<pid>/cmdline，把所有窗口判成聋）。这里直接读真实 /proc 来钉住它。
 */
test('watcher 在真实 /proc 里被判定为 bus-watch，peers 因此认它在听', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  try {
    await sleep(300);
    const real = identity.readCmdline(w.child.pid);
    assert.ok(real, '真实 /proc/<watcher pid>/cmdline 必须可读');
    assert.equal(identity.cmdlineRole(real), 'bus-watch', `cmdline 形状被破坏: ${real}`);
    assert.equal(real.split(' ')[0], process.execPath, `argv[0] 必须是解释器: ${real}`);
    assert.equal(real.split(' ')[1], CLI, '必须是 node <pluginRoot>/bin/bus.mjs watch 这个形状');
    assert.equal(real.split(' ')[2], 'watch', 'bus.mjs 与 watch 之间只允许路径与空白');
    assert.match(real, /bus\.mjs\s+watch\s/);

    // 把真实 cmdline 原样种进假 /proc：deaf 判定因此走真数据，而不是我手写的模板
    const dir = join(procRoot, String(w.child.pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cmdline'), real + '\0');
    const r = runCli(['peers', '--session', 'me', '--json', '--home', home], { home, procRoot });
    const peer = JSON.parse(r.stdout).peers.find(p => p.sessionId === 'me');
    assert.equal(peer.deaf, null, 'watcher 在跑，本窗口就不是聋的');
  } finally { w.child.kill('SIGKILL'); cleanup(home); }
});

test('SIGTERM 收工：退出 0 并清掉自己的登记', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  try {
    await sleep(250);
    assert.equal(presenceRow(home).watcher_pid, w.child.pid);
    w.child.kill('SIGTERM');
    assert.equal(await waitExit(w.child), 0, w.stderr);
    assert.equal(presenceRow(home).watcher_pid, null);
  } finally { cleanup(home); }
});

test('非法 --interval 在自注册之前就被拒（0/NaN 会让轮询空转）', () => {
  const { home, procRoot } = seedHome();
  try {
    for (const bad of ['0', 'abc', '-5', '50.5']) {
      const r = runCli(['watch', '--session', 'me', '--home', home, '--proc-root', procRoot,
        '--interval', bad, '--max-wait', '300'], { home, procRoot });
      assert.equal(r.status, 1, `--interval ${bad} 应被拒，实际 ${r.status}`);
      assert.match(r.stderr, /interval/, '错误文案要能指向出错的 flag');
    }
    assert.equal(presenceRow(home).watcher_pid, null, '被拒时不能留下 watcher 登记');
  } finally { cleanup(home); }
});

/**
 * R-Q3：`--timeout` 超出引擎上限、或 `--now` 把到期时刻推出安全整数范围时，必须在
 * `setWatcher` **之前**报错退出。写进去的 int64 一旦超过 2^53-1，`setWatcher` 不报错，
 * 但此后任何 SELECT 它的命令（whoami/peers/digest…）都会抛 ERR_OUT_OF_RANGE ⇒ 租约期内
 * 整个窗口连自己的身份都解析不出来。所以断言不止"退出码 1"，还要**presence 行一字未改**。
 */
test('R-Q3：--timeout 上界与安全整数守卫在写库之前拒绝', async () => {
  const { home, procRoot } = seedHome();
  try {
    const before = presenceRow(home);
    for (const args of [
      ['--timeout', '86401'],
      ['--timeout', '9007190000000'],                                   // 评审实测的第二条命令
      ['--timeout', '43200', '--now', '9999999999999999'],              // 评审实测的第三条命令
    ]) {
      // 带上 --max-wait：若守卫失效，命令会真的去阻塞等待，用例以 3≠1 失败而不是挂死
      const r = runCli(['watch', '--session', 'me', '--home', home, '--proc-root', procRoot,
        ...args, '--max-wait', '300'], { home, procRoot });
      assert.equal(r.status, 1, `watch ${args.join(' ')} 应被拒，实际 ${r.status}`);
      assert.match(r.stderr, /timeout|now/, '错误文案要能指向出错的 flag');
      assert.deepEqual(presenceRow(home), before, `被拒时不得改动 presence 行（${args.join(' ')}）`);
    }

    // 上界本身必须还能用：86400 秒（= 引擎的后台任务上限）仍被接受
    const w = startWatch(home, procRoot, ['--timeout', '86400', '--max-wait', '300']);
    try {
      await sleep(200);
      const row = presenceRow(home);
      assert.equal(row.watcher_pid, w.child.pid);
      const left = row.watcher_until - Date.now();
      assert.ok(left > 86_400_000 - 2_000 && left <= 86_400_000, `86400s 应约等于 86400000ms，实际 ${left}`);
      assert.equal(await waitExit(w.child), 3, w.stderr);
    } finally { cleanup(home); }
  } finally { cleanup(home); }
});

// —— M5 / M7：终态的 stdout 与"聋"的三种原因 ——

/**
 * M5：引擎对后台任务的**任何**终态都发完成通知并开新轮，而一次唤醒的固定成本是整个
 * 上下文重读（实测 113k token）。stdout 为空时那次唤醒什么都不带——每个武装窗口每 12h
 * 一次空唤醒，`watch off` 再来一次。所以非命中退出也要有**可判别**的一行。
 *
 * 代价是契约从"空 stdout = 到期"改成"最后一行能否 parse 成带 strong 的对象"，所以两条
 * 用例都要在：命中 ⇒ 最后一行是 JSON；到期/信号 ⇒ 是一行说明、且不带 JSON。
 */
test('M5：到期退出时 stdout 有可判别的说明，不是空', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot, ['--timeout', '1']);
  try {
    assert.equal(await waitExit(w.child, 8000), 0, w.stderr);
    assert.notEqual(w.stdout.trim(), '', '空 stdout 会被引擎当成一次没有内容的完成通知');
    assert.match(w.stdout, /到期/);
    assert.match(w.stdout, /重新武装/);
    assert.equal(w.stdout.includes('"strong"'), false, '这不是命中，不该出现 JSON 行');
  } finally { w.child.kill('SIGKILL'); cleanup(home); }
});

test('M5：信号退出也有话说，且能一眼与"到期"区分', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot);
  try {
    await sleep(250);
    w.child.kill('SIGTERM');
    assert.equal(await waitExit(w.child), 0, w.stderr);
    assert.match(w.stdout, /信号/);
    assert.match(w.stdout, /本轮无消息/);
  } finally { cleanup(home); }
});

/**
 * M7：`'expired'`（超时退出）以前实际不可达——干净超时的 watcher 先 `clearWatcher`，两个
 * 字段一起清掉，于是被报成 `'never'`（"从未武装"）。文案把"时间到了该重新武装"说成
 * "你从来没武装过"，运维方向完全不同（前者是时间到，后者是 skill 没照做）。
 */
test('M7：干净超时退出后状态是「超时退出」，不是「从未武装」', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot, ['--timeout', '1']);
  try {
    assert.equal(await waitExit(w.child, 8000), 0, w.stderr);
    const row = presenceRow(home);
    assert.equal(row.watcher_pid, null, 'watcher_pid 该清');
    assert.ok(row.watcher_until != null && row.watcher_until <= Date.now(),
      `超时退出必须保留过期的 watcher_until，实际 ${JSON.stringify(row)}`);

    const who = JSON.parse(runCli(['whoami', '--session', 'me', '--json', '--home', home], { home, procRoot }).stdout);
    assert.equal(who.deaf, 'expired');
    const peers = JSON.parse(runCli(['peers', '--session', 'me', '--json', '--home', home], { home, procRoot }).stdout);
    const me = peers.peers.find(p => p.sessionId === 'me');
    assert.equal(me.deaf, 'expired', 'peers 里也要能看出是哪种聋（而不是含糊的 never）');
    assert.equal(me.deaf === 'never', false);
  } finally { w.child.kill('SIGKILL'); cleanup(home); }
});

test('M5：--json 模式下非命中退出同样是单行 JSON，且不带 strong', async () => {
  const { home, procRoot } = seedHome();
  const w = startWatch(home, procRoot, ['--timeout', '1', '--json']);
  try {
    assert.equal(await waitExit(w.child, 8000), 0, w.stderr);
    const lines = w.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `--json 下 stdout 必须只有一行，实际 ${lines.length} 行`);
    const payload = JSON.parse(lines[0]);
    assert.equal('strong' in payload, false, '没有命中就不该有 strong，否则调用方会读成一次唤醒');
    assert.equal(payload.reason, 'timeout');
    assert.match(payload.message, /本轮无消息/);
  } finally { w.child.kill('SIGKILL'); cleanup(home); }
});
