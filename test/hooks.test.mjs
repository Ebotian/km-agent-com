import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as identity from '../lib/identity.mjs';
import * as claims from '../lib/claims.mjs';
import * as posts from '../lib/posts.mjs';
import {
  makeTmpHome, cleanup, procRootOf, seedWindow, seedProcEntry, runCli, runHook, runHookAsync,
  runHookInFakeWindow, HOOK,
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

    // **认不出窗口必须留痕。** 这条分支以前是彻底静默的：不开库、不写日志、什么都不剩，
    // 于是"窗口从未登记"这类缺陷在现场可以整轮潜伏（本次这个就是）。
    const entries = JSON.parse(runCli(['log', '--json', '--home', home], { home }).stdout);
    const hit = entries.find(e => e.action === 'session-start-unidentified');
    assert.ok(hit, `审计里应有 session-start-unidentified，实际 ${JSON.stringify(entries.map(e => e.action))}`);
    assert.equal(hit.actor, SESSION);
    assert.match(hit.detail, /self=\d+ ppid=\d+/, '明细要能看出 hook 自己的 pid 与父进程，才可现场自查');
    assert.match(hit.detail, /cwd=\/p\/agent-com/);
  } finally { cleanup(home); }
});

/**
 * **本 bug 的真钉子**：不注入 `AGENT_BUS_TUI_PID`，让 SessionStart 跑真实那条祖先 walk。
 *
 * 为什么以前抓不到：仓库里所有 hook 用例都靠 `AGENT_BUS_TUI_PID` 指定 pid，那条 walk
 * 从来没跑过。而它错在"从传进来的 pid 往上找、把起点那一层跳过去"——只有生产里
 * `/bin/sh -c "单条命令"` 把命令 **exec 掉**之后的那条链（hook 的直接父进程**就是**窗口）
 * 才暴露，表现是窗口**静默**不登记。
 *
 * 两种祖先链形态各跑一次、各用一个临时 home：中间隔着 shell，与 shell 被 exec 掉。断言
 * 两者都写出了 presence 行，且 `tui_pid` 正是那个假窗口——"解出的是我自己所属的窗口"，
 * 不是链上更远的别的窗口。
 */
