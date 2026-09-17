#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { readFileSync, watch } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openDb, appendLog, DATE_MAX_MS } from '../lib/db.mjs';
import { ALL_TOPIC, normalizeTopic } from '../lib/topic.mjs';
import { nodeVersionError } from '../lib/version.mjs';
import * as identity from '../lib/identity.mjs';
import * as claims from '../lib/claims.mjs';
import * as posts from '../lib/posts.mjs';
import * as render from '../lib/render.mjs';

// 下游提前关闭（`| head -2`、分页读取）会让异步写抛 EPIPE。此时输出已无人接收，
// 直接退出即可——没有还值得排空的缓冲。但退出码不能丢：命令可能已经置了非零码
// （如 busy/claim 的 2），无条件 exit 0 会把失败报成成功。
// 非 EPIPE 的写错误不能让进程以 0 退出（输出没送达，回落成失败码），
// 但同样不得覆盖已置的非零码——把 2/3 改写成 1 会把「被占用」报成「用法错误」。
const onStdoutError = (e) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  else if (!process.exitCode) process.exitCode = 1;
};
process.stdout.on('error', onStdoutError);
// stderr 是尽力而为：它挂了也不能把失败改成成功，保持既有退出码。
process.stderr.on('error', () => {});

const USAGE = `用法: node bin/bus.mjs <命令> [参数] [--json] [--home <dir>] [--session <id>]
                              [--proc-root <dir>] [--now <ms>]

命令:
  whoami                       显示本窗口身份
  peers                        列出活跃窗口（含聋状态）
  topics                       列出已有主题
  post --topic T --kind K --title S [--body B] [--to <handle|session>] [--reply-to N] [--origin human|agent]
  read <seq> [--full] [--ack]  读一条；**默认不推进游标**，要推进就显式 --ack
  digest [--peek]              投递未读（默认推进游标，只推到"确实投出去了"的那一条）
  search <文本>
  subscribe <pattern> | unsubscribe <pattern> | subs
  claim <resource> [--ttl 30m] [--note S]   认领文件/端口/任务（默认 30m，单位 ms/s/m/h；
                                >0 且 ≤8760h）；被占退出 2。路径类资源按 cwd 归一化，
                                task:/port: 这类命名空间前缀原样保留
  busy <resource>              查占用；被占退出 2（资源参数与 claim 同一套归一化）
  release <resource>           释放自己的租约
  done <postSeq> [--result S]  完结 task:<seq>，--result 附带一条 finding
  tasks                        列出未认领且未完成的 request
  prune [--keep N]             归档：每个主题只保留最新 N 条（默认 5000），随后回收 WAL
  log [--limit N]              读审计日志（默认 20 条，最新在前）
  watch [--interval <ms>] [--timeout <sec>] [--max-wait <ms>]
                               自注册为 L1 watcher 并阻塞等待；只有点名给自己的
                               强投递才退出 0（一批 @ 合并成一次退出），弱投递只累计。
                               租约到期或收到 SIGTERM/SIGINT 也退出 0；--interval 默认
                               200（惊群去抖），--timeout 默认 43200 秒、上限 86400
                               （引擎的后台任务上限）。**命中时 stdout 的最后一行是带 strong
                               的 JSON；到期/信号退出时是一行说明（--json 下仍是单行 JSON，
                               但不带 strong）**——判据是最后一行能否 parse 成带 strong 的
                               对象，不是"stdout 是否为空"（后者会让每次到期都变成一次空
                               唤醒）。--max-wait 仅供测试：等够该毫秒数仍无命中则退出 3
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'json' || key === 'full' || key === 'peek' || key === 'ack') { flags[key] = true; continue; }
      const val = argv[++i];
      if (val === undefined) throw new Error(`flag --${key} 缺少值`);
      flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

const TTL_MAX_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * `--now` 的统一守卫（R-T2 + R-T4）。它被当租约基准算进 `lease_until`，所以越界的 `--now`
 * 会写出**超出 JS 安全整数**的 int64：SQLite 收得下，此后 `claims.conflicts` 一读就抛
 * `ERR_OUT_OF_RANGE`，`PreToolUse` 对那条资源只能 fail-open ⇒ 唯一保证正确性的机制（L0）
 * 静默失效，而操作者看到的只是"claim 失败"（或什么都没看到）。上界取 `DATE_MAX_MS`
 * （见 `lib/db.mjs`），与 `log` 判坏时间戳的那条日期上界是同一个常量。
 *
 * **R-T4：只挡住 `now` 本身还不够。** `lease_until = now + ttl`——`--now` 取到上界时加
 * 任何租约都越界，写进库那一刻是"成功"，但此后 busy/claim 渲染该租约会抛 RangeError
 * ⇒「被占用」被报成 exit 1。所以守卫按**最坏的租约**预留 `TTL_MAX_MS` 的余量：任何合法
 * `--now` 配上任何合法 `--ttl` 都仍落在日期范围内。
 *
 * 必须落在 `ctx()` 里、**任何写库之前**：各个子命令自己查会漏，而漏掉的那条就是漏洞。
 */
function parseNow(raw) {
  if (raw == null) return Date.now();
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || Math.abs(n) + TTL_MAX_MS > DATE_MAX_MS) {
    throw new Error(
      `--now 需要安全整数且 |now| + 最大租约（8760h）不超过 8.64e15，收到 ${raw}`);
  }
  return n;
}

/** 复用给所有「正整数」flag 的校验（`--interval`/`--timeout`/`--max-wait`/`--keep`）。 */
function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} 需要正整数，收到 ${raw}`);
  return n;
}

