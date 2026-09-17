#!/usr/bin/env node
import { join } from 'node:path';
import { openDb, appendLog } from '../lib/db.mjs';
import { normalizeTopic } from '../lib/topic.mjs';
import * as identity from '../lib/identity.mjs';
import * as posts from '../lib/posts.mjs';
import * as render from '../lib/render.mjs';

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