test('不注入 AGENT_BUS_TUI_PID：真实祖先 walk 认得自己那一层，两种链形态都登记上窗口',
  { skip: process.platform !== 'linux' }, () => {
    for (const [what, cmd] of [
      ['shell 被 exec 掉（生产形态）', `node "${HOOK}"`],
      ['中间隔着 shell（复合命令，sh 不能 exec）', `node "${HOOK}"; :`],
    ]) {
      const home = makeTmpHome();
      try {
        const r = runHookInFakeWindow(event('SessionStart', { session_title: 'T' }), { home, cmd });
        assert.ok(r.windowPid, `${what}: 假窗口没起来（${r.stderr.trim()}）`);
        assert.equal(r.hookStatus, 0, `${what}: hook 退出 ${r.hookStatus}：${r.stderr.trim()}`);

        const db = dbOf(home);
        const n = db.prepare('SELECT COUNT(*) AS c FROM presence').get().c;
        const row = db.prepare('SELECT * FROM presence WHERE tui_pid = ?').get(r.windowPid);
        db.close();
        assert.ok(row, `${what}: 窗口没登记上（presence 有 ${n} 行，没有 pid ${r.windowPid}）`);
        assert.equal(row.session_id, SESSION);
        assert.equal(row.handle, HANDLE, 'handle 由 cwd 推出');
      } finally { cleanup(home); }
    }
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

// —— R-T1 / R-T3：评审裁决的三条加固 ——

/** 给异步用例加一个会**真失败**的上限：挂住就是断言失败，而不是把整个测试文件拖死。 */
function deadline(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { promise.child?.kill('SIGKILL'); } catch { /* 已经退了 */ }
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * R-T1：**判定与文案解耦**。`lease_until` 落在 `(8.64e15, 9.007e15]` 时它仍是 JS 安全
 * 整数——`claims.conflicts` 会正常判出冲突（`lease_until > now` 在 SQL 里是 int64 运算），
 * 但 `new Date(lu).toISOString()` 抛 `RangeError: Invalid time value`。若格式化发生在
 * 决策之前、或被 `main()` 的 fail-open catch 一并吞掉，**已判定的冲突会退化成
 * "exit 0 + 已放行"**，也就是 L0 对这个资源静默失效。
 *
 * 可经 CLI 触达：`bus claim /p/x --now 9000000000000000 --ttl 30m`（租约行真的落库了）。
 */
test('R-T1：租约超出 Date 表示范围时仍然拦截（文案失败不许改判定）', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const resource = '/p/agent-com/lib/db.mjs';
    const db = dbOf(home);
    claims.claim(db, { resource, holderSession: 'other-session', ttlMs: 60_000, now: 8.7e15 });
    const lu = db.prepare('SELECT lease_until AS lu FROM claims WHERE resource = ?').get(resource).lu;
    db.close();
    // 前置：夹具必须真的落在"安全整数但超出 Date 表示范围"那个区间，否则这条用例什么都没测
    assert.ok(Number.isSafeInteger(lu) && lu > 8.64e15, `夹具没造出目标区间: ${lu}`);

    const r = runHook(event('PreToolUse', {
      tool_name: 'Write', tool_input: { file_path: resource },
    }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 2, `已判定的冲突被文案拖成了放行: ${r.stderr}`);
    assert.match(r.stderr, /other-session/, '文案可以降级，但必须点出持有者');
  } finally { cleanup(home); }
});

/**
 * R-T3：stdin 有界读取。契约形态（引擎 pipe）下 20ms 内就 'end'，行为不变；但
 * **hook 自己必须保证不阻塞**——引擎不给 stdin 时不能靠引擎的 timeout=5 兜底。
 */
test('R-T3：stdin 开了却永不送数据也不关闭时，不永远挂住（到点 fail-open）', async () => {
  const home = makeTmpHome();
  try {
    const t0 = Date.now();
    const r = await deadline(runHookAsync(event('PreToolUse', {
      tool_name: 'Write', tool_input: { file_path: '/p/x' },
    }), { home, tuiPid: ME_PID, writeStdin: false, closeStdin: false }),
    6000, 'hook 在 stdin 不关闭时挂住了（有界读取没生效）');
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 0, `空载荷应放行: ${r.stderr}`);
    assert.ok(elapsed < 5000, `有界读取应在 2s 量级收工，实际 ${elapsed}ms`);
  } finally { cleanup(home); }
});

/**
 * R-T3 的另一半：万一引擎改用 pty 投递（载荷送到了，但管道/终端不关），必须**读到载荷**。
 * 用 `isTTY` 快路会把整份载荷静默丢掉 ⇒ PreToolUse 对每次调用都拿到空载荷 ⇒ L0 全灭
 * 且没有任何信号。这条用例钉住"送得到就读得到"。
 */
test('R-T3：载荷送到但管道不关闭时仍能读到并做出判定（pty 形态）', async () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const db = dbOf(home);
    claims.claim(db, {
      resource: '/p/agent-com/data.db', holderSession: 'other-session', ttlMs: 60_000, now: Date.now(),
    });
    db.close();

    const r = await deadline(runHookAsync(event('PreToolUse', {
      tool_name: 'Bash', tool_input: { command: 'sqlite3 /p/agent-com/data.db "select 1"' },
    }), { home, tuiPid: ME_PID, writeStdin: true, closeStdin: false }),
    8000, 'hook 在载荷已送达但管道不关闭时挂住了');
    assert.equal(r.status, 2, `送到的载荷没进 hook: ${r.stderr}`);
    assert.match(r.stderr, /other-session/);
  } finally { cleanup(home); }
});

// —— C1：载荷键名（本轮 Critical）——

