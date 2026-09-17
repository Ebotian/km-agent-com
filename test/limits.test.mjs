import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as claims from '../lib/claims.mjs';
import * as posts from '../lib/posts.mjs';
import { makeTmpHome, seedWindow, cleanup, runCli } from './helpers.mjs';

/**
 * 夹具必须让 presence 行与假 `/proc` **成对**出现（理由见 `helpers.seedWindow`）：只写
 * presence 的话，CLI 的 `ctx()` 会在被测命令刚启动时把该行当死窗口清掉，症状是
 * 「presence 行凭空消失 → resolveSelf exit 1」，离现场很远。所以这里不手写 presence，
 * 直接用 seedWindow，并把它的 procRoot 传给每次 runCli。
 */
function seedHome() {
  const home = makeTmpHome();
  const procRoot = seedWindow(home, {
    pid: 100, sessionId: 'me', sessionTitle: 'A', cwd: '/p/agent-com', handle: 'agent-com',
  });
  seedWindow(home, {
    pid: 200, sessionId: 'other', sessionTitle: 'B', cwd: '/p/other', handle: 'other',
  });
  const db = openDb(join(home, 'agent-bus', 'bus.db'));
  posts.subscribe(db, { reader: 'me', pattern: 'agent-com' });
  db.close();
  return { home, procRoot };
}

const base = {
  topic: 'agent-com', authorSession: 'me', authorCwd: '/p/agent-com', origin: 'agent', kind: 'finding',
};

test('createPost 拒绝超过 64KB 的正文', () => {
  const { home } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    const big = 'x'.repeat(posts.MAX_BODY_BYTES + 1);
    assert.throws(() => posts.createPost(db, { ...base, title: 'T', body: big, now: 1 }), /正文超过/);
    assert.doesNotThrow(() => posts.createPost(db, { ...base, title: 'T', body: 'x'.repeat(posts.MAX_BODY_BYTES), now: 1 }));
    db.close();
  } finally { cleanup(home); }
});

test('CLI post 遇到超大正文以退出码 1 失败', () => {
  const { home, procRoot } = seedHome();
  try {
    const r = runCli(['post', '--topic', 'agent-com', '--kind', 'finding', '--title', 'T',
      '--body', 'x'.repeat(70000), '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /正文超过/);
  } finally { cleanup(home); }
});

test('recentDirectCount 只数指定时间窗内的点名帖', () => {
  const { home } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    posts.createPost(db, { ...base, kind: 'request', toSession: 'other', title: 'a', now: 1000 });
    posts.createPost(db, { ...base, kind: 'request', toSession: 'other', title: 'b', now: 2000 });
    posts.createPost(db, { ...base, kind: 'request', toSession: null, title: 'c', now: 3000 });
    posts.createPost(db, { ...base, kind: 'request', toSession: 'other', title: 'd', now: 999999 });
    assert.equal(posts.recentDirectCount(db, { authorSession: 'me', topic: 'agent-com', since: 0 }), 3);
    assert.equal(posts.recentDirectCount(db, { authorSession: 'me', topic: 'agent-com', since: 1500 }), 2);
    db.close();
  } finally { cleanup(home); }
});

test('限流：一分钟内第二条点名帖被拒，广播帖不受限', () => {
  const { home, procRoot } = seedHome();
  try {
    const first = runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', '第一条',
      '--to', 'other', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(first.status, 0, first.stderr);

    const second = runCli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', '第二条',
      '--to', 'other', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /限流/);

    const broadcast = runCli(['post', '--topic', 'agent-com', '--kind', 'finding', '--title', '广播',
      '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(broadcast.status, 0, '不带 --to 的帖子不受限流');
  } finally { cleanup(home); }
});

test('pruneTopic 只保留最新 keep 条', () => {
  const { home } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    for (let i = 1; i <= 10; i++) {
      posts.createPost(db, { ...base, title: `t${i}`, now: i });
    }
    posts.createPost(db, { ...base, topic: 'general', title: 'keep-me', now: 99 });
    const deleted = posts.pruneTopic(db, { topic: 'agent-com', keep: 3 });
    assert.equal(deleted, 7);
    const left = db.prepare('SELECT title FROM posts WHERE topic = ? ORDER BY seq').all('agent-com').map(r => r.title);
    assert.deepEqual(left, ['t8', 't9', 't10']);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM posts WHERE topic = ?').get('general').c, 1, '不得动别的主题');
    db.close();
  } finally { cleanup(home); }
});

test('CLI prune 对全部主题生效并回报删除数', () => {
  const { home, procRoot } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    for (let i = 1; i <= 5; i++) posts.createPost(db, { ...base, title: `t${i}`, now: i });
    db.close();
    const r = runCli(['prune', '--keep', '2', '--session', 'me', '--json', '--home', home], { home, procRoot });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).deleted, 3);
    const db2 = openDb(join(home, 'agent-bus', 'bus.db'));
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM posts').get().c, 2);
    db2.close();
  } finally { cleanup(home); }
});