function ctx(flags, positional) {
  const home = flags.home || identity.kimiHome();
  const procRoot = flags['proc-root'] || process.env.AGENT_BUS_PROC_ROOT || identity.DEFAULT_PROC_ROOT;
  const now = parseNow(flags.now);
  const db = openDb(join(home, 'agent-bus', 'bus.db'));
  // 搭车清扫：失败只提示，绝不能让主命令失败（spec §10：不另设定时器，由任何一次 bus
  // 命令顺带完成——被 SIGKILL 的窗口不会有 SessionEnd，这些行必须有人回收）。
  const sweep = (what, fn) => {
    try { return fn(); } catch (err) {
      process.stderr.write(`警告: ${what} 失败: ${err.message}\n`);
      return undefined;
    }
  };
  sweep('清扫 presence', () => identity.reapDead(db, { procRoot }));
  // `claims` 是**唯一可变**的表，却一直没有上限回收：过期租约永远留在库里，而每条过期行
  // 都还会在 `busy`/`peers`/`tasks` 里出现。回收放在公共路径上，与 presence 的清扫同理。
  sweep('回收过期租约', () => claims.reapExpired(db, { now }));
  // 同一趟把 marker 摆正（I2）：**它是 L0 的零成本预检**，缺了 marker 就没人启动 hook ⇒
  // L0 全灭且无痕；而陈旧 marker 会让此后每个窗口的每次 Write/Edit/Bash 都白付一次
  // node 冷启动 + 开库。两个方向都由这一行修好，且它搭在任何命令的公共路径上。
  sweep('同步 claims.marker', () => claims.syncMarker(db, { kimiHome: home, now }));
  return { home, procRoot, now, db, flags, positional };
}

function rowRow(r) {
  return {
    tuiPid: r.tui_pid, sessionId: r.session_id, sessionTitle: r.session_title,
    cwd: r.cwd, handle: r.handle, watcherPid: r.watcher_pid, watcherUntil: r.watcher_until,
  };
}

/**
 * 自身身份：显式 `--session` 优先，否则 `--tui-pid`，再否则从**自己**往上沿 /proc 找
 * kimi-code 祖先（`resolveWindow`，与 hook 共用同一步），最后拿 pid 查 presence。
 *
 * 起点是 `process.pid` 而不是 `process.ppid`：CLI 也是被壳层拉起来的，中间有没有一层
 * shell 取决于命令形态，从父进程起算会跳过窗口那一层（见 `findKimiAncestor`）。
 */
function resolveSelf(c, { required = true } = {}) {
  const explicit = c.flags.session;
  if (explicit) {
    const row = c.db.prepare('SELECT * FROM presence WHERE session_id = ?').get(explicit);
    if (!row) throw new Error(`本窗口未在 presence 中登记（session=${explicit}）`);
    return rowRow(row);
  }
  const tuiPid = identity.resolveWindow({ procRoot: c.procRoot, pid: c.flags['tui-pid'] });
  if (tuiPid == null) {
    if (required) throw new Error('找不到所属窗口；请用 --session <id> 显式指定');
    return null;
  }
  const row = c.db.prepare('SELECT * FROM presence WHERE tui_pid = ?').get(tuiPid);
  if (!row) throw new Error(`本窗口（pid=${tuiPid}）未在 presence 中登记；请检查插件 hooks`);
  return rowRow(row);
}

/**
 * 收件人解析：handle 是给人看的别名，历史遗留或并发注册都可能留下重名行，
 * 所以命中多行时必须报错让调用方改用 session_id，绝不静默挑一行。
 */
function resolveTarget(c, to) {
  if (!to) return null;
  if (to.startsWith('session_') || to.startsWith('s:')) return to.replace(/^s:/, '');
  const bySession = c.db.prepare('SELECT tui_pid FROM presence WHERE session_id = ?').all(to);
  if (bySession.length > 0) return to;
  const byHandle = c.db.prepare('SELECT session_id FROM presence WHERE handle = ?').all(to);
  if (byHandle.length === 1) return byHandle[0].session_id;
  if (byHandle.length > 1) {
    const sids = byHandle.map(r => r.session_id).join('、');
    throw new Error(`收件人 "${to}" 的 handle 有歧义（${byHandle.length} 个窗口重名）: ${sids}；请改用 --to <session_id>`);
  }
  const cands = [...new Set(identity.listPresence(c.db, { now: c.now, procRoot: c.procRoot })
    .map(p => p.handle))].join('、');
  throw new Error(`找不到收件人 "${to}"；已知窗口: ${cands || '（无）'}`);
}

function out(c, human, obj) {
  process.stdout.write(c.flags.json ? JSON.stringify(obj) + '\n' : human);
}

