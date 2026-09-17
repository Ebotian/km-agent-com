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

/**
 * **强帖与弱帖各有一条独立查询、各自设限**——不是"一条查询按 seq 取前 N 条，再在里面分类"。
 *
 * 这里以前只有一条查询：取前 50 条"点名给我 **或** 命中订阅"，然后**在这 50 条里** `filter`
 * 出 strong。于是游标之后的前 50 条若全是弱帖，点名帖根本没被取出来，`strong` 是空数组
 * ——而 watcher（`bin/bus.mjs` 的 `cmdWatch`）的退出判据正是 `strong.length > 0`。一条 `@`
 * 被 50 条弱帖淹掉之后**不会自愈**：watcher 从不推进游标（它只报"有人找你"），空闲窗口也
 * 没有别的东西推进游标——`digest` 只在轮次边界跑，且每轮只投 `WEAK_MAX` 条弱帖，200 条弱帖
 * 要 17 轮对话那条 `@` 才排得到。消息没丢（还在库里，`read`/`search` 捞得到），丢的是
 * **投递路径**：与"计数报了、标题永远不到"是同一类静默失败。
 *
 * 拆开之后，"压着 1000 条弱帖"再也不能挤掉任何一条强帖：两轴的批次窗口互不相干。
 * 各自 `LIMIT cap + 1`——多出来的那一条**不投**，但它的 seq 正是"**下一条未投递的**相关行"，
 * `ackUpTo` 靠它算（见 `poll`）。
 *
 * `COUNT(*) OVER ()` 在 `LIMIT` **之前**求值（SQLite 的求值顺序是 WHERE → 窗口函数 →
 * ORDER BY → LIMIT），于是同一次扫描顺带给出**谓词命中的总数**（不只是本批），`hidden`
 * 计数因此是个真数字，而不是"还剩至少 1 条"。
 */
const STRONG_SQL = `
  SELECT ${COLS}, COUNT(*) OVER () AS pending FROM posts
   WHERE seq > :cursor
     AND to_session = :me
   ORDER BY seq
   LIMIT :limit
`;

/**
 * 弱帖 = spec §6.3 的投递谓词**减去强帖那一支**。`to_session IS NULL OR to_session <> :me`
 * 而不是 `to_session IS NULL`：点名给**别人**的帖子仍按"命中我订阅的前缀"投给我（那正是
 * §6.3 的语义，重构前也是这么投的），两轴因此不重不漏——否则它会从两条查询的缝里掉出去，
 * 又是一个"在库里、投递路径看不见"的静默丢失。
 */
const WEAK_SQL = `
  SELECT ${COLS}, COUNT(*) OVER () AS pending FROM posts
   WHERE seq > :cursor
     AND (to_session IS NULL OR to_session <> :me)
     AND EXISTS (
           SELECT 1 FROM subs s
            WHERE s.reader_session = :me
              AND (posts.topic = s.pattern
                   OR substr(posts.topic, 1, length(s.pattern) + 1) = s.pattern || '/')
         )
   ORDER BY seq
   LIMIT :limit
`;

/**
 * 每轮投递的**强帖**（点名给我的）条数上限：50，也就是重构之前"整批 50 条"那个事实上的
 * 上限。强帖与弱帖**各自一个上限、各自一条查询**（理由见上面的 `STRONG_SQL`）——共享一个
 * 批次窗口正是"弱帖洪水淹没点名唤醒"的成因。
 */
export const STRONG_MAX = 50;

/**
 * 每轮投递的**弱帖**条数上限（spec §9「每轮注入条数上限（默认 10）」）。
 *
 * 弱投递（订阅命中、非点名）以前只累计计数、正文永不到达，而游标照样被推过——三条广播
 * 的标题从未进过上下文，`digest` 却已经 `ack` 掉了。现在弱帖也出 triage 行（标题因此
 * 真的到达接收方），但**有上限**：一次唤醒已经够贵，弱投递不能成为上下文放大器。
 * 超出上限的部分**不推进游标**（见 `ackUpTo`），下一轮继续投，一条都不丢。
 */
