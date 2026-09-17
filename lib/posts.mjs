const COLS = `seq, topic, author_session, author_cwd, origin, kind,
              to_session, title, body, reply_to, ts`;

function toPost(row) {
  return {
    seq: row.seq,
    topic: row.topic,
    authorSession: row.author_session,
    authorCwd: row.author_cwd,
    origin: row.origin,
    kind: row.kind,
    toSession: row.to_session,
    title: row.title,
    body: row.body,
    replyTo: row.reply_to,
    ts: row.ts,
  };
}

export function createPost(db, {
  topic, authorSession, authorCwd, origin, kind,
  toSession = null, title, body = null, replyTo = null, now,
}) {
  if (!title || !title.trim()) throw new Error('title 不能为空');
  const info = db.prepare(`
    INSERT INTO posts (topic, author_session, author_cwd, origin, kind, to_session, title, body, reply_to, ts)
    VALUES (:topic, :authorSession, :authorCwd, :origin, :kind, :toSession, :title, :body, :replyTo, :now)
  `).run({ topic, authorSession, authorCwd, origin, kind, toSession, title, body, replyTo, now });
  return { seq: Number(info.lastInsertRowid) };
}

export function getPost(db, { seq }) {
  const row = db.prepare(`SELECT ${COLS} FROM posts WHERE seq = ?`).get(seq);
  return row ? toPost(row) : null;
}

export function getCursor(db, { reader }) {
  const r = db.prepare('SELECT last_seq FROM read_cursor WHERE reader_session = ?').get(reader);
  return r?.last_seq ?? 0;
}

export function ack(db, { reader, seq }) {
  db.prepare(`
    INSERT INTO read_cursor (reader_session, last_seq) VALUES (?, ?)
    ON CONFLICT(reader_session) DO UPDATE SET last_seq = excluded.last_seq
     WHERE excluded.last_seq > read_cursor.last_seq
  `).run(reader, seq);
}

const POLL_SQL = `
  SELECT ${COLS} FROM posts
   WHERE seq > :cursor
     AND (
           to_session = :me
        OR EXISTS (
             SELECT 1 FROM subs s
              WHERE s.reader_session = :me
                AND (posts.topic = s.pattern
                     OR substr(posts.topic, 1, length(s.pattern) + 1) = s.pattern || '/')
           )
         )
   ORDER BY seq
   LIMIT :limit
`;

export function poll(db, { reader, limit = 50 }) {
  const rows = db.prepare(POLL_SQL)
    .all({ cursor: getCursor(db, { reader }), me: reader, limit })
    .map(toPost);
  const strong = rows.filter(p => p.toSession === reader);
  const weak = rows.filter(p => p.toSession !== reader);
  const nextCursor = rows.length ? rows[rows.length - 1].seq : getCursor(db, { reader });
  return { strong, weak, nextCursor, total: rows.length };
}

export function search(db, { reader, text, limit = 20 }) {
  const like = `%${String(text).toLowerCase()}%`;
  return db.prepare(`
    SELECT ${COLS} FROM posts p
     WHERE (lower(p.title) LIKE :like OR lower(COALESCE(p.body, '')) LIKE :like)
       AND EXISTS (
             SELECT 1 FROM subs s
              WHERE s.reader_session = :me
                AND (p.topic = s.pattern
                     OR substr(p.topic, 1, length(s.pattern) + 1) = s.pattern || '/')
           )
     ORDER BY p.seq DESC
     LIMIT :limit
  `).all({ like, me: reader, limit }).map(toPost);
}

export function listTopics(db) {
  return db.prepare(
    'SELECT topic, COUNT(*) AS count, MAX(ts) AS lastTs FROM posts GROUP BY topic ORDER BY lastTs DESC, topic'
  ).all().map(r => ({ topic: r.topic, count: r.count, lastTs: r.lastTs }));
}

export function subscribe(db, { reader, pattern }) {
  db.prepare('INSERT OR IGNORE INTO subs (reader_session, pattern) VALUES (?, ?)').run(reader, pattern);
}

export function unsubscribe(db, { reader, pattern }) {
  return db.prepare('DELETE FROM subs WHERE reader_session = ? AND pattern = ?').run(reader, pattern).changes > 0;
}

export function listSubscriptions(db, { reader }) {
  return db.prepare('SELECT pattern FROM subs WHERE reader_session = ? ORDER BY pattern')
    .all(reader).map(r => r.pattern);
}

export function openTasks(db, { now, limit = 50 }) {
  const rows = db.prepare(`
    SELECT ${COLS}, c.holder_session AS claimHolder, c.lease_until AS claimLeaseUntil,
           c.completed_at IS NOT NULL AS claimCompleted
      FROM posts
      LEFT JOIN claims c ON c.resource = 'task:' || posts.seq
     WHERE posts.kind = 'request'
       AND (c.resource IS NULL
            OR (c.completed_at IS NULL AND c.lease_until <= :now))
     ORDER BY posts.seq
     LIMIT :limit
  `).all({ now, limit });
  return rows.map(r => ({
    post: toPost(r),
    claim: {
      holder: r.claimHolder ?? null,
      leaseUntil: r.claimLeaseUntil ?? null,
      completed: Boolean(r.claimCompleted),
    },
  }));
}