/**
 * 资源名的归一化（I1）。`lib/claims.mjs` 的 `conflicts` 是**精确字符串比较**，所以
 * 「`bus claim lib/db.mjs` 存了相对串、`PreToolUse` 拿着 `/p/agent-com/lib/db.mjs` 去比」
 * 这种不匹配就是一次静默放行。两边都用同一个基准（本窗口的 cwd）`path.resolve`。
 *
 * **命名空间前缀原样保留**：`task:1` / `port:8080` 不是路径，`resolve` 会把它们变成
 * `/p/x/task:1`，于是 `done <seq>`（它自己拼 `task:<seq>`）与 `tasks` 的 JOIN 全部错位。
 * 判据是"有没有 scheme 形状的 `前缀:`"，而不是"含不含斜杠"——后者会漏掉 `task:`。
 */
function normalizeResource(resource, cwd) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(resource)) return resource;
  return cwd ? resolve(cwd, resource) : resource;
}

function cmdWhoami(c) {
  const me = resolveSelf(c);
  const subs = posts.listSubscriptions(c.db, { reader: me.sessionId });
  const peer = identity.listPresence(c.db, { now: c.now, procRoot: c.procRoot })
    .find(p => p.sessionId === me.sessionId);
  // deaf === null 表示「在听」，不能用 ?? 把它吞成 'never'
  const deaf = peer ? peer.deaf : 'never';
  const payload = { ...me, subscriptions: subs, deaf };
  out(c, `session: ${me.sessionId}\nhandle: ${me.handle}\ncwd: ${me.cwd}\n订阅: ${subs.join('、') || '（无）'}\nwatcher: ${deaf ?? 'listening'}\n`, payload);
}

function cmdPeers(c) {
  const peers = identity.listPresence(c.db, { now: c.now, procRoot: c.procRoot });
  const lines = peers.map(p =>
    `${p.handle}\t${p.sessionId}\t${p.cwd}\t${p.alive ? 'alive' : 'dead'}\t${p.deaf ?? 'listening'}`);
  out(c, (peers.length ? lines.join('\n') : '（无窗口在线）') + '\n', { peers });
}

function cmdTopics(c) {
  const topics = posts.listTopics(c.db);
  out(c, (topics.map(t => `${t.topic}\t${t.count}\t${render.ageLabel(t.lastTs, c.now)}`).join('\n') || '（无主题）') + '\n', { topics });
}

function cmdPost(c) {
  const me = resolveSelf(c);
  const topic = normalizeTopic(c.flags.topic ?? me.handle);
  const kind = c.flags.kind ?? 'finding';
  if (kind !== 'request' && kind !== 'finding') throw new Error(`kind 只允许 request|finding，收到 ${kind}`);
  const title = (c.flags.title ?? '').trim();
  if (!title) throw new Error('post 需要 --title');
  const toSession = resolveTarget(c, c.flags.to);
  if (toSession === me.sessionId) throw new Error('不能发给自己');
  // 限流（spec §9）：同一作者在同一主题上每分钟最多一条**点名帖**。一条 `@` 会当场唤醒
  // 对面整个 agent，而一次唤醒 = 整个上下文重读（spec §3.3，实测 113k token）——没有这条，
  // 一次刷屏就是一次昂贵的重读，而且是持久的（对面被唤醒后还得处理这堆消息）。
  // 广播帖不在此列：它的成本由读取方的轮次边界吸收，不需要靠限流来护。
  if (toSession) {
    const n = posts.recentDirectCount(c.db, {
      authorSession: me.sessionId, topic, since: c.now - 60_000,
    });
    if (n >= 1) {
      process.stderr.write(
        `触发限流：你在 ${topic} 上刚刚点过名。改用不带 --to 的广播帖，或等一分钟后重试。\n`);
      process.exitCode = 2;
      return;
    }
  }
  const origin = c.flags.origin ?? 'agent';
  const { seq } = posts.createPost(c.db, {
    topic, authorSession: me.sessionId, authorCwd: me.cwd, origin, kind,
    toSession, title: render.sanitize(title), body: c.flags.body ?? null,
    replyTo: c.flags['reply-to'] ? Number(c.flags['reply-to']) : null, now: c.now,
  });
  appendLog(c.home, { actor: me.sessionId, action: 'post', detail: `${seq} ${topic} ${kind}` });
  out(c, `已发布 #${seq} 到 ${topic}\n`, { seq, topic, kind, to: toSession });
}

/**
 * I3：`read` **默认不推进游标**，`--ack` 才推进。
 *
 * `posts.ack` 是单调不倒退的，所以"读到第 6 条"会把游标一口气推过 4、5——而
 * `render.triageLine` 恰恰教 agent 去 `read <最新 seq>`（triage 行里给的就是各条的 seq，
 * 但 agent 也可能从别处拿到一个大 seq）。两者一重合，中间的未读就永久不再投递：还在库里，
 * 投递路径却看不见了。读一条不是"把之前的一切都读完"，所以默认无副作用。
 * `--peek` 保留为兼容别名（现在它就是默认行为）。
 */
