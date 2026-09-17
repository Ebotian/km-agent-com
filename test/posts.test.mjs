import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as posts from '../lib/posts.mjs';
import { claim, complete } from '../lib/claims.mjs';
import { makeTmpHome, cleanup } from './helpers.mjs';

function withDb(fn) {
  const home = makeTmpHome();
  try { return fn(openDb(join(home, 'bus.db'))); } finally { cleanup(home); }
}

const base = { authorSession: 'sA', authorCwd: '/p/a', origin: 'agent', kind: 'finding', now: 1 };

function seed(db, over = {}) {
  return posts.createPost(db, { ...base, topic: 'agent-com', title: 'T', ...over });
}

test('createPost 分配自增 seq 并回读一致', () => {
  withDb(db => {
    const a = seed(db, { title: 'first' });
    const b = seed(db, { title: 'second' });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    const p = posts.getPost(db, { seq: 1 });
    assert.equal(p.title, 'first');
    assert.equal(p.topic, 'agent-com');
    assert.equal(p.toSession, null);
    assert.equal(p.replyTo, null);
  });
});

test('createPost 拒绝非法 kind 与 origin（CHECK 约束生效）', () => {
  withDb(db => {
    assert.throws(() => seed(db, { kind: 'status' }));
    assert.throws(() => seed(db, { origin: 'system' }));
  });
});

test('poll 只回投递给我的：命中订阅前缀', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { topic: 'agent-com', title: 'yes' });
    seed(db, { topic: 'agent-com/build', title: 'yes-subtree' });
    seed(db, { topic: 'agent-comx', title: 'no-sibling' });
    seed(db, { topic: 'other', title: 'no' });
    const r = posts.poll(db, { reader: 'me' });
    assert.deepEqual(r.weak.map(p => p.title), ['yes', 'yes-subtree']);
    assert.equal(r.total, 2);
  });
});

test('poll 的前缀匹配不吃 LIKE 通配符（_ 不当通配）', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'a_b' });
    seed(db, { topic: 'a_b', title: 'exact' });
    seed(db, { topic: 'axb', title: 'must-not-match' });
    const r = posts.poll(db, { reader: 'me' });
    assert.deepEqual(r.weak.map(p => p.title), ['exact']);
  });
});

test('poll 把点名给我的归入 strong，其余归入 weak', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { topic: 'agent-com', title: 'broadcast' });
    seed(db, { topic: 'agent-com', title: 'direct', toSession: 'me' });
    const r = posts.poll(db, { reader: 'me' });
    assert.deepEqual(r.strong.map(p => p.title), ['direct']);
    assert.deepEqual(r.weak.map(p => p.title), ['broadcast']);
    assert.equal(r.total, 2);
  });
});

test('poll 是只读的，ack 才推进游标', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { title: 'one' });
    assert.equal(posts.getCursor(db, { reader: 'me' }), 0);
    const r1 = posts.poll(db, { reader: 'me' });
    assert.equal(r1.total, 1);
    assert.equal(posts.getCursor(db, { reader: 'me' }), 0, 'poll 不得移动游标');
    posts.ack(db, { reader: 'me', seq: r1.nextCursor });
    assert.equal(posts.getCursor(db, { reader: 'me' }), 1);
    assert.equal(posts.poll(db, { reader: 'me' }).total, 0);
  });
});

test('ack 不会让游标倒退', () => {
  withDb(db => {
    posts.ack(db, { reader: 'me', seq: 10 });
    posts.ack(db, { reader: 'me', seq: 3 });
    assert.equal(posts.getCursor(db, { reader: 'me' }), 10);
  });
});

test('listTopics 统计条数与最近时间', () => {
  withDb(db => {
    seed(db, { topic: 'agent-com', title: 'a', now: 1 });
    seed(db, { topic: 'agent-com', title: 'b', now: 5 });
    seed(db, { topic: 'general', title: 'c', now: 2 });
    const t = posts.listTopics(db);
    assert.deepEqual(t, [
      { topic: 'agent-com', count: 2, lastTs: 5 },
      { topic: 'general', count: 1, lastTs: 2 },
    ]);
  });
});

test('search 按 title/body 子串匹配且分大小写不敏感', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { title: 'Build Failed', body: '详见 lib/db.mjs:88' });
    seed(db, { title: '无关' });
    assert.deepEqual(posts.search(db, { reader: 'me', text: 'build' }).map(p => p.title), ['Build Failed']);
    assert.deepEqual(posts.search(db, { reader: 'me', text: 'lib/db' }).map(p => p.title), ['Build Failed']);
    assert.deepEqual(posts.search(db, { reader: 'me', text: 'nothing' }), []);
  });
});

