import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function claim(db, { resource, holderSession, ttlMs, note = null, now }) {
  const leaseUntil = now + ttlMs;
  const stmt = db.prepare(`
    INSERT INTO claims (resource, holder_session, lease_until, completed_at, note)
    VALUES (:resource, :holder, :leaseUntil, NULL, :note)
    ON CONFLICT(resource) DO UPDATE
       SET holder_session = excluded.holder_session,
           lease_until    = excluded.lease_until,
           note           = excluded.note,
           completed_at   = NULL
     WHERE (claims.completed_at IS NULL AND claims.lease_until <= :now)
        OR (claims.completed_at IS NULL AND claims.holder_session = :holder)
  `);
  const info = stmt.run({ resource, holder: holderSession, leaseUntil, note, now });
  if (info.changes === 1) return { claimed: true, holder: holderSession, leaseUntil };
  const cur = db.prepare(
    'SELECT holder_session, lease_until, completed_at FROM claims WHERE resource = ?'
  ).get(resource);
  return {
    claimed: false,
    holder: cur?.holder_session ?? null,
    leaseUntil: cur?.completed_at != null ? null : (cur?.lease_until ?? null),
  };
}

export function busy(db, { resource, now }) {
  const r = db.prepare(
    'SELECT holder_session, lease_until, completed_at FROM claims WHERE resource = ?'
  ).get(resource);
  if (!r) return { held: false, holder: null, leaseUntil: null };
  if (r.completed_at != null) return { held: true, holder: r.holder_session, leaseUntil: null };
  if (r.lease_until <= now) return { held: false, holder: null, leaseUntil: null };
  return { held: true, holder: r.holder_session, leaseUntil: r.lease_until };
}

export function release(db, { resource, holderSession }) {
  const info = db.prepare(
    'DELETE FROM claims WHERE resource = ? AND holder_session = ? AND completed_at IS NULL'
  ).run(resource, holderSession);
  return { released: info.changes > 0 };
}

export function releaseAllForSession(db, { holderSession }) {
  const info = db.prepare(
    'DELETE FROM claims WHERE holder_session = ? AND completed_at IS NULL'
  ).run(holderSession);
  return info.changes;
}

export function complete(db, { resource, holderSession, now }) {
  const info = db.prepare(
    'UPDATE claims SET completed_at = ?, lease_until = ? WHERE resource = ? AND holder_session = ? AND completed_at IS NULL'
  ).run(now, now, resource, holderSession);
  return { completed: info.changes > 0 };
}

export function conflicts(db, { paths, session, now }) {
  if (!paths || paths.length === 0) return [];
  const ph = paths.map(() => '?').join(',');
  return db.prepare(`
    SELECT resource, holder_session AS holder, lease_until AS leaseUntil
      FROM claims
     WHERE resource IN (${ph})
       AND completed_at IS NULL
       AND lease_until > ?
       AND holder_session <> ?
  `).all(...paths, now, session);
}

export function reapExpired(db, { now, graceMs = 0 }) {
  const info = db.prepare(`
    DELETE FROM claims
     WHERE completed_at IS NULL
       AND lease_until <= ?
       AND resource NOT LIKE 'task:%'
  `).run(now - graceMs);
  return info.changes;
}

export function markerPath(kimiHome) {
  return join(kimiHome, 'agent-bus', 'claims.marker');
}

function hasActiveLease(db, now) {
  return db.prepare(
    'SELECT 1 AS x FROM claims WHERE completed_at IS NULL AND lease_until > ? LIMIT 1'
  ).get(now) != null;
}

/**
 * 把 marker 写到盘上。**只创建、不删除**——它是 `PreToolUse` 的零成本预检
 * （manifest 那一行 `[ -f .../claims.marker ] || exit 0`），缺了它 L0 静默失效。
 *
 * claim 路径用它、且**在 INSERT 之前**调用：INSERT 与 marker 落盘是两步，中间被 SIGKILL
 * 就正好落在「库里已有租约、marker 不在」——而 CLI 报的是 exit 1「领取失败」，用户以为
 * 没拿到资源。反过来（marker 在、租约还没写）是**安全方向**：预检为真只会让 hook 起来查
 * 一次库，查不到冲突就放行。
 */
export function touchMarker(kimiHome, now = Date.now()) {
  const mp = markerPath(kimiHome);
  mkdirSync(dirname(mp), { recursive: true, mode: 0o700 });
  writeFileSync(mp, String(now));
  return mp;
}

/**
 * 双向同步：有活跃租约 ⇒ marker 存在；没有 ⇒ 删掉（陈旧 marker 会让此后每个窗口的每次
 * `Write`/`Edit`/`Bash` 都白付一次 node 冷启动 + 开库，直到有人跑 claim/release/watch）。
 *
 * **删除侧必须先拿写锁（BEGIN IMMEDIATE）再 SELECT 再决定，且删除动作留在事务内**：
 * 否则与并发 claim 的「INSERT 已提交、marker 还没写」交错——本进程的 SELECT 在 claim 提交
 * 之前、rmSync 在其写盘之后，就会删掉一条**活跃**租约的 marker（TOCTOU）。拿写锁之后两条
 * 路径互斥：要么本进程先提交（则 claim 的 INSERT 只能在本进程提交后落盘，它随后的写盘
 * 一定发生在删除之后 ⇒ marker 存在），要么 claim 先提交（则本次 SELECT 看得到活跃租约 ⇒
 * 不删）。拿不到锁就抛（SQLITE_BUSY 由 busy_timeout=5000 兜住），由调用方按 fail-open 处理。
 */
export function syncMarker(db, { kimiHome, now }) {
  const mp = markerPath(kimiHome);
  if (hasActiveLease(db, now)) {
    touchMarker(kimiHome, now);
    return true;
  }
  db.exec('BEGIN IMMEDIATE');
  let active;
  try {
    active = hasActiveLease(db, now);
    // 删除留在事务内：提交之后才删，就又留出了 TOCTOU 的窗口
    if (!active && existsSync(mp)) rmSync(mp, { force: true });
    db.exec('COMMIT');
  } catch (err) {
    // BEGIN IMMEDIATE 自己就可能因 SQLITE_BUSY 失败——那时没有事务可回滚，ROLLBACK 会抛
    // 另一个异常把真正的原因（拿不到写锁）盖掉。
    try { db.exec('ROLLBACK'); } catch { /* 没有活动事务 */ }
    throw err;
  }
  return active;
}