function cmdRead(c) {
  const me = resolveSelf(c);
  const seq = Number(c.positional[0]);
  if (!Number.isInteger(seq)) throw new Error('read 需要 seq');
  const post = posts.getPost(c.db, { seq });
  if (!post) throw new Error(`没有 #${seq}`);
  out(c, render.postMarkdown(post, { full: Boolean(c.flags.full) }), { post });
  if (c.flags.ack) posts.ack(c.db, { reader: me.sessionId, seq });
}

function cmdDigest(c) {
  const me = resolveSelf(c);
  const r = posts.poll(c.db, { reader: me.sessionId });
  const peer = identity.listPresence(c.db, { now: c.now, procRoot: c.procRoot })
    .find(p => p.sessionId === me.sessionId);
  const pluginRoot = process.env.KIMI_PLUGIN_ROOT || '.';
  const block = render.digestBlock({
    strong: r.strong, weak: r.weak, strongHidden: r.strongHidden, weakHidden: r.weakHidden, total: r.total,
    reader: me.sessionId, pluginRoot, deaf: peer?.deaf ?? null,
  });
  // 推到 `ackUpTo` 而不是 `nextCursor`：某一轴被单轮上限截掉的那几条还没投出去，推过它们
  // 就是"计数报了、内容永远不到"那个缺陷的另一种写法。
  if (!c.flags.peek && r.total > 0) posts.ack(c.db, { reader: me.sessionId, seq: r.ackUpTo });
  out(c, block ? block + '\n' : '', { ...r, block });
}

function cmdSearch(c) {
  const me = resolveSelf(c);
  const text = c.positional.join(' ');
  if (!text) throw new Error('search 需要文本');
  const hits = posts.search(c.db, { reader: me.sessionId, text });
  out(c, (hits.map(p => `#${p.seq}\t${p.topic}\t${render.sanitize(p.title)}`).join('\n') || '（无命中）') + '\n', { hits });
}

function cmdSubscribe(c, on) {
  const me = resolveSelf(c);
  const pattern = normalizeTopic(c.positional[0] ?? '');
  if (on) posts.subscribe(c.db, { reader: me.sessionId, pattern });
  else posts.unsubscribe(c.db, { reader: me.sessionId, pattern });
  out(c, `${on ? '已订阅' : '已退订'} ${pattern}\n`, { pattern, subscribed: on });
}

function cmdSubs(c) {
  const me = resolveSelf(c);
  const subscriptions = posts.listSubscriptions(c.db, { reader: me.sessionId });
  out(c, (subscriptions.join('\n') || '（无订阅）') + '\n', { subscriptions });
}

/**
 * 两个必须在**写库之前**拒掉的取值：
 * - `0`（或任何算出来是 0 的写法）：claim 会返回 `claimed:true`，但租约当场过期——
 *   「幽灵成功」，认领方以为自己拿到了资源。
 * - 荒谬上界（如 `99999999999h` ⇒ lease_until ≈ 3.6e17）：租约真的落库了，
 *   随后成功文案里的 `new Date(leaseUntil).toISOString()` 抛 RangeError ⇒ **成功被报成
 *   exit 1**，而该资源从此任何 busy/claim 都要崩（既不是 2 也不是 0）——中毒资源。
 */
