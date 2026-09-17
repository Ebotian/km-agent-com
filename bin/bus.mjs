#!/usr/bin/env node
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { openDb, appendLog } from '../lib/db.mjs';
import { ALL_TOPIC, normalizeTopic } from '../lib/topic.mjs';
import * as identity from '../lib/identity.mjs';
import * as claims from '../lib/claims.mjs';
import * as posts from '../lib/posts.mjs';
import * as render from '../lib/render.mjs';

// 下游提前关闭（`| head -2`、分页读取）会让异步写抛 EPIPE。此时输出已无人接收，
// 直接退出即可——没有还值得排空的缓冲。但退出码不能丢：命令可能已经置了非零码
// （如 busy/claim 的 2），无条件 exit 0 会把失败报成成功。
// 非 EPIPE 的写错误不能让进程以 0 退出（输出没送达），回落成失败码。
const onStdoutError = (e) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  else process.exitCode = 1;
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
  claim <resource> [--ttl 30m] [--note S]   认领文件/端口/任务（默认 30m）；被占退出 2
  busy <resource>              查占用；被占退出 2
  release <resource>           释放自己的租约
  done <postSeq> [--result S]  完结 task:<seq>，--result 附带一条 finding
  tasks                        列出未认领且未完成的 request
  log [--limit N]              读审计日志（默认 20 条，最新在前）
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

function ctx(flags, positional) {
  const home = flags.home || identity.kimiHome();
  const procRoot = flags['proc-root'] || process.env.AGENT_BUS_PROC_ROOT || identity.DEFAULT_PROC_ROOT;
  const now = flags.now ? Number(flags.now) : Date.now();
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

function parseTtl(s) {
  if (s == null) return 30 * 60_000;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) throw new Error(`无法解析 --ttl: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
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
      if (e && typeof e.ts === 'number') entries.push(e);
    } catch { /* 半行/损坏行跳过 */ }
  }
  const latest = entries.slice(-limit).reverse();
  const human = latest.map(e =>
    `${new Date(e.ts).toISOString()}\t${render.sanitize(e.actor)}\t${render.sanitize(e.action)}\t${render.sanitize(e.detail, 200)}`
  ).join('\n') || '（无审计记录）';
  out(c, human + '\n', latest);
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
};

const name = process.argv[2];
// 用 exitCode 而非 process.exit()：stdout 接管道时写入是异步的，process.exit() 会在
// 缓冲区排空前就退出，输出被截断在管道容量（实测 64KB 正文时 65536 vs 65658 字节）。
if (!name || name === '--help' || !COMMANDS[name]) {
  process.stderr.write(USAGE);
  process.exitCode = 1;
} else {
  try {
    const { flags, positional } = parseArgs(process.argv.slice(3));
    COMMANDS[name](ctx(flags, positional));
  } catch (err) {
    process.stderr.write(`错误: ${err.message}\n`);
    process.exitCode = 1;
  }
}