test('subscribe 幂等，unsubscribe 返回是否真的删掉了', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    assert.deepEqual(posts.listSubscriptions(db, { reader: 'me' }), ['agent-com']);
    assert.equal(posts.unsubscribe(db, { reader: 'me', pattern: 'agent-com' }), true);
    assert.equal(posts.unsubscribe(db, { reader: 'me', pattern: 'agent-com' }), false);
  });
});

test('openTasks 列出未被活跃认领且未完成的 request', () => {
  withDb(db => {
    const t1 = posts.createPost(db, { ...base, topic: 'agent-com', kind: 'request', title: 'work1' });
    const t2 = posts.createPost(db, { ...base, topic: 'agent-com', kind: 'request', title: 'work2' });
    posts.createPost(db, { ...base, topic: 'agent-com', kind: 'finding', title: 'not-a-task' });
    claim(db, { resource: `task:${t1.seq}`, holderSession: 'sB', ttlMs: 60000, now: 1000 });
    claim(db, { resource: `task:${t2.seq}`, holderSession: 'sB', ttlMs: 60000, now: 1000 });
    complete(db, { resource: `task:${t2.seq}`, holderSession: 'sB', now: 1001 });

    // now=2000 时 work1 的租约（1000+60000=61000）仍然活跃 ⇒ 不在开放列表；
    // work2 已完成 ⇒ 也不在。因此期望是空列表 —— 这正是"被活跃认领的
    // 那条不开放"的语义；finding 帖不进列表由这两次断言一并覆盖。
    const open = posts.openTasks(db, { now: 2000 });
    assert.deepEqual(open.map(o => o.post.title), []);
    assert.deepEqual(open.map(o => o.post.title).filter(t => t === 'work1'), [],
      '被活跃认领的 work1 不在开放列表');

    const afterExpiry = posts.openTasks(db, { now: 999999 });
    assert.deepEqual(afterExpiry.map(o => o.post.title), ['work1']);
    assert.equal(afterExpiry[0].claim.holder, 'sB');
    assert.equal(afterExpiry[0].claim.leaseUntil, 61000);
    assert.equal(afterExpiry[0].claim.completed, false);
  });
});

test('getPost/poll/search/listTopics 的出口都是普通对象', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { title: 'broadcast' });
    seed(db, { title: 'direct', toSession: 'me' });
    const r = posts.poll(db, { reader: 'me' });
    const outs = [
      ['getPost', posts.getPost(db, { seq: 1 })],
      ['poll.strong[0]', r.strong[0]],
      ['poll.weak[0]', r.weak[0]],
      ['search[0]', posts.search(db, { reader: 'me', text: 'broadcast' })[0]],
      ['listTopics[0]', posts.listTopics(db)[0]],
    ];
    for (const [name, row] of outs) {
      assert.ok(Object.getPrototypeOf(row) !== null, `${name} 不得是 null-prototype 行对象`);
      assert.deepEqual(row, { ...row }, `${name} 必须是普通对象`);
    }
  });
});

// —— I4：弱投递的条数上限不能吞消息 ——

/**
 * I4：弱投递以前只报"另有 N 条"、**同时**把游标推过它们，于是那几条的标题永远进不了上下文。
 * 现在弱帖出 triage 行，但有条数上限（`WEAK_MAX`）；被上限截掉的部分**绝不能推进游标**，
 * 否则同一个缺陷换一种写法又回来了。
 */
test('poll：弱投递被上限截掉时不推进游标，下一轮继续投', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    for (let i = 1; i <= posts.WEAK_MAX + 2; i++) seed(db, { title: `w${i}` });
    const r = posts.poll(db, { reader: 'me' });
    assert.equal(r.weak.length, posts.WEAK_MAX);
    assert.equal(r.weakHidden, 2);
    // nextCursor 的语义是"**已投递**行里的最大 seq"，不再是"整批的末尾"：被上限截掉的
    // #11/#12 这一轮并没有投出去，把游标当成整批末尾来推就是那个静默丢失（推进游标请一律
    // 用 ackUpTo）。改动见 backlog-fix-report.md。
    assert.equal(r.nextCursor, posts.WEAK_MAX, 'nextCursor 是已投递行的最大 seq');
    assert.equal(r.ackUpTo, posts.WEAK_MAX, '游标只该推到确实投出去的最后一条');
    posts.ack(db, { reader: 'me', seq: r.ackUpTo });
    const r2 = posts.poll(db, { reader: 'me' });
    assert.deepEqual(r2.weak.map(p => p.title), [`w${posts.WEAK_MAX + 1}`, `w${posts.WEAK_MAX + 2}`],
      '被截掉的那几条必须能在下一轮投出去');
  });
});