function parseTtl(s) {
  if (s == null) return 30 * 60_000;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) throw new Error(`无法解析 --ttl: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const ttlMs = n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > TTL_MAX_MS) {
    // 上界用小时写：解析器的单位是 ms/s/m/h，`365d` 本身写不出来，文案不能教人写它
    throw new Error(`--ttl 需大于 0 且不超过 8760h（365 天），收到 ${s}`);
  }
  return ttlMs;
}

/**
 * `leaseUntil === null` 是唯一的带内「已完成」信号（Task 3：complete() 把 lease_until
 * 置成当时刻、completed_at 置上；busy()/claim() 对已完成行返回 null）。
 * 绝不能拿它去 new Date()——那是 epoch，会渲染成 1970-01-01，把「已做完」
 * 读成「很久以前就该过期了」。
 *
 * 渲染**绝不能抛**（R-T4）：`lease_until` 落在 `(8.64e15, 9.007e15]` 时它仍是 JS 安全整数
 * （SQL 比较照常、`conflicts` 正常判出冲突），但 `toISOString()` 会抛 `RangeError`。那会把
 * 「被占用」（exit 2）报成「用法错」（exit 1），持有者信息整条丢失——一次格式化失败就改写了
 * 判定结果。入口的 `--now` 守卫（parseNow）收窄的是新写入的行，历史遗留行照样在库里，
 * 所以这里必须自己兜底。
 */
function leaseLabel(leaseUntil) {
  if (leaseUntil == null) return '已完成';
  return Number.isSafeInteger(leaseUntil) && Math.abs(leaseUntil) <= DATE_MAX_MS
    ? `租约至 ${new Date(leaseUntil).toISOString()}`
    : `原值 ${leaseUntil}（超出 Date 表示范围）`;
}

/** 冲突文案里给人看的是 handle（能直接拿去 --to），查不到才回落到 session_id。 */
function holderLabel(c, holder) {
  if (!holder) return '（未知）';
  return c.db.prepare('SELECT handle FROM presence WHERE session_id = ?').get(holder)?.handle ?? holder;
}

function cmdClaim(c) {
  const me = resolveSelf(c);
  const raw = c.positional[0];
  if (!raw) throw new Error('claim 需要 <resource>');
  const resource = normalizeResource(raw, me.cwd);
  // 先把参数验完再动盘：被拒的命令不该留下 marker（那只会让下一次工具调用白起一个 node）
  const ttlMs = parseTtl(c.flags.ttl);
  // I2：**marker 必须在 INSERT 之前就落盘**。两步之间被 SIGKILL/写盘失败，就会落在
  // 「租约已在库里、marker 不在」——而 CLI 报的是 exit 1「领取失败」，用户以为没拿到资源，
  // 此后 L0 对这个资源静默失效（预检恒假 ⇒ hook 根本不启动）。反过来（marker 在、租约还没
  // 写）是安全方向：预检为真只让 hook 起来查一次库，查不到冲突照样放行。
  // 这里**只创建、永不删除**：删除只在 syncMarker 里做，且必须先拿到写锁（见 lib/claims.mjs）。
  claims.touchMarker(c.home, c.now);
  const r = claims.claim(c.db, {
    resource, holderSession: me.sessionId, ttlMs,
    note: c.flags.note ?? null, now: c.now,
  });
  // 认领成功后再补一次：本次 INSERT 提交之前，另一个进程的 `syncMarker` 可能恰好拿到写锁、
  // 看不到这条尚未提交的租约、于是**删掉** marker（它的删除在事务内，所以一定发生在本
  // INSERT 能提交之前）。那一步之后只有这一次写盘能把 marker 找回来——缺了它，"先 marker
  // 后 INSERT"只挡住"进程被杀"，挡不住这条并发路径。
  if (r.claimed) claims.touchMarker(c.home, c.now);
  appendLog(c.home, { actor: me.sessionId, action: r.claimed ? 'claim' : 'claim-failed', detail: resource });
  if (!r.claimed) {
    const line = `已被 ${holderLabel(c, r.holder)} 占用，${leaseLabel(r.leaseUntil)}\n`;
    process.stderr.write(line);
    out(c, line, r);
    // 用 exitCode 而非 process.exit()：stdout 上还压着没排空的缓冲（见入口注释）。
    process.exitCode = 2;
    return;
  }
  out(c, `已认领 ${render.sanitize(resource, 300)}，${leaseLabel(r.leaseUntil)}\n`, r);
}

function cmdBusy(c) {
  const me = resolveSelf(c);
  const raw = c.positional[0];
  if (!raw) throw new Error('busy 需要 <resource>');
  // 与 claim 同一套归一化：否则 `busy lib/db.mjs` 查的是一个从未有人认领过的字符串，
  // 而它报的是"空闲"——查了个寂寞。skill 里"动敏感资源前先 busy 查一次"全靠这一步。
  const resource = normalizeResource(raw, me.cwd);
  const r = claims.busy(c.db, { resource, now: c.now });
  const holderHandle = r.holder ? holderLabel(c, r.holder) : null;
  // handle 由 topicFromCwd 规范化而来（只含字母/数字/._-），进上下文是安全的。
  out(c, r.held
    ? `被 ${holderHandle} 占用，${leaseLabel(r.leaseUntil)}\n`
    : '空闲\n', { ...r, holderHandle, resource });
  if (r.held) process.exitCode = 2;
}

function cmdRelease(c) {
  const me = resolveSelf(c);
  const raw = c.positional[0];
  if (!raw) throw new Error('release 需要 <resource>');
  const resource = normalizeResource(raw, me.cwd);
  const r = claims.release(c.db, { resource, holderSession: me.sessionId });
  claims.syncMarker(c.db, { kimiHome: c.home, now: c.now });
  appendLog(c.home, { actor: me.sessionId, action: 'release', detail: resource });
  if (!r.released) {
    process.stderr.write('没有属于你的该资源租约\n');
    process.exitCode = 2;
    return;
  }
  out(c, `已释放 ${render.sanitize(resource, 300)}\n`, r);
}

function cmdDone(c) {
  const me = resolveSelf(c);
  const raw = c.positional[0];
  if (!raw) throw new Error('done 需要 <postSeq>');
  const seq = Number(String(raw).replace(/^task:/, ''));
  if (!Number.isInteger(seq)) throw new Error(`done 需要 <postSeq>，收到 ${raw}`);
  const resource = `task:${seq}`;
  const r = claims.complete(c.db, { resource, holderSession: me.sessionId, now: c.now });
  if (!r.completed) {
    process.stderr.write(`${resource} 不是由你认领的，或已完成\n`);
    process.exitCode = 2;
    return;
  }
  if (c.flags.result) {
    // task 资源可以先于帖子存在（claim 是通用资源），这时按顶层广播主题落一条，
    // 至少让 --result 的正文不凭空消失。
    const task = posts.getPost(c.db, { seq });
    posts.createPost(c.db, {
      topic: task?.topic ?? ALL_TOPIC,
      authorSession: me.sessionId, authorCwd: me.cwd, origin: 'agent', kind: 'finding',
      toSession: task?.authorSession ?? null,
      title: `task:${seq} 完成`, body: c.flags.result, replyTo: seq, now: c.now,
    });
  }
  claims.syncMarker(c.db, { kimiHome: c.home, now: c.now });
  appendLog(c.home, { actor: me.sessionId, action: 'done', detail: resource });
  out(c, `已完结 ${resource}\n`, r);
}

function cmdTasks(c) {
  resolveSelf(c);
  const tasks = posts.openTasks(c.db, { now: c.now });
  out(c, (tasks.map(t =>
    `#${t.post.seq}\t${t.post.topic}\t${render.sanitize(t.post.title)}`).join('\n') || '（无开放任务）') + '\n', { tasks });
}

