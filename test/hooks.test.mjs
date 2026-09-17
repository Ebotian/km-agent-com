import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as identity from '../lib/identity.mjs';
import * as claims from '../lib/claims.mjs';
import * as posts from '../lib/posts.mjs';
import {
  makeTmpHome, cleanup, procRootOf, seedWindow, seedProcEntry, runHook, runHookAsync,
} from './helpers.mjs';

const SESSION = 'session_aaaa-bbbb';
const ME_PID = 100;
const CWD = '/p/agent-com';
const HANDLE = 'agent-com';

function event(name, extra = {}) {
  return { hook_event_name: name, session_id: SESSION, cwd: CWD, ...extra };
}

function dbOf(home) {
  return openDb(join(home, 'agent-bus', 'bus.db'));
}

/**
 * 本窗口（pid 100 / 假 /proc 里是 kimi-code）的成对夹具。
 * 成对是硬要求：hook 的 SessionStart 会调 `identity.reapDead`，只写 presence 不写假 /proc
 * 的话，这一行会在被测 hook 启动后的那一次清扫里被当场清掉。
 */
function seedMe(home, extra = {}) {
  return seedWindow(home, {
    pid: ME_PID, sessionId: SESSION, sessionTitle: 'T', cwd: CWD, handle: HANDLE, ...extra,
  });
}

test('SessionStart 登记 presence 并种下默认订阅', () => {
  const home = makeTmpHome();
  try {
    // 同一窗口在 /new 之前的旧行先摆着：它带着 handle，正是"两步流程会把自己当成别人"的那种行
    seedWindow(home, {
      pid: ME_PID, sessionId: 'session_old', sessionTitle: '旧', cwd: CWD, handle: HANDLE,
    });
    const r = runHook(event('SessionStart', { session_title: 'T' }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);

    const db = dbOf(home);
    const rows = db.prepare('SELECT * FROM presence').all();
    assert.equal(rows.length, 1, '同一 tui_pid 只应有一行');
    assert.equal(rows[0].session_id, SESSION, '新会话应覆盖旧会话');
    assert.equal(rows[0].session_title, 'T');
    // R-H2：同一窗口重复开窗时 handle 必须稳住，不许 agent-com → agent-com-2 抖动
    assert.equal(rows[0].handle, HANDLE);
    assert.deepEqual(posts.listSubscriptions(db, { reader: SESSION }), [HANDLE]);
    db.close();
  } finally { cleanup(home); }
});

test('SessionStart 重复触发不产生重复 presence，且重置 watcher 登记', () => {
  const home = makeTmpHome();
  try {
    // 旧会话 + 一个健康 watcher（假 /proc 里有对应的 bus-watch 条目）
    seedMe(home, { sessionId: 'session_old', watcherPid: 555 });
    assert.equal(runHook(event('SessionStart', { session_title: 'T' }), { home, tuiPid: ME_PID }).status, 0);

    const db = dbOf(home);
    assert.equal(db.prepare('SELECT watcher_pid FROM presence WHERE tui_pid = ?').get(ME_PID).watcher_pid, null,
      'SessionStart 必须清掉旧 watcher 登记（新会话还没武装）');
    identity.setWatcher(db, { tuiPid: ME_PID, watcherPid: 555, watcherUntil: 9e15 });
    db.close();

    const r = runHook(event('SessionStart', { session_title: 'T' }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);

    const db2 = dbOf(home);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM presence').get().c, 1);
    const row = db2.prepare('SELECT * FROM presence WHERE tui_pid = ?').get(ME_PID);
    assert.equal(row.session_id, SESSION);
    assert.equal(row.handle, HANDLE, 'R-H2：重复开窗不许抖动 handle');
    assert.equal(row.watcher_pid, null);
    db2.close();
  } finally { cleanup(home); }
});

test('SessionEnd 删除 presence、回收未完结租约，且已完结的任务不复活', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const now = Date.now();
    const db = dbOf(home);
    const { seq } = posts.createPost(db, {
      topic: HANDLE, authorSession: 'other', authorCwd: '/p/other',
      origin: 'agent', kind: 'request', toSession: SESSION, title: '一次性任务', now,
    });
    const task = `task:${seq}`;
    claims.claim(db, { resource: task, holderSession: SESSION, ttlMs: 60000, now });
    claims.complete(db, { resource: task, holderSession: SESSION, now });
    claims.claim(db, { resource: '/p/a', holderSession: SESSION, ttlMs: 60000, now });
    claims.claim(db, { resource: '/p/b', holderSession: 'someone-else', ttlMs: 60000, now });
    // 前置断言：任务此刻确实"已完结"，否则下面那两条会退化成空断言
    assert.equal(posts.openTasks(db, { now }).length, 0, '前置：任务已完结');
    db.close();

    const r = runHook(event('SessionEnd'), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);

    const db2 = dbOf(home);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM presence').get().c, 0);
    const left = db2.prepare('SELECT resource FROM claims ORDER BY resource').all().map(x => x.resource);
    // R-E4：只回收**未完结**的租约——`DELETE ... WHERE holder_session = ?` 会把已完结的
    // task 行一并删掉，于是已做完的一次性任务复活、变回可认领。
    assert.deepEqual(left, ['/p/b', task], '只回收自己的未完结租约；已完结的 task 行必须留下');
    // 三条断言各自独立：先看行还在不在、再看它有没有回到开放队列、最后才是能不能被认领
    // ——"重新认领"会自己把行插回去，放在最后才不至于把前两条遮住。
    assert.equal(posts.openTasks(db2, { now: now + 1 }).length, 0, '已完结的任务不得回到开放队列');
    const again = claims.claim(db2, { resource: task, holderSession: 'someone-else', ttlMs: 60000, now: now + 1 });
    assert.equal(again.claimed, false, '已完结的一次性任务不得被重新认领');
    db2.close();
  } finally { cleanup(home); }
});

