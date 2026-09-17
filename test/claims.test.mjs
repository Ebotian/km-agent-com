import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { claim, release, busy, complete, conflicts, reapExpired, syncMarker, markerPath } from '../lib/claims.mjs';
import { makeTmpHome, cleanup } from './helpers.mjs';

function withDb(fn) {
  const home = makeTmpHome();
  try { return fn(openDb(join(home, 'bus.db')), home); } finally { cleanup(home); }
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
