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

export function syncMarker(db, { kimiHome, now }) {
  const mp = markerPath(kimiHome);
  const row = db.prepare(
    'SELECT 1 AS x FROM claims WHERE completed_at IS NULL AND lease_until > ? LIMIT 1'
  ).get(now);
  if (row) {
    mkdirSync(dirname(mp), { recursive: true, mode: 0o700 });
    writeFileSync(mp, String(now));
    return true;
  }
  if (existsSync(mp)) rmSync(mp, { force: true });
  return false;
}