test('PreToolUse 对未被占用的文件放行（退出 0）', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const r = runHook(event('PreToolUse', {
      tool_name: 'Write', tool_input: { file_path: '/p/agent-com/lib/db.mjs' },
    }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', '拦截路径不该往上下文里注入任何东西');
  } finally { cleanup(home); }
});

test('PreToolUse 拦住他人持有的文件（退出 2 并说明持有者）', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const db = dbOf(home);
    claims.claim(db, {
      resource: '/p/agent-com/lib/db.mjs', holderSession: 'other-session',
      ttlMs: 60000, now: Date.now(),
    });
    db.close();
    const r = runHook(event('PreToolUse', {
      tool_name: 'Edit', tool_input: { file_path: '/p/agent-com/lib/db.mjs' },
    }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /other-session/);
  } finally { cleanup(home); }
});

test('PreToolUse 放行自己持有的文件', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const db = dbOf(home);
    claims.claim(db, {
      resource: '/p/agent-com/lib/db.mjs', holderSession: SESSION, ttlMs: 60000, now: Date.now(),
    });
    db.close();
    const r = runHook(event('PreToolUse', {
      tool_name: 'Write', tool_input: { file_path: '/p/agent-com/lib/db.mjs' },
    }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(home); }
});

test('PreToolUse 从 Bash 命令里抠出绝对路径', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const db = dbOf(home);
    claims.claim(db, {
      resource: '/p/agent-com/data.db', holderSession: 'other-session', ttlMs: 60000, now: Date.now(),
    });
    db.close();
    const r = runHook(event('PreToolUse', {
      tool_name: 'Bash', tool_input: { command: 'sqlite3 /p/agent-com/data.db "select 1"' },
    }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 2);
  } finally { cleanup(home); }
});

