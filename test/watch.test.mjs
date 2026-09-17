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
    const code = await waitExit(w.child);
    assert.equal(code, 3, w.stderr);
    assert.equal(presenceRow(home).watcher_pid, null);
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