test('poll：整批都投出去时 ackUpTo 就是最后一条', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { title: 'a' });
    seed(db, { title: 'b', toSession: 'me' });
    seed(db, { title: 'c' });
    const r = posts.poll(db, { reader: 'me' });
    assert.equal(r.weakHidden, 0);
    assert.equal(r.ackUpTo, r.nextCursor);
    posts.ack(db, { reader: 'me', seq: r.ackUpTo });
    assert.equal(posts.poll(db, { reader: 'me' }).total, 0);
  });
});

test('poll：点名帖永远不被上限截掉（它必须在同一轮里被投出去）', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    for (let i = 1; i <= posts.WEAK_MAX + 3; i++) seed(db, { title: `w${i}` });
    seed(db, { title: 'direct', toSession: 'me' });
    const r = posts.poll(db, { reader: 'me' });
    assert.deepEqual(r.strong.map(p => p.title), ['direct']);
    assert.equal(r.weakHidden, 3);
    assert.equal(r.ackUpTo, posts.WEAK_MAX, '被截掉的是弱帖；游标不越过它们');
  });
});

// —— I6：弱帖洪水把点名帖挤出投递批次（控制方实测：前面堆 50/200/500 条弱帖时，那条 `@`
// 根本没被取出来，watcher 空等到 --max-wait）——

/**
 * I6：以前 strong 与 weak 共享同一个 `LIMIT 50` 批次窗口，于是"游标之后的前 50 条全是弱帖"
 * 时点名帖**根本没被取出来**，`strong` 是空数组——而 watcher 的退出判据正是
 * `strong.length > 0`。这条 `@` 还不会自愈：watcher 不推进游标，空闲窗口也没有别的东西推
 * 它，每轮 digest 只投 `WEAK_MAX` 条弱帖，200 条弱帖要 17 轮对话才排得到。
 *
 * 三种规模都必须把点名帖投出去，且弱帖那一路的上限、积压计数、游标不变量一条不动。
 */
test('I6：前面堆 50/200/500 条弱帖，点名帖仍必须被投出去', () => {
  for (const n of [50, 200, 500]) {
    withDb(db => {
      posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
      for (let i = 1; i <= n; i++) seed(db, { title: `w${i}` });
      const direct = seed(db, { title: 'direct', toSession: 'me' });
      assert.equal(direct.seq, n + 1, '夹具：点名帖排在弱帖洪水之后');
      const r = posts.poll(db, { reader: 'me' });
      assert.deepEqual(r.strong.map(p => p.seq), [direct.seq],
        `前面 ${n} 条弱帖时，点名帖 #${direct.seq} 也必须被取出来（它是 watcher 唯一看得懂的信号）`);
      assert.equal(r.weak.length, posts.WEAK_MAX, `n=${n}：弱帖上限照旧`);
      assert.equal(r.weakHidden, n - posts.WEAK_MAX, `n=${n}：积压计数必须是精确值`);
      assert.equal(r.ackUpTo, posts.WEAK_MAX, `n=${n}：游标不越过被截掉的弱帖`);
      assert.ok(r.total > 0);
    });
  }
});

test('poll：strong 溢出时不推进游标，下一轮继续投', () => {
  withDb(db => {
    for (let i = 1; i <= posts.STRONG_MAX + 5; i++) seed(db, { title: `d${i}`, toSession: 'me' });
    const r = posts.poll(db, { reader: 'me' });
    assert.equal(r.strong.length, posts.STRONG_MAX);
    assert.equal(r.strongHidden, 5);
    assert.equal(r.weakHidden, 0);
    assert.equal(r.ackUpTo, posts.STRONG_MAX, '第 STRONG_MAX+1 条 strong 还没投出去，游标不许推过它');
    posts.ack(db, { reader: 'me', seq: r.ackUpTo });
    const r2 = posts.poll(db, { reader: 'me' });
    assert.equal(r2.strong[0].seq, posts.STRONG_MAX + 1, '被截掉的 strong 必须能在下一轮投出去');
    assert.equal(r2.strong.length, 5);
  });
});