/**
 * C1：引擎发给 `PreToolUse` 的载荷里，`Write` / `Edit` 的入参名是 **`path`**，不是 `file_path`。
 * 本轮独立复核拿到两处一手证据：
 *
 * 1. 引擎源码：`packages/agent-core-v2/src/agent/tools/os/write/write.ts` 里
 *    `WriteInputSchema = z.object({ path: z.string()…, content: … })`，`.../edit/edit.ts` 的
 *    `EditInputSchema` 同名；而 `agentExternalHooksService.ts` 的 `runPreToolUse` 把工具调用
 *    的 `args` **原样**塞进载荷（`toolInput: isPlainRecord(ctx.args) ? ctx.args : {}`），
 *    `matchHooks.toHookInputData` 只把**顶层**键名 camel→snake（`toolInput` → `tool_input`）。
 * 2. 本机真实会话的 `wire.jsonl`：`Write` 调用的 args 键是 `["content","path"]`、`Edit` 是
 *    `["new_string","old_string","path"]`；扫过 46 个 wire.jsonl、321 次 Edit、124 次 Write，
 *    **没有一处** `file_path`（打包产物里那 15 处 `file_path` 全在 UI 的局部预览回退链里）。
 *
 * 只认 `file_path` 的后果：文档里写的那个键一律放行，`Write`/`Edit` 上 L0 **静默关闭**。
 */
test('C1：PreToolUse 用引擎真实载荷形状（tool_input.path）拦得住', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const resource = '/p/agent-com/lib/db.mjs';
    const db = dbOf(home);
    claims.claim(db, { resource, holderSession: 'other-session', ttlMs: 60_000, now: Date.now() });
    db.close();

    for (const tool of ['Write', 'Edit']) {
      const r = runHook(event('PreToolUse', {
        tool_name: tool, tool_input: { path: resource },
      }), { home, tuiPid: ME_PID });
      assert.equal(r.status, 2,
        `${tool} 的 path 载荷必须拦下（这正是引擎发的形状），实际退出 ${r.status}；stderr=${r.stderr.trim()}`);
      assert.match(r.stderr, /other-session/);
    }
  } finally { cleanup(home); }
});

test('C1：旧键 file_path / file_paths 仍被接受（只为兼容，不是主路径）', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const resource = '/p/agent-com/lib/db.mjs';
    const db = dbOf(home);
    claims.claim(db, { resource, holderSession: 'other-session', ttlMs: 60_000, now: Date.now() });
    db.close();

    assert.equal(runHook(event('PreToolUse', {
      tool_name: 'Write', tool_input: { file_path: resource },
    }), { home, tuiPid: ME_PID }).status, 2);
    assert.equal(runHook(event('PreToolUse', {
      tool_name: 'Write', tool_input: { file_paths: [resource] },
    }), { home, tuiPid: ME_PID }).status, 2);
  } finally { cleanup(home); }
});

/**
 * C1 的另一半：抠不出路径时**必须留下审计**。以前这里是 `return 0` 且连库都不开——一次
 * "我们一点都没看懂"的调用在现场什么都不剩，所以"载荷键名对不上"这类缺陷能整轮潜伏。
 */
test('C1：抠不出路径时留一行审计（不再无痕放行）', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const r = runHook(event('PreToolUse', {
      tool_name: 'Bash', tool_input: { command: 'git status --short' },
    }), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');

    const log = runCli(['log', '--json', '--session', SESSION, '--home', home], { home });
    assert.equal(log.status, 0, log.stderr);
    const entries = JSON.parse(log.stdout);
    const hit = entries.find(e => e.action === 'pretooluse-no-path');
    assert.ok(hit, `审计里应有 pretooluse-no-path，实际 ${JSON.stringify(entries.map(e => e.action))}`);
    assert.equal(hit.actor, SESSION);
    assert.match(hit.detail, /git status/, '明细要能看出这次调用长什么样');
  } finally { cleanup(home); }
});

// —— I1：路径归一化（两侧都 resolve）——

/**
 * I1：`payload.cwd` 是引擎保证会给的公共字段，而 `lib/claims.mjs` 的 `conflicts` 是**精确
 * 字符串比较**——所以相对路径、`./x`、`/p/x/./y`、`/p//x/y` 这些写法必须在**传入之前**归一化，
 * 两侧用同一个基准（本窗口 cwd）。以前它们全部放行：文档承诺"L0 拦得住"，而实际只在
 * "绝对路径、且写法完全一致"时才拦得住。
 */