// —— R-T4：`lease_until` 越过日期上界时，渲染不得改写「占用」这个判定 ——

/**
 * `--now` 的守卫只约束 `now` 本身，而 `lease_until = now + ttl`。这个组合能把租约写进
 * `(8.64e15, 9.007e15]`：那里仍是 JS 安全整数（SQL 比较照常、`conflicts` 正常判出冲突），
 * 但 `new Date(x).toISOString()` 会抛 `RangeError`。CLI 的 `leaseLabel` 一抛，`busy`/`claim`
 * 就从「2 = 被占用」掉成「1 = 用法错」——**持有者信息整条丢失，调用方还会以为是自己参数写错了**。
 *
 * 历史遗留行（守卫落地之前写的）照样可能落在库里，所以渲染必须自己不抛，而不是只靠入口收窄。
 */
test('R-T4：租约越过 Date 表示范围时，被占用的资源仍报 exit 2 而不是 1', () => {
  const { home, procRoot } = seedHome();
  try {
    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    // 用库函数直接造出目标区间（入口守卫挡住了 CLI 这条路，正因如此才需要这条用例）
    const r0 = claims.claim(db, {
      resource: '/p/edge', holderSession: 'other', ttlMs: 30 * 60_000, now: 8.64e15,
    });
    assert.equal(r0.claimed, true);
    assert.ok(Number.isSafeInteger(r0.leaseUntil) && r0.leaseUntil > 8.64e15,
      `夹具没造出目标区间: ${r0.leaseUntil}`);
    db.close();

    const busy = runCli(['busy', '/p/edge', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(busy.status, 2, `被占用应报 2，实际 ${busy.status}（stderr: ${busy.stderr.trim()}）`);
    assert.match(busy.stdout, /占用/);
    assert.equal(busy.stderr.includes('Invalid time value'), false, '不得把渲染异常当作失败原因');
    assert.match(busy.stdout, /超出 Date 表示范围/, '文案要自带解释，且不能吞掉原值');

    const claim = runCli(['claim', '/p/edge', '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(claim.status, 2, `被别人持有应报 2，实际 ${claim.status}（stderr: ${claim.stderr.trim()}）`);
    assert.match(claim.stderr, /已被 .* 占用/);
    assert.equal(claim.stderr.includes('Invalid time value'), false);
  } finally { cleanup(home); }
});

/**
 * 入口侧的收窄（与上一条是同一个坑的两半）：守卫按「最坏的租约」预留余量，
 * `|now| + TTL_MAX_MS ≤ DATE_MAX_MS`，这样**任何**合法 `--now` 配上**任何**合法 `--ttl`
 * 都仍落在日期范围内，库里不会再出现渲染不出来的租约。
 *
 * 两条边界都要钉住：越界值必须在**写库之前**被拒（否则留下一条此后所有 busy/claim 都崩
 * 的中毒行），而刚好合法的最大值必须还能用（守卫只该挡越界值）。
 */
test('R-T4：--now 与 --ttl 相加越界时在写库之前被拒，资源不被污染', () => {
  const { home, procRoot } = seedHome();
  try {
    const literal = '8640000000000000'; // 裁决里的字面版：now 取到日期上界，再加 30m 就越界
    const r = runCli(['claim', '/p/r-t4', '--now', literal, '--ttl', '30m', '--session', 'me',
      '--home', home], { home, procRoot });
    assert.equal(r.status, 1, `--now ${literal} + --ttl 30m 应被拒，实际 ${r.status}`);
    assert.match(r.stderr, /now/, '错误文案要能指向出错的 flag');

    const db = openDb(join(home, 'agent-bus', 'bus.db'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM claims WHERE resource = ?').get('/p/r-t4').n, 0,
      '拒绝必须发生在写库之前：一行租约都不能留下');
    db.close();
    assert.equal(runCli(['busy', '/p/r-t4', '--session', 'other', '--home', home], { home, procRoot }).status, 0,
      '被拒之后资源仍应是空闲');

    // 上界本身必须还能用：8.64e15 − 8760h（= 最大 TTL）处起的租约正好落在日期上界上
    const edge = runCli(['claim', '/p/r-t4-edge', '--now', String(8.64e15 - 31_536_000_000), '--ttl', '8760h',
      '--session', 'me', '--home', home], { home, procRoot });
    assert.equal(edge.status, 0, edge.stderr);
    const held = runCli(['busy', '/p/r-t4-edge', '--session', 'other', '--home', home], { home, procRoot });
    assert.equal(held.status, 2);
    assert.match(held.stdout, /275760-09-13/, '边界上的租约要能正常渲染成 ISO 时间');
  } finally { cleanup(home); }
});