test('poll：两轴同时溢出时，游标只推到更早的那条未投递行之前', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    for (let i = 1; i <= posts.WEAK_MAX + 5; i++) seed(db, { title: `w${i}` });
    for (let i = 1; i <= posts.STRONG_MAX + 5; i++) seed(db, { title: `d${i}`, toSession: 'me' });
    const r = posts.poll(db, { reader: 'me' });
    assert.equal(r.weak.length, posts.WEAK_MAX);
    assert.equal(r.strong.length, posts.STRONG_MAX);
    assert.equal(r.weakHidden, 5);
    assert.equal(r.strongHidden, 5);
    // 两轴的"下一条未投递"分别是 #11（weak）与 #66（strong）：取更早的那个减一
    assert.equal(r.ackUpTo, posts.WEAK_MAX);
  });
});

/**
 * 两轴不重不漏：spec §6.3 的谓词是「点名给我 **或** 命中我订阅的前缀」，所以点名给**别人**
 * 的帖子命中我订阅时照样投给我（重构前也是这么投的）。若弱帖那条查询写成 `to_session IS
 * NULL`，这些帖子会从两条查询的缝里掉出去——又一个"在库里、投递路径看不见"的静默丢失。
 */
test('poll：点名给别人的帖子仍按订阅投给我', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { title: 'to-other', toSession: 'other' });
    seed(db, { title: 'to-me', toSession: 'me' });
    seed(db, { title: 'broadcast' });
    const r = posts.poll(db, { reader: 'me' });
    assert.deepEqual(r.strong.map(p => p.title), ['to-me']);
    assert.deepEqual(r.weak.map(p => p.title), ['to-other', 'broadcast']);
  });
});

/**
 * `poll` 的两个上限以前是**唯一没有输入校验的入口**（`pruneTopic` 校验 `keep`、`createPost`
 * 校验 title/正文），于是显式传负数就会炸在一个离现场很远的地方：`strongLimit = -1` ⇒
 * `LIMIT cap + 1 = 0` ⇒ 查询返回空数组 ⇒ `0 > -1` 成立 ⇒ `strongRows[-1]` 是 undefined ⇒
 * 读 `.seq` 抛 `TypeError: Cannot read properties of undefined (reading 'seq')`——错误信息
 * 里既没有 `poll` 也没有 `strongLimit`。负小数/NaN 是另一种写法：SQLite 直接回
 * `datatype mismatch`。两者都该在入口处被一条说清楚的消息挡下。
 *
 * **`0` 必须放行**：它是合法值（"这一轴本轮不投"）。`LIMIT 1` 取回的那条正是溢出点，
 * `slice(0, 0)` 投出 0 条，`ackUpTo` 停在游标处——"游标不推进 + hidden > 0 + total > 0"，
 * 正是背压该有的样子。把 `0` 一并拒掉会让调用方没法表达"本轮先不投这一轴"。
 */
test('poll 拒绝负数/非整数的上限，但放行 0', () => {
  withDb(db => {
    posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
    seed(db, { title: 'w1' });
    seed(db, { title: 'd1', toSession: 'me' });

    for (const bad of [-1, -0.5, NaN]) {
      assert.throws(() => posts.poll(db, { reader: 'me', strongLimit: bad }),
        err => err instanceof Error && /strongLimit/.test(err.message),
        `strongLimit=${bad} 必须被拒且错误信息里带得上限的名字`);
      assert.throws(() => posts.poll(db, { reader: 'me', weakLimit: bad }),
        err => err instanceof Error && /weakLimit/.test(err.message),
        `weakLimit=${bad} 必须被拒且错误信息里带得上限的名字`);
    }

    // 0 不抛，且行为是"这一轴本轮不投、游标不推进"
    const r = posts.poll(db, { reader: 'me', strongLimit: 0, weakLimit: 0 });
    assert.equal(r.strong.length, 0);
    assert.equal(r.weak.length, 0);
    assert.equal(r.ackUpTo, 0, '两轴都不投时游标必须原地不动');
    assert.ok(r.strongHidden > 0 && r.weakHidden > 0);
    assert.ok(r.total > 0, 'total 要承诺"有东西可展示或有东西被藏起来"');
  });
});