/** 审计日志只读视图：坏行跳过，缺文件不是错误（审计是尽力而为的旁路）。 */
function cmdLog(c) {
  const limit = c.flags.limit == null ? 20 : Number(c.flags.limit);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 需要正整数，收到 ${c.flags.limit}`);
  let raw = '';
  try { raw = readFileSync(join(c.home, 'agent-bus', 'log.jsonl'), 'utf8'); } catch { /* 还没有日志 */ }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      // 坏行必须能整条跳过，而不是把命令带崩：`{"ts":1e999}` 会被 JSON.parse 成 Infinity，
      // 超出 Date 表示范围的大数同样是雷，两者都会让下面的 toISOString() 抛 RangeError。
      if (e && Number.isFinite(e.ts) && Math.abs(e.ts) <= DATE_MAX_MS) entries.push(e);
    } catch { /* 半行/损坏行跳过 */ }
  }
  const latest = entries.slice(-limit).reverse();
  const human = latest.map(e =>
    `${new Date(e.ts).toISOString()}\t${render.sanitize(e.actor)}\t${render.sanitize(e.action)}\t${render.sanitize(e.detail, 200)}`
  ).join('\n') || '（无审计记录）';
  out(c, human + '\n', latest);
}

/**
 * 归档（spec §9 的磁盘增长上限）。**全项目唯一一处删除 `posts` 的入口**，语义收在
 * `posts.pruneTopic()` 里；这里只负责"对每个主题各做一次"+checkpoint。
 *
 * checkpoint 是这一步的一半：WAL 里的页在 TRUNCATE 后交还给文件系统，否则删掉的行
 * 仍以 WAL 的形式占着磁盘，"上限"只是账面数字。失败不该让命令失败（归档结果已经生效），
 * 但要说出来。
 */
function cmdPrune(c) {
  resolveSelf(c);
  const keep = positiveInt(c.flags.keep ?? 5000, '--keep');
  const topics = posts.listTopics(c.db).map(t => t.topic);
  let deleted = 0;
  for (const topic of topics) deleted += posts.pruneTopic(c.db, { topic, keep });
  // `PRAGMA wal_checkpoint(TRUNCATE)` **有返回行** `{busy, log, checkpointed}`：用 exec 调它
  // 等于把结果丢掉，于是"并发 busy 时 checkpoint 没做成"这件事无从知晓——而注释里写的
  // "要说出来"只能靠这一行实现。busy=1 表示有别的连接正占着 WAL，页没交还，此时 TRUNCATE
  // 不会抛错，只会静默什么都不做。`keep < 1` 由 `posts.pruneTopic` 自己挡（那里能拦到
  // 直接调库的调用方，而 `positiveInt` 只管 CLI）。
  try {
    const row = c.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (row && row.busy !== 0) {
      process.stderr.write(`警告: wal_checkpoint 未完成（busy=${row.busy}，有别的连接在用 WAL），WAL 未回收\n`);
    }
  } catch (err) {
    process.stderr.write(`警告: wal_checkpoint 失败（归档已生效，WAL 未回收）: ${err.message}\n`);
  }
  appendLog(c.home, { actor: 'cli', action: 'prune', detail: `keep=${keep} deleted=${deleted}` });
  out(c, `已归档 ${deleted} 条（每个主题保留 ${keep} 条）\n`, { deleted, keep, topics: topics.length });
}

// —— watch：L1 强唤醒（空闲窗口的秒级唤醒）——

/**
 * 命中时的输出契约：JSON 行必须**在最后一行**——Task 10 的 hook 与醒来的 agent
 * 都按这一行解析。人类可读的 triage 块（spec §6.4 Layer B）排在它前面。
 */
function emitWatchResult(c, me, r) {
  const payload = { ...r, watchedBy: process.pid };
  if (c.flags.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }
  const block = render.digestBlock({
    strong: r.strong, weak: r.weak, strongHidden: r.strongHidden, weakHidden: r.weakHidden, total: r.total,
    reader: me.sessionId, pluginRoot: process.env.KIMI_PLUGIN_ROOT || '.',
  });
  process.stdout.write((block ? block + '\n' : '') + JSON.stringify(payload) + '\n');
}

/**
 * M5：**到期/信号退出不能留空 stdout。**
 *
 * 引擎对后台任务的**任何**终态都发完成通知，并据此开一个新轮次——而一次唤醒的固定成本是
 * 整个上下文重读（实测约 113k token，spec §3.3）。stdout 为空时，那个被唤醒的 agent
 * 拿到的是一份没有任何信息的通知：每个武装窗口每 12h 一次空唤醒，`/agent-bus:watch off`
 * 再来一次。给一行**可判别**的说明，至少让这次唤醒带来"watcher 到期了、该重新武装"。
 *
 * 代价是 stdout 契约从"空 = 到期"改成"最后一行能否 parse 成带 strong 的对象"——两者都
 * 是 exit 0，所以判据只能落在输出形状上（README / SKILL 已同步）。
 */
function watchExitNote(reason, pluginRoot) {
  const why = {
    timeout: 'watcher 到期（租约用完）',
    signal: 'watcher 被信号停掉',
    'max-wait': 'watcher 因 --max-wait 到点退出',
  }[reason] ?? `watcher 退出（${reason}）`;
  return `${why}，本轮无消息。重新武装: node ${pluginRoot}/bin/bus.mjs watch --timeout 43200`;
}

/**
 * 电平/边沿：waker 只负责「把等待切短」（定时到点、fs.watch 命中、信号），
 * 醒来的判断永远由调用方查库（posts.poll）得出——事件会丢、会合并，库才是权威状态。
 * 同一时刻只允许一个等待者（本命令的主循环是顺序的）。
 * 命中后的合并窗口故意不用它（见 cmdWatch：那一觉不能被后续 fs 事件切短）。
 */
function makeWaker() {
  let pending = null;
  const wake = () => {
    const p = pending;
    pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    p.resolve();
  };
  return {
    wake,
    wait(ms) {
      return new Promise((resolve) => { pending = { resolve, timer: setTimeout(wake, ms) }; });
    },
  };
}

/**
 * 引擎自己的后台任务上限（spec §6.2；§8.3 的武装用 43200，是它的一半）。
 * 超过它的租约没有意义，而且会把 `watcher_until` 写成超出安全整数的 int64。
 */
const WATCH_MAX_TIMEOUT_SEC = 86400;

/**
 * 自注册（watcher_pid = 自己的 pid）→ 阻塞轮询 → **只有出现点名给自己的 strong 才退出 0**。
 * 弱投递只累计，绝不开轮（一次唤醒 = 整上下文重读，见 spec §3.3）。
 *
 * 绝不改写 process.title：`/proc/<pid>/cmdline` 既是 peers 判「这个 watcher 还活着」的
 * 依据，也是别的窗口判自己聋不聋的依据；改了就全体变聋。
 */
async function cmdWatch(c) {
  const me = resolveSelf(c);
  // interval 同时是惊群去抖窗口（命中后退出前的合并窗口，见下）与最大轮询间隔；
  // NaN/0 会让等待退化成空转（既占满 CPU 又不停查库），所以先校验再进循环。
  const interval = positiveInt(c.flags.interval ?? 200, '--interval');
  const timeoutSec = positiveInt(c.flags.timeout ?? 43200, '--timeout');
  if (timeoutSec > WATCH_MAX_TIMEOUT_SEC) {
    throw new Error(`--timeout 需不超过 ${WATCH_MAX_TIMEOUT_SEC} 秒（引擎的后台任务上限），收到 ${timeoutSec}`);
  }
  const maxWait = c.flags['max-wait'] == null ? null : positiveInt(c.flags['max-wait'], '--max-wait');
  // --now 注入的是"起始时刻"：租约到期与轮询截止都以它为基准
  const until = c.now + timeoutSec * 1000;
  // 上界单靠 --timeout 挡不住：--now 也能把到期时刻推到天上去。写进 presence 的时间戳
  // 必须是安全整数，否则 setWatcher 不报错，但此后**任何** SELECT 它的命令
  // （whoami/peers/digest…）都会抛 ERR_OUT_OF_RANGE 并以 1 失败——租约期内整个窗口
  // 连自己的身份都解析不出来。校验必须在 setWatcher 之前（这里就是）。
  if (!Number.isSafeInteger(until)) {
    // 文案里回显用户原样输入的 --now（而不是被舍入后的 c.now），便于自查
    throw new Error(`--now ${c.flags.now ?? '(缺省)'} 与 --timeout ${timeoutSec}s 算出的到期时刻超出安全整数范围，请检查 --now`);
  }

  const waker = makeWaker();
  // 信号只在循环里处理：不在处理器里做清理与输出，退出码统一由 finish 记账
  let stopping = false;
  const onSignal = () => { stopping = true; waker.wake(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // fs.watch 只把等待切短，不参与判断（inotify 会丢事件）；失效也只是回落到 interval 轮询
  let poke = null;
  try { poke = watch(join(c.home, 'agent-bus'), { persistent: false }, () => waker.wake()); }
  catch { poke = null; }

  identity.setWatcher(c.db, { tuiPid: me.tuiPid, watcherPid: process.pid, watcherUntil: until });
  appendLog(c.home, { actor: me.sessionId, action: 'watch-start', detail: String(process.pid) });

  const finish = (code, reason) => {
    try {
      // 按 watcherPid 精确清除：别清掉同一窗口后来者的登记。
      // M7：**干净超时只清 watcher_pid，留着已经过期的 watcher_until**——两者都清掉的话
      // `deafState` 会报成 `'never'`（"从未武装"），把"时间到了该重新武装"说成"你从来没
      // 武装过"，而 `'expired'` 这个状态实际不可达。信号退出是被撤下（或窗口结束），
      // 两个字段都清才符合语义。
      identity.clearWatcher(c.db, {
        tuiPid: me.tuiPid, watcherPid: process.pid, keepUntil: reason === 'timeout',
      });
      claims.syncMarker(c.db, { kimiHome: c.home, now: Date.now() });
      appendLog(c.home, { actor: me.sessionId, action: 'watch-stop', detail: `${code} ${reason}` });
    } catch { /* fail-open：清理失败不能改写退出码 */ }
    if (poke) { try { poke.close(); } catch { /* 已经关了 */ } }
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    // M5：非命中退出也必须有话说（否则引擎那次完成通知是一次纯空唤醒）。
    // `--json` 时同样保持"单行 JSON"的约定，但**不带 `strong`**——判据是"最后一行能否
    // parse 成带 strong 的对象"，两种形态下都成立。
    if (reason !== 'hit') {
      const note = watchExitNote(reason, process.env.KIMI_PLUGIN_ROOT || '.');
      process.stdout.write(c.flags.json
        ? JSON.stringify({ watchedBy: process.pid, reason, message: note }) + '\n'
        : note + '\n');
    }
    // 用 exitCode 而非 process.exit()：stdout 上的 JSON 行还压在管道缓冲里（见入口注释）
    process.exitCode = code;
  };

  const started = Date.now();
  for (;;) {
    const r = posts.poll(c.db, { reader: me.sessionId });
    if (r.strong.length > 0) {
      // 一次退出 = 一次批量投递：退出前等满一个去抖窗口，把同一次惊群里的多条 @ 合并成
      // 一次唤醒。这一觉**故意不接 poke**——一次 commit 会连着触发好几个 fs 事件
      // （WAL、-shm），后续事件会立刻把等待切短，把一批投递切成好几次退出。
      await delay(interval);
      const settled = posts.poll(c.db, { reader: me.sessionId });
      // exit 0 必须意味着"stdout 里确实有东西给你"：合并窗口里那条 strong 可能已经被
      // 读走（Task 10 的 UserPromptSubmit 先取，或用户此刻跑了 digest），二次 poll 于是
      // 变空——而按 spec §3.3 的成本模型，这次空唤醒仍要付整上下文重读。所以以第一次
      // 带 strong 的结果为地板：宁可投一份略微过时的 triage，也不投空的。
      emitWatchResult(c, me, settled.strong.length > 0 ? settled : r);
      return finish(0, 'hit');
    }
    // 信号与租约到期都是正常收工（窗口会因此变聋，由 peers/whoami 检出后重新武装）
    if (stopping) return finish(0, 'signal');
    if (Date.now() >= until) return finish(0, 'timeout');
    // --max-wait：仅供测试的逃生口，等够仍无命中就退出 3
    if (maxWait != null && Date.now() - started >= maxWait) return finish(3, 'max-wait');
    await waker.wait(interval);
  }
}

const COMMANDS = {
  whoami: cmdWhoami,
  peers: cmdPeers,
  topics: cmdTopics,
  post: cmdPost,
  read: cmdRead,
  digest: cmdDigest,
  search: cmdSearch,
  subscribe: (c) => cmdSubscribe(c, true),
  unsubscribe: (c) => cmdSubscribe(c, false),
  subs: cmdSubs,
  claim: cmdClaim,
  busy: cmdBusy,
  release: cmdRelease,
  done: cmdDone,
  tasks: cmdTasks,
  prune: cmdPrune,
  log: cmdLog,
  watch: cmdWatch,
};

const name = process.argv[2];
// 用 exitCode 而非 process.exit()：stdout 接管道时写入是异步的，process.exit() 会在
// 缓冲区排空前就退出，输出被截断在管道容量（实测 64KB 正文时 65536 vs 65658 字节）。
if (!name || name === '--help' || !COMMANDS[name]) {
  process.stderr.write(USAGE);
  process.exitCode = 1;
} else {
  const fail = (err) => {
    process.stderr.write(`错误: ${err.message}\n`);
    // 与 onStdoutError 同一条规矩：不覆盖已置的非零退出码
    if (!process.exitCode) process.exitCode = 1;
  };
  // I5：入口的版本探测（`lib/db.mjs` 里还有一道同源的兜底，那是**强制点**——老 node 上
  // `import 'node:sqlite'` 的失败发生在链接期，任何 CLI 侧的自查都来不及跑）。这里多说
  // 一句是因为用户最可能在这条路径上第一次踩到它：CLI 每条命令都崩，却只看到
  // `No such built-in module: node:sqlite`。
  const nodeErr = nodeVersionError();
  if (nodeErr) fail(new Error(nodeErr));
  else try {
    const { flags, positional } = parseArgs(process.argv.slice(3));
    const done = COMMANDS[name](ctx(flags, positional));
    // watch 是 async：它里面的同步 throw 会变成 rejection，退出码的记账必须照样走到
    // （顶层 await 会要求整段改写成 async 入口，没必要）。
    if (done && typeof done.then === 'function') done.then(undefined, fail);
  } catch (err) {
    fail(err);
  }
}