test('I1：相对路径按 payload.cwd 归一化后仍然拦得住（Write / Edit / Bash）', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const db = dbOf(home);
    claims.claim(db, {
      resource: '/p/agent-com/lib/db.mjs', holderSession: 'other-session', ttlMs: 60_000, now: Date.now(),
    });
    db.close();

    const cases = [
      ['Write', { path: 'lib/db.mjs' }],
      ['Edit', { path: './lib/db.mjs' }],
      ['Write', { file_path: 'lib/db.mjs' }],
      ['Bash', { command: 'sed -i s/a/b/ lib/db.mjs' }],
      ['Bash', { command: 'echo x > lib/db.mjs' }],
      ['Bash', { command: 'echo x >>lib/db.mjs' }],
      ['Bash', { command: 'cat <lib/db.mjs' }],
      ['Bash', { command: 'echo x 2>>/p/agent-com/lib/db.mjs' }],
      ['Write', { path: '/p/agent-com/./lib/db.mjs' }],
      ['Write', { path: '/p/agent-com//lib/db.mjs' }],
    ];
    for (const [tool, tool_input] of cases) {
      const r = runHook(event('PreToolUse', { tool_name: tool, tool_input }), { home, tuiPid: ME_PID });
      assert.equal(r.status, 2,
        `${tool} ${JSON.stringify(tool_input)} 应被拦下，实际退出 ${r.status}`);
    }
  } finally { cleanup(home); }
});

test('I1：没有 cwd 时不猜相对路径（放行），绝对路径照旧拦得住', () => {
  const home = makeTmpHome();
  try {
    seedMe(home);
    const resource = '/p/agent-com/lib/db.mjs';
    const db = dbOf(home);
    claims.claim(db, { resource, holderSession: 'other-session', ttlMs: 60_000, now: Date.now() });
    db.close();

    const noCwd = { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Write', tool_input: { path: 'lib/db.mjs' } };
    assert.equal(runHook(noCwd, { home, tuiPid: ME_PID }).status, 0,
      '没有 cwd 时宁可放行，也不能拿 hook 自己的 cwd 猜出一条永远不会撞上的路径');
    assert.equal(runHook({ ...noCwd, cwd: CWD, tool_input: { path: resource } }, { home, tuiPid: ME_PID }).status, 2);
  } finally { cleanup(home); }
});

// —— I4：弱投递的内容必须真的到达 ——

/**
 * I4：弱投递（订阅命中、非点名）以前只出一句"另有 N 条"，**同时**把游标推过它们——三条
 * 广播的标题从未进过上下文，也再没有机会进来（游标已越过，永远排不出来）。L3 承诺的是
 * "静默积压，等下次交互排空"，而"排空"的前提是内容真的投出去。
 */
test('I4：弱投递的标题确实到达接收方，且游标与投递一致', () => {
  const home = makeTmpHome();
  try {
    // 必须真的订阅了主题：弱投递的全部来源就是"命中我订阅的前缀"
    seedMe(home, { subscribes: [HANDLE] });
    const db = dbOf(home);
    for (const title of ['广播一', '广播二', '广播三']) {
      posts.createPost(db, {
        topic: HANDLE, authorSession: 'other', authorCwd: '/p/other',
        origin: 'agent', kind: 'finding', title, now: Date.now(),
      });
    }
    db.close();

    const r = runHook(event('UserPromptSubmit'), { home, tuiPid: ME_PID });
    assert.equal(r.status, 0, r.stderr);
    for (const title of ['广播一', '广播二', '广播三']) {
      assert.match(r.stdout, new RegExp(title), `弱帖「${title}」的标题必须进上下文`);
    }
    assert.match(r.stdout, /1 条|3 条/);

    const db2 = dbOf(home);
    assert.equal(posts.poll(db2, { reader: SESSION }).total, 0, '投出去之后游标才该推到位');
    db2.close();
  } finally { cleanup(home); }
});
