import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { claim, release, busy, complete, conflicts, reapExpired, releaseAllForSession, syncMarker, touchMarker, markerPath } from '../lib/claims.mjs';
import { makeTmpHome, cleanup } from './helpers.mjs';

function withDb(fn) {
  const home = makeTmpHome();
  try { return fn(openDb(join(home, 'bus.db')), home); } finally { cleanup(home); }
}

function rowOf(db, resource) {
  const r = db.prepare(
    'SELECT holder_session, lease_until, completed_at, note FROM claims WHERE resource = ?'
  ).get(resource);
  if (!r) return null;
  return {
    holder: r.holder_session,
    leaseUntil: r.lease_until,
    completedAt: r.completed_at,
    note: r.note,
  };
}

test('第一个认领成功，第二个被拒并返回持有者', () => {
  withDb(db => {
    const now = 1000;
    const a = claim(db, { resource: '/p/f', holderSession: 'sA', ttlMs: 60000, now });
    assert.equal(a.claimed, true);
    const b = claim(db, { resource: '/p/f', holderSession: 'sB', ttlMs: 60000, now: now + 1 });
    assert.equal(b.claimed, false);
    assert.equal(b.holder, 'sA');
    assert.equal(b.leaseUntil, now + 60000);
  });
});

test('租约过期后可被他人抢占', () => {
  withDb(db => {
    claim(db, { resource: '/p/f', holderSession: 'sA', ttlMs: 1000, now: 0 });
    const b = claim(db, { resource: '/p/f', holderSession: 'sB', ttlMs: 1000, now: 100000 });
    assert.equal(b.claimed, true);
  });
});

test('同一持有者可续租自己的租约', () => {
  withDb(db => {
    claim(db, { resource: '/p/f', holderSession: 'sA', ttlMs: 1000, now: 0 });
    const again = claim(db, { resource: '/p/f', holderSession: 'sA', ttlMs: 1000, now: 500 });
    assert.equal(again.claimed, true);
  });
});

test('release 只能释放自己的租约', () => {
  withDb(db => {
    claim(db, { resource: '/p/f', holderSession: 'sA', ttlMs: 1000, now: 0 });
    assert.deepEqual(release(db, { resource: '/p/f', holderSession: 'sB' }), { released: false });
    assert.deepEqual(release(db, { resource: '/p/f', holderSession: 'sA' }), { released: true });
    assert.equal(busy(db, { resource: '/p/f', now: 1 }).held, false);
  });
});

test('tasks 资源完成后不可再被抢占', () => {
  withDb(db => {
    claim(db, { resource: 'task:1', holderSession: 'sA', ttlMs: 1000, now: 0 });
    assert.equal(complete(db, { resource: 'task:1', holderSession: 'sA', now: 10 }).completed, true);
    const b = claim(db, { resource: 'task:1', holderSession: 'sB', ttlMs: 1000, now: 100000 });
    assert.equal(b.claimed, false);
  });
});

test('conflicts 只报他人持有的未过期租约', () => {
  withDb(db => {
    const now = 1000;
    claim(db, { resource: '/p/a', holderSession: 'sA', ttlMs: 60000, now });
    claim(db, { resource: '/p/b', holderSession: 'sB', ttlMs: 60000, now });
    const c = conflicts(db, { paths: ['/p/a', '/p/b', '/p/c'], session: 'sB', now });
    assert.equal(c.length, 1);
    assert.equal(c[0].resource, '/p/a');
    assert.equal(c[0].holder, 'sA');
  });
});

test('reapExpired 删除过期的非任务租约，保留任务租约', () => {
  withDb(db => {
    claim(db, { resource: '/p/a', holderSession: 'sA', ttlMs: 1, now: 0 });
    claim(db, { resource: 'task:9', holderSession: 'sA', ttlMs: 1, now: 0 });
    assert.equal(reapExpired(db, { now: 100000 }), 1);
    assert.equal(busy(db, { resource: 'task:9', now: 0 }).leaseUntil, 1);
  });
});

test('syncMarker 反映是否存在未过期租约', () => {
  withDb((db, home) => {
    const mp = markerPath(home);
    assert.equal(syncMarker(db, { kimiHome: home, now: 0 }), false);
    assert.equal(existsSync(mp), false);
    claim(db, { resource: '/p/a', holderSession: 'sA', ttlMs: 1000, now: 0 });
    assert.equal(syncMarker(db, { kimiHome: home, now: 1 }), true);
    assert.equal(existsSync(mp), true);
    assert.equal(syncMarker(db, { kimiHome: home, now: 100000 }), false);
    assert.equal(existsSync(mp), false);
  });
});