export const WEAK_MAX = 10;

/**
 * `poll` 上限的**上界**，单位是 SQLite 的 int64。
 *
 * 值本身是个"能精确表示的最大 int64 以下的双精度整数"：`2^63 - 1024`。为什么不是 `2^63 - 1`：
 * [2^62, 2^63) 这一档里双精度的 ulp 是 1024，所以它上面**更大的那些整数在 double 里根本不存在**
 * ——`2^63 - 512`、`2^63 - 1` 在 JS 里都**等于 `2^63`**（从 `2^63` 起 ulp 变 2048，最近的可表示
 * 值是 `2^63 - 1024` 与 `2^63`，中点 `2^63 - 512` 按"取偶"舍到 `2^63`）。于是判据
 * `limit > MAX_LIMIT` 恰好等价于"这个 double ≥ 2^63"，不多不少地圈住 SQLite 绑不上 int64 的
 * 那一档：`> 2^63 - 1024` 的值绑上去就是**裸的** `Error: datatype mismatch`（消息里没有参数名，
 * 正是本守卫要消灭的那类看不懂的错）。
 *
 * 不用 `Number.isSafeInteger`（它排除一切 `> 2^53` 的值）是**故意选更窄的一档**：`2^54` 之类虽然
 * 荒谬，但改前就能正常绑上（= 实际不限），拒绝它们是对既有行为的额外收窄，与本项目的
 * "按证据改、不顺手收紧"不符。这里的边界来自实测（见 poll-guard-report.md 的上界实测表）。
 */
const MAX_LIMIT = 2 ** 63 - 1024;

/**
 * `reader` 必须是**非空字符串**。SQLite 的绑定对 `undefined` 是裸
 * `TypeError: Provided value cannot be bound to SQLite parameter 1.`（没有参数名），而 `null`
 * 更坏——它绑得进去，于是查询恒不命中，`poll` **静默**返回 `strong=0 weak=0 total=0`，调用方
 * 会把它读成"没有新消息"。静默的空答案比抛错更坏，而这正是本模块一直在消灭的那类失效
 * （见 `STRONG_SQL` 注释里的"投递路径看不见"）。判据取"非空字符串"而不是"非 null"：空串与
 * `0` 在库里同样不是任何 session id，一样只会得到空答案。
 */
function assertPollArgs({ reader, strongLimit, weakLimit }) {
  if (typeof reader !== 'string' || reader === '') {
    throw new Error(`poll 的 reader 必须是非空字符串，收到 ${JSON.stringify(reader) ?? String(reader)}`);
  }
  // 两个上限都必须是不小于 **0** 且不超过 MAX_LIMIT 的整数。负数不只是"少投几条"：`LIMIT cap + 1`
  // 在 cap = -1 时就是 `LIMIT 0`，查询返回空数组，于是下面 `strongRows.length > strongLimit`
  // （`0 > -1`）成立、`strongRows[strongLimit]` 索引 -1 得 undefined ⇒ 读 `.seq` 抛 TypeError；
  // 负小数/NaN 更早一步就被 SQLite 挡下（`datatype mismatch`），但那是数据库的抱怨，不是调用方的。
  // 上界那一档同理（见 `MAX_LIMIT`）。`cap = 0` 则**合法**（"这一轴本轮不投"）：查询取回 0+1 条、
  // `slice(0, 0)` 投出 0 条，那条取回来的行正是溢出点，`ackUpTo` 停在游标处——正是背压该有的
  // 样子，所以下界判据是"≥ 0"。
  for (const [name, cap] of [['strongLimit', strongLimit], ['weakLimit', weakLimit]]) {
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error(`poll 的 ${name} 必须是不小于 0 的整数，收到 ${cap}`);
    }
    // 上界单独一条消息：命中的值确实是"不小于 0 的整数"，套上一条消息就是误导。
    if (cap > MAX_LIMIT) {
      throw new Error(`poll 的 ${name} 超过 int64 上限 ${MAX_LIMIT}，收到 ${cap}`);
    }
  }
}

