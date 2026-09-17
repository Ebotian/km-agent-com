#!/usr/bin/env node
import { join } from 'node:path';
import { readFileSync, watch } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openDb, appendLog } from '../lib/db.mjs';
import { ALL_TOPIC, normalizeTopic } from '../lib/topic.mjs';
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
  read <seq> [--full] [--peek]
  digest [--peek]              投递未读（默认推进游标）
  search <文本>
  subscribe <pattern> | unsubscribe <pattern> | subs
  claim <resource> [--ttl 30m] [--note S]   认领文件/端口/任务（默认 30m，单位 ms/s/m/h；
                                >0 且 ≤8760h）；被占退出 2
  busy <resource>              查占用；被占退出 2
  release <resource>           释放自己的租约
  done <postSeq> [--result S]  完结 task:<seq>，--result 附带一条 finding
  tasks                        列出未认领且未完成的 request
  log [--limit N]              读审计日志（默认 20 条，最新在前）
  watch [--interval <ms>] [--timeout <sec>] [--max-wait <ms>]
                               自注册为 L1 watcher 并阻塞等待；只有点名给自己的
                               强投递才退出 0（一批 @ 合并成一次退出），弱投递只累计。
                               租约到期或收到 SIGTERM/SIGINT 也退出 0；--interval 默认
                               200（惊群去抖），--timeout 默认 43200 秒、上限 86400
                               （引擎的后台任务上限）。**命中时 stdout 必有 JSON 行；
                               到期或信号退出时 stdout 为空**——调用方据此区分两者。
                               --max-wait 仅供测试：等够该毫秒数仍无命中则退出 3
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'json' || key === 'full' || key === 'peek') { flags[key] = true; continue; }
      const val = argv[++i];
      if (val === undefined) throw new Error(`flag --${key} 缺少值`);
      flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

/**
 * `--now` 的统一守卫（R-T2）。它被当租约基准算进 `lease_until`，所以越界的 `--now` 会
 * 写出**超出 JS 安全整数**的 int64：SQLite 收得下，此后 `claims.conflicts` 一读就抛
 * `ERR_OUT_OF_RANGE`，`PreToolUse` 对那条资源只能 fail-open ⇒ 唯一保证正确性的机制（L0）
 * 静默失效，而操作者看到的只是"claim 失败"（或什么都没看到）。上界取 8.64e15，与 `log`
 * 判坏时间戳的那条日期上界一致。
 *
 * 必须落在 `ctx()` 里、**任何写库之前**：各个子命令自己查会漏，而漏掉的那条就是漏洞。
 */
const DATE_MAX_MS = 8.64e15;

function parseNow(raw) {
  if (raw == null) return Date.now();
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || Math.abs(n) > DATE_MAX_MS) {
    throw new Error(`--now 需要安全整数且 |now| ≤ 8.64e15（与日志的日期上界一致），收到 ${raw}`);
  }
  return n;
}

function ctx(flags, positional) {
  const home = flags.home || identity.kimiHome();
  const procRoot = flags['proc-root'] || process.env.AGENT_BUS_PROC_ROOT || identity.DEFAULT_PROC_ROOT;
  const now = parseNow(flags.now);
  const db = openDb(join(home, 'agent-bus', 'bus.db'));
  // spec §10：presence 的清扫不另设定时器，由任何一次 bus 命令顺带完成。
  // 清扫是搭车性质，失败只提示，绝不能让主命令失败。
  try { identity.reapDead(db, { procRoot }); } catch (err) {
    process.stderr.write(`警告: 清扫 presence 失败: ${err.message}\n`);
  }
  return { home, procRoot, now, db, flags, positional };
}

function rowRow(r) {
  return {
    tuiPid: r.tui_pid, sessionId: r.session_id, sessionTitle: r.session_title,
    cwd: r.cwd, handle: r.handle, watcherPid: r.watcher_pid, watcherUntil: r.watcher_until,
  };
}

/** 自身身份：显式 --session 优先，否则沿 /proc 找 kimi-code 祖先再查 presence */
function resolveSelf(c, { required = true } = {}) {
  const explicit = c.flags.session;
  const pidFromEnv = c.flags['tui-pid'] ? Number(c.flags['tui-pid']) : null;
  if (explicit) {
    const row = c.db.prepare('SELECT * FROM presence WHERE session_id = ?').get(explicit);
    if (!row) throw new Error(`本窗口未在 presence 中登记（session=${explicit}）`);
    return rowRow(row);
  }
  const tuiPid = pidFromEnv ?? identity.findKimiAncestor(process.ppid, c.procRoot);
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
  const origin = c.flags.origin ?? 'agent';
  const { seq } = posts.createPost(c.db, {
    topic, authorSession: me.sessionId, authorCwd: me.cwd, origin, kind,
    toSession, title: render.sanitize(title), body: c.flags.body ?? null,
    replyTo: c.flags['reply-to'] ? Number(c.flags['reply-to']) : null, now: c.now,
  });
  appendLog(c.home, { actor: me.sessionId, action: 'post', detail: `${seq} ${topic} ${kind}` });
  out(c, `已发布 #${seq} 到 ${topic}\n`, { seq, topic, kind, to: toSession });
}