test('已完成资源的认领失败不修改该行', () => {
  withDb(db => {
    claim(db, { resource: 'task:3', holderSession: 'sA', ttlMs: 1000, now: 0, note: 'sA 做完了' });
    complete(db, { resource: 'task:3', holderSession: 'sA', now: 10 });
    const before = rowOf(db, 'task:3');
    assert.deepEqual(before, { holder: 'sA', leaseUntil: 10, completedAt: 10, note: 'sA 做完了' });

    const b = claim(db, { resource: 'task:3', holderSession: 'sB', ttlMs: 5000, now: 100000 });
    assert.equal(b.claimed, false);
    assert.deepEqual(rowOf(db, 'task:3'), before);
  });
});

test('未完成但租约过期的 task 资源仍可被他人认领', () => {
  withDb(db => {
    claim(db, { resource: 'task:4', holderSession: 'sA', ttlMs: 1000, now: 0 });
    const b = claim(db, { resource: 'task:4', holderSession: 'sB', ttlMs: 1000, now: 5000 });
    assert.equal(b.claimed, true);
    assert.equal(b.holder, 'sB');
    assert.equal(rowOf(db, 'task:4').holder, 'sB');
  });
});

test('releaseAllForSession 只回收未完结的租约，已完成的行留下', () => {
  withDb(db => {
    claim(db, { resource: '/p/keep', holderSession: 'sA', ttlMs: 1000, now: 0, note: '已完成' });
    complete(db, { resource: '/p/keep', holderSession: 'sA', now: 1 });
    claim(db, { resource: '/p/drop', holderSession: 'sA', ttlMs: 1000, now: 0 });
    claim(db, { resource: '/p/other', holderSession: 'sB', ttlMs: 1000, now: 0 });

    assert.equal(releaseAllForSession(db, { holderSession: 'sA' }), 1);
    assert.deepEqual(rowOf(db, '/p/keep'), { holder: 'sA', leaseUntil: 1, completedAt: 1, note: '已完成' });
    assert.equal(rowOf(db, '/p/drop'), null);
    assert.equal(rowOf(db, '/p/other').holder, 'sB');
    assert.equal(busy(db, { resource: '/p/drop', now: 0 }).held, false);
  });
});

test('releaseAllForSession 对没有租约的会话返回 0', () => {
  withDb(db => {
    claim(db, { resource: '/p/a', holderSession: 'sA', ttlMs: 1000, now: 0 });
    assert.equal(releaseAllForSession(db, { holderSession: 'sZ' }), 0);
    assert.equal(rowOf(db, '/p/a').holder, 'sA');
  });
});

// —— I2：marker 的两条写入路径（claim 只创建；删除必须先拿写锁）——

test('I2：touchMarker 只创建，删除只归 syncMarker', () => {
  withDb((db, home) => {
    // touchMarker 的职责是"claim 之前先把 marker 摆好"：进程在 INSERT 与写盘之间被杀时，
    // 只有它能让 marker 已经存在（L0 的预检就靠这个文件）
    assert.equal(existsSync(markerPath(home)), false);
    touchMarker(home, 5);
    assert.equal(existsSync(markerPath(home)), true);
    touchMarker(home, 6);
    assert.equal(existsSync(markerPath(home)), true, '库里没有租约时它也照样只写不删');
    assert.equal(syncMarker(db, { kimiHome: home, now: 7 }), false);
    assert.equal(existsSync(markerPath(home)), false, '删除只发生在 syncMarker 里');
  });
});

/**
 * I2 的 TOCTOU 那一半：并发 claim 的中间态是「INSERT 已提交、marker 还没写」，而删除侧
 * 若"先 SELECT 再 rm"就会删掉一条**活跃**租约的 marker。修法是删除必须发生在写锁之内：
 * 拿不到写锁时它根本不能做决定，只能抛（由调用方 fail-open）。这里用第二个连接的
 * BEGIN IMMEDIATE + 未提交 INSERT 精确造出那个中间态，不依赖时序运气。
 */
test('I2：写锁在别人手里时删除侧不删 marker（不赌"看不到就等于没有"）', () => {
  withDb((db, home) => {
    const mp = markerPath(home);
    touchMarker(home, 0);
    db.exec('PRAGMA busy_timeout = 20');   // 让"拿不到锁"当场可见，不必等 5s

    const other = openDb(join(home, 'bus.db'));
    try {
      other.exec('BEGIN IMMEDIATE');
      // 走 lib 自己的认领入口：这一行落在 other 的未提交事务里，正是并发 claim 的中间态
      assert.equal(claim(other, {
        resource: '/p/x', holderSession: 'sB', ttlMs: 60_000, now: Date.now(),
      }).claimed, true);

      assert.throws(() => syncMarker(db, { kimiHome: home, now: 0 }), /busy|locked/i,
        '拿不到写锁时必须失败，而不是"看不到租约"就删');
      assert.equal(existsSync(mp), true,
        '误删一条活跃租约的 marker = L0 对那条资源静默失效（预检恒假，hook 根本不启动）');

      other.exec('COMMIT');
      assert.equal(syncMarker(db, { kimiHome: home, now: 0 }), true);
      assert.equal(existsSync(mp), true, '提交之后这条租约必须被看见');
    } finally { other.close(); }
  });
});
