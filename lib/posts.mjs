const COLS = `seq, topic, author_session, author_cwd, origin, kind,
              to_session, title, body, reply_to, ts`;

/**
 * 正文上限（spec §9）。一条消息的成本不是它自己的字节数，而是**接收方为它重读的整个
 * 上下文**（spec §3.3）；正文无上限时，一次投递就能把对面的上下文打爆。64KB 足够装
 * 结论 + 证据指针 + 一段最小复现，装不下"贴 200 行日志"——那本来就不该走总线。
 * 按**字节**而非字符计：UTF-8 下中文一字三字节，按字符计会让上限实际变成 3 倍。
 */
export const MAX_BODY_BYTES = 65536;

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
  // 上限在这里校验而不是 CLI 里：hook、done --result 等路径也经这个函数入库
  if (body != null && Buffer.byteLength(String(body), 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`正文超过 ${MAX_BODY_BYTES} 字节上限`);
  }
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

/**
 * 每轮投递的**弱帖**条数上限（spec §9「每轮注入条数上限（默认 10）」）。
 *
 * 弱投递（订阅命中、非点名）以前只累计计数、正文永不到达，而游标照样被推过——三条广播
 * 的标题从未进过上下文，`digest` 却已经 `ack` 掉了。现在弱帖也出 triage 行（标题因此
 * 真的到达接收方），但**有上限**：一次唤醒已经够贵，弱投递不能成为上下文放大器。
 * 超出上限的部分**不推进游标**（见 `ackUpTo`），下一轮继续投，一条都不丢。
 */
export const WEAK_MAX = 10;

export function poll(db, { reader, limit = 50, weakLimit = WEAK_MAX }) {
  const cursor = getCursor(db, { reader });
  const rows = db.prepare(POLL_SQL)
    .all({ cursor, me: reader, limit })
    .map(toPost);
  const strong = rows.filter(p => p.toSession === reader);
  const weakAll = rows.filter(p => p.toSession !== reader);
  // rows 按 seq 升序，所以 slice 天然是"最早的 weakLimit 条"
  const weak = weakAll.slice(0, weakLimit);
  const nextCursor = rows.length ? rows[rows.length - 1].seq : cursor;
  // 游标只能推过「本批中 ≤ 它的一切都已投递」的最大 seq：弱帖被上限截掉时不推进，
  // 否则被截掉的那几条会永久不再投递（正是本轮要修的那个静默丢失）。
  const shown = new Set([...strong, ...weak].map(p => p.seq));
  let ackUpTo = cursor;
  for (const row of rows) {
    if (!shown.has(row.seq)) break;
    ackUpTo = row.seq;
  }
  return {
    strong,
    weak,
    weakHidden: weakAll.length - weak.length,
    nextCursor,
    ackUpTo,
    total: rows.length,
  };
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

/**
 * 投递限流的数据面（spec §9）：某作者在某主题上、`ts >= since` 的**点名帖**条数。
 *
 * 只数 `to_session` 非空的帖子：广播帖的成本由读取方的轮次边界吸收，而一条 `@` 会当场
 * 唤醒对面整个 agent（一次唤醒 = 整个上下文重读，spec §3.3）——正是"一次刷屏换一次
 * 113k token 重读"的那条路径。窗口与判定留给调用方（CLI 用 `now - 60_000`）。
 */
export function recentDirectCount(db, { authorSession, topic, since }) {
  const r = db.prepare(`
    SELECT COUNT(*) AS c FROM posts
     WHERE author_session = :authorSession
       AND topic = :topic
       AND to_session IS NOT NULL
       AND ts >= :since
  `).get({ authorSession, topic, since });
  return r.c;
}

/**
 * 归档：保留 topic 下最新 keep 条，删除更旧的（spec §9 要求磁盘增长有上限）。
 *
 * **这是整个项目里唯一一处对 `posts` 做 DELETE 的地方。** 本设计的原则是 `posts` 只追加：
 * 游标语义（`read_cursor.last_seq`）依赖它的不可变性——行一旦能被删掉，"游标之后没有新行"
 * 就不再等价于"没有新消息"，任何已推进的游标都可能跳过或重放。这里的豁免仅为磁盘上限而
 * 存在，所以它必须是一个显式命名、可被检索到的函数：除本函数外，任何对 `posts` 的
 * UPDATE/DELETE 都应当被拒绝。别以"顺手清理"为名在别的函数里加 DELETE。
 *
 * `keep` 的校验必须在这里，而不是只留给调用方：`keep = 0` 会**清空整个主题**，使全局
 * `MAX(seq)` **下降**，之后新帖重新拿到小 seq —— 而 `claims.resource = 'task:' || seq`
 * 与 `read_cursor.last_seq` 都建立在"seq 单调"上：游标永久失明、`task:*` 撞名，两者都
 * **无法自愈**。`keep = undefined` 更隐蔽：绑成 NULL 后 `LIMIT NULL` 在 SQLite 里等于
 * "不限"，同样清空该主题，所以判据是"正整数"而不是"≥ 1"。
 */
export function pruneTopic(db, { topic, keep }) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`pruneTopic 的 keep 必须是不小于 1 的整数，收到 ${keep}`);
  }
  const info = db.prepare(`
    DELETE FROM posts
     WHERE topic = :topic
       AND seq NOT IN (
         SELECT seq FROM posts WHERE topic = :topic ORDER BY seq DESC LIMIT :keep
       )
  `).run({ topic, keep });
  return info.changes;
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