test('载荷畸形时 fail-open 放行', () => {
  const home = makeTmpHome();
  try {
    const r = runHook({ hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Write' },
      { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(home); }
});

test('stdin 不是 JSON 时 fail-open 放行', () => {
  const home = makeTmpHome();
  try {
    const r = runHook('这不是 JSON', { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(home); }
});

test('UserPromptSubmit 注入未读摘要', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const db = dbOf(home);
    posts.createPost(db, {
      topic: HANDLE, authorSession: 'other', authorCwd: '/p/other',
      origin: 'agent', kind: 'request', toSession: SESSION, title: '帮忙跑测试', now: Date.now(),
    });
    db.close();

    const r = runHook(event('UserPromptSubmit'), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /#1/);
    assert.match(r.stdout, /帮忙跑测试/);

    const db2 = dbOf(home);
    assert.equal(posts.poll(db2, { reader: SESSION }).total, 0, '注入后应推进游标');
    db2.close();
  } finally { cleanup(home); }
});

test('UserPromptSubmit 在 watcher 已死时提示重新武装', () => {
  const home = makeTmpHome();
  try {
    seedMe(home, { watcherPid: 555 });
    const db = dbOf(home);
    assert.equal(
      identity.listPresence(db, { procRoot: procRootOf(home) }).find(p => p.sessionId === SESSION).deaf, null,
      '前置：夹具先要真的是在听',
    );
    // 把 watcher_pid 指到一个不存在的进程
    identity.setWatcher(db, { tuiPid: ME_PID, watcherPid: 2147483, watcherUntil: 9e15 });
    db.close();

    const r = runHook(event('UserPromptSubmit'), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /已死/, '要说清是"死了"而不是"从未武装"');
    assert.match(r.stdout, /重新武装/);
  } finally { cleanup(home); }
});

test('UserPromptSubmit 在本窗口没有 presence 行时按"从未武装"提示', () => {
  const home = makeTmpHome();
  try {
    const r = runHook(event('UserPromptSubmit'), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /从未武装/);
    assert.match(r.stdout, /重新武装/);
  } finally { cleanup(home); }
});

/**
 * R5：夹具必须真的健康——armed watcher 的 pid 要能在**假 /proc** 里查到 bus-watch。
 * 没有它，`deaf` 是 'never'，实现会"正确地"提示从未武装 ⇒ stdout 非空 ⇒ 这条用例必挂；
 * 而用例的意图恰恰是"未武装就该提醒"，所以挂的原因不在实现。
 */
test('UserPromptSubmit 在健康时保持沉默', () => {
  const home = makeTmpHome();
  try {
    seedMe(home, { watcherPid: 555, watcherUntil: Date.now() + 3_600_000 });
    const db = dbOf(home);
    const peer = identity.listPresence(db, { procRoot: procRootOf(home) }).find(p => p.sessionId === SESSION);
    assert.equal(peer.deaf, null, '夹具没武装出健康 watcher，本用例就不是在测"健康"');
    db.close();

    const r = runHook(event('UserPromptSubmit'), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', '健康且无未读时不该往上下文里塞任何东西');
  } finally { cleanup(home); }
});

test('未知事件名不报错（退出 0、无输出）', () => {
  const home = makeTmpHome();
  try {
    const r = runHook({ hook_event_name: 'PostToolUse', session_id: SESSION, cwd: CWD }, { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  } finally { cleanup(home); }
});

test('SessionStart 认不出自己的窗口时不写 presence（退出 0）', () => {
  const home = makeTmpHome();
  try {
    // 不给 AGENT_BUS_TUI_PID，假 /proc 里也没有祖先链 ⇒ 祖先遍历必然落空
    const r = runHook(event('SessionStart', { session_title: 'T' }), { home });
    assert.equal(r.status, 0, r.stderr);
    const db = dbOf(home);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM presence').get().c, 0, '认不出窗口就不该留下没人能回收的行');
    db.close();
  } finally { cleanup(home); }
});

/**
 * R-H2：`handleFromCwd` + `upsertPresence` 两步之间有读-写间隙，并发开窗会同 cwd 撞名
 * （复审实测 8 并发窗口 6/6 撞名，8 行只剩 2 个不同 handle）。`registerPresence` 把算
 * handle 与写 presence 收进同一个 BEGIN IMMEDIATE，这里用真并发钉住它。
 */
test('R-H2：并发 SessionStart 同 cwd 各自拿到互不相同的 handle', async () => {
  const home = makeTmpHome();
  try {
    const procRoot = procRootOf(home);
    const pids = [100, 101, 102, 103, 104, 105, 106, 107];
    // 只种 /proc 那一半：presence 必须由被测 hook 自己写出来
    for (const pid of pids) seedProcEntry(procRoot, { pid });
    const rs = await Promise.all(pids.map(pid => runHookAsync({
      hook_event_name: 'SessionStart', session_id: `session_${pid}`, cwd: CWD, session_title: 'T',
    }, { home, tuiPid: pid })));
    assert.ok(rs.every(r => r.status === 0), rs.map(r => r.stderr).join('|'));

    const db = dbOf(home);
    const rows = db.prepare('SELECT tui_pid, handle FROM presence ORDER BY tui_pid').all();
    db.close();
    assert.equal(rows.length, pids.length, `有窗口没登记上: ${JSON.stringify(rows)}`);
    assert.equal(new Set(rows.map(r => r.handle)).size, pids.length,
      `handle 撞名: ${rows.map(r => r.handle).join(', ')}`);
  } finally { cleanup(home); }
});

/**
 * 注：brief 的字面夹具是 `home: '/proc/definitely-not-writable'`。**在这台机器上它会挂死**：
 * `openDb` 里的 `mkdirSync(..., { recursive: true })` 只要落在 /proc 下就永不返回
 * （`/proc/xyz-abc`、`/proc/self/x` 实测同样挂死，单独 5s 超时都能复现），整条用例于是以
 * 300s 超时收场，症状离现场很远。改用"home 位置上是个普通文件"：ENOTDIR 立即抛出，
 * 且在 root 下同样抛（不受权限位影响）。
 */
test('home 不可写时也 fail-open（PreToolUse 不做判断即放行）', () => {
  const home = makeTmpHome();
  try {
    const notADir = join(home, 'not-a-dir');
    writeFileSync(notADir, 'x');
    const r = runHook({
      hook_event_name: 'PreToolUse', session_id: SESSION, cwd: CWD,
      tool_name: 'Write', tool_input: { file_path: '/p/x' },
    }, { home: notADir, tuiPid: ME_PID });
    assert.equal(r.status, 0, '总线挂了不能卡死工具调用');
    assert.match(r.stderr, /已放行/);
  } finally { cleanup(home); }
});

test('数据库损坏时也 fail-open（并留下可自查的 stderr）', () => {
  const home = makeTmpHome();
  try {
    mkdirSync(join(home, 'agent-bus'), { recursive: true });
    writeFileSync(join(home, 'agent-bus', 'bus.db'), '这不是一个 SQLite 数据库');
    const r = runHook({
      hook_event_name: 'PreToolUse', session_id: SESSION, cwd: CWD,
      tool_name: 'Write', tool_input: { file_path: '/p/x' },
    }, { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, '总线挂了不能卡死工具调用');
    assert.match(r.stderr, /已放行/, '失败必须留下痕迹，否则现场只剩"放行"');
  } finally { cleanup(home); }
});