function cmdRead(c) {
  const me = resolveSelf(c);
  const seq = Number(c.positional[0]);
  if (!Number.isInteger(seq)) throw new Error('read 需要 seq');
  const post = posts.getPost(c.db, { seq });
  if (!post) throw new Error(`没有 #${seq}`);
  out(c, render.postMarkdown(post, { full: Boolean(c.flags.full) }), { post });
  if (!c.flags.peek) posts.ack(c.db, { reader: me.sessionId, seq });
}

function cmdDigest(c) {
  const me = resolveSelf(c);
  const r = posts.poll(c.db, { reader: me.sessionId });
  const peer = identity.listPresence(c.db, { now: c.now, procRoot: c.procRoot })
    .find(p => p.sessionId === me.sessionId);
  const pluginRoot = process.env.KIMI_PLUGIN_ROOT || '.';
  const block = render.digestBlock({
    strong: r.strong, weak: r.weak, total: r.total,
    reader: me.sessionId, pluginRoot, deaf: peer?.deaf ?? null,
  });
  if (!c.flags.peek && r.total > 0) posts.ack(c.db, { reader: me.sessionId, seq: r.nextCursor });
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

const TTL_MAX_MS = 365 * 24 * 60 * 60 * 1000;

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
 */
function leaseLabel(leaseUntil) {
  return leaseUntil == null ? '已完成' : `租约至 ${new Date(leaseUntil).toISOString()}`;
}

/** 冲突文案里给人看的是 handle（能直接拿去 --to），查不到才回落到 session_id。 */
function holderLabel(c, holder) {
  if (!holder) return '（未知）';
  return c.db.prepare('SELECT handle FROM presence WHERE session_id = ?').get(holder)?.handle ?? holder;
}

function cmdClaim(c) {
  const me = resolveSelf(c);
  const resource = c.positional[0];
  if (!resource) throw new Error('claim 需要 <resource>');
  const r = claims.claim(c.db, {
    resource, holderSession: me.sessionId, ttlMs: parseTtl(c.flags.ttl),
    note: c.flags.note ?? null, now: c.now,
  });
  claims.syncMarker(c.db, { kimiHome: c.home, now: c.now });
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
  resolveSelf(c);
  const resource = c.positional[0];
  if (!resource) throw new Error('busy 需要 <resource>');
  const r = claims.busy(c.db, { resource, now: c.now });
  const holderHandle = r.holder ? holderLabel(c, r.holder) : null;
  // handle 由 topicFromCwd 规范化而来（只含字母/数字/._-），进上下文是安全的。
  out(c, r.held
    ? `被 ${holderHandle} 占用，${leaseLabel(r.leaseUntil)}\n`
    : '空闲\n', { ...r, holderHandle });
  if (r.held) process.exitCode = 2;
}

function cmdRelease(c) {
  const me = resolveSelf(c);
  const resource = c.positional[0];
  if (!resource) throw new Error('release 需要 <resource>');
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
      if (e && Number.isFinite(e.ts) && Math.abs(e.ts) <= 8.64e15) entries.push(e);
    } catch { /* 半行/损坏行跳过 */ }
  }
  const latest = entries.slice(-limit).reverse();
  const human = latest.map(e =>
    `${new Date(e.ts).toISOString()}\t${render.sanitize(e.actor)}\t${render.sanitize(e.action)}\t${render.sanitize(e.detail, 200)}`
  ).join('\n') || '（无审计记录）';
  out(c, human + '\n', latest);
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
    strong: r.strong, weak: r.weak, total: r.total,
    reader: me.sessionId, pluginRoot: process.env.KIMI_PLUGIN_ROOT || '.',
  });
  process.stdout.write((block ? block + '\n' : '') + JSON.stringify(payload) + '\n');
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

function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} 需要正整数，收到 ${raw}`);
  return n;
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
      // 按 watcherPid 精确清除：别清掉同一窗口后来者的登记
      identity.clearWatcher(c.db, { tuiPid: me.tuiPid, watcherPid: process.pid });
      claims.syncMarker(c.db, { kimiHome: c.home, now: Date.now() });
      appendLog(c.home, { actor: me.sessionId, action: 'watch-stop', detail: `${code} ${reason}` });
    } catch { /* fail-open：清理失败不能改写退出码 */ }
    if (poke) { try { poke.close(); } catch { /* 已经关了 */ } }
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
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
  try {
    const { flags, positional } = parseArgs(process.argv.slice(3));
    const done = COMMANDS[name](ctx(flags, positional));
    // watch 是 async：它里面的同步 throw 会变成 rejection，退出码的记账必须照样走到
    // （顶层 await 会要求整段改写成 async 入口，没必要）。
    if (done && typeof done.then === 'function') done.then(undefined, fail);
  } catch (err) {
    fail(err);
  }
}