export function poll(db, { reader, strongLimit = STRONG_MAX, weakLimit = WEAK_MAX }) {
  assertPollArgs({ reader, strongLimit, weakLimit });
  const cursor = getCursor(db, { reader });
  const strongRows = db.prepare(STRONG_SQL).all({ cursor, me: reader, limit: strongLimit + 1 });
  const weakRows = db.prepare(WEAK_SQL).all({ cursor, me: reader, limit: weakLimit + 1 });
  // 两条查询都按 seq 升序，所以 slice 天然是"最早的那些"；被切掉的第 cap+1 条就是
  // "下一条未投递的相关行"
  const strong = strongRows.slice(0, strongLimit).map(toPost);
  const weak = weakRows.slice(0, weakLimit).map(toPost);
  const overflowSeq = [
    ...(strongRows.length > strongLimit ? [strongRows[strongLimit].seq] : []),
    ...(weakRows.length > weakLimit ? [weakRows[weakLimit].seq] : []),
  ];
  const delivered = [...strong, ...weak];
  const maxDelivered = delivered.reduce((m, p) => Math.max(m, p.seq), cursor);
  return {
    strong,
    weak,
    strongHidden: (strongRows[0]?.pending ?? 0) - strong.length,
    weakHidden: (weakRows[0]?.pending ?? 0) - weak.length,
    // 已投递行里的最大 seq（没有则 cursor）。**它不等于"本批的末尾"**：弱帖（或强帖）被
    // 上限截掉时，nextCursor 故意比整批的末尾小。推进游标一律用 ackUpTo。
    nextCursor: maxDelivered,
    // 投递不变量：**游标不许推过任何未投递的相关行**，所以只有它适合拿来 `ack`。两轴都可能
    // 溢出，取更早的那一条减一；两轴都没溢出时，两条查询已经把 cursor 之后**所有**相关行
    // 取全了，`max(已投递)` 就是最后一个相关行，推过去是安全的。
    //
    // **已知取舍：strong 轴溢出时，一批已投递的弱帖下一轮会重投一次。** 这不是缺陷，而是
    // 单个标量游标的固有代价：游标只能表示"某 seq 之前的都投过了"，无法表示"投了 61–70 但
    // 没投 51"。例：游标之后是 `[60 条 strong][300 条 weak]`，轮 1 投出 strong #1–50 与
    // weak #61–70，但溢出点是 strong #51（更早），于是 ackUpTo = 50——比刚投出去的 weak
    // #61–70 还小，它们下一轮会作为"未投递"再出现一次（再下一轮起恢复正常）。
    // 触发条件是 **strong 轴溢出**（游标之后 **> STRONG_MAX** 条未读点名帖，即 ≥ STRONG_MAX+1；
    // 恰好 STRONG_MAX 条时 `strongRows.length > strongLimit` 为假，不溢出、也就不重投）。
    // 点名帖限流的粒度是**每作者每主题**每分钟 1 条（`recentDirectCount` 的 WHERE 含
    // `author_session`），所以"罕见"只是"需要异常密集的点名"，不是"物理上不可能"——同一主题上
    // N 个作者各自点名仍可达 N 条/分，这些作者同时刷屏就能凑出这一档。重投量也有界——每轮至多
    // WEAK_MAX 行 triage 重复，
    // 内容没丢也没错。真正的"防重投"需要第二个游标（弱轴独立推进），属独立设计决策，别在
    // 这里顺手改。
    ackUpTo: overflowSeq.length ? Math.min(...overflowSeq) - 1 : maxDelivered,
    // total 只承诺一件事：`> 0` ⟺ "有东西可展示**或**有东西被藏起来"（`render.digestBlock`
    // 用它决定要不要输出，调用方用它决定要不要推进游标）。所以 shown 与 hidden 都要算进来，
    // 否则"被截掉了、本轮一条都不展示"会退化成 `total = 0` ⇒ 连计数都不报。
    total: (strongRows[0]?.pending ?? 0) + (weakRows[0]?.pending ?? 0),
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
