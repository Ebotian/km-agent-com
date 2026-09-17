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
    assert.equal(r.nextCursor, posts.WEAK_MAX + 2, '整批的末尾仍是 nextCursor');
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
