#!/usr/bin/env node
// agent-bus 与引擎的唯一接触面：4 个事件走同一个入口（spec §8.2）。
//
// 这四件事里只有 PreToolUse 保证**正确性**：它挂在访问点上，别人占了你要碰的资源就
// 拒绝这次调用（"做不成"），比任何"通知"（"被告知别做"）都强。其余三个都是尽力而为的
// 副作用与投递，所以整个流程 fail-open——总线一挂绝不能卡死所有窗口的工具调用。
import { join } from 'node:path';
import { openDb, appendLog } from '../lib/db.mjs';
import { topicFromCwd } from '../lib/topic.mjs';
import * as identity from '../lib/identity.mjs';
import * as posts from '../lib/posts.mjs';
import * as claims from '../lib/claims.mjs';
import * as render from '../lib/render.mjs';

// stdout 就是注入进 agent 上下文的内容（UserPromptSubmit），而它写的是管道：下游提前
// 关闭会抛 EPIPE。那是"没人收"，既不该把进程崩掉，也不该改写退出码——唯一允许的非零码
// 是 PreToolUse 的 2。stderr 同理（它是尽力而为的说明通道）。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const EVENTS = new Set(['SessionStart', 'SessionEnd', 'PreToolUse', 'UserPromptSubmit']);

const pluginRoot = process.env.KIMI_PLUGIN_ROOT || '.';

function readStdin() {
  return new Promise((resolve) => {
    // 引擎按 spec F10 必然把载荷 pipe 进来。stdin 是 TTY 只说明载荷根本没来（比如 hook 被
    // 手工拉起、或引擎把终端直接继承给了子进程）——那就别在这里等一个永远不会到的 EOF：
    // PreToolUse 挂在每次工具调用的关键路径上，干等只会白等一次引擎的 hook timeout。
    if (process.stdin.isTTY) { resolve(''); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

/**
 * 本窗口的 tui_pid：`AGENT_BUS_TUI_PID` 显式指定优先（测试与降级用），否则
 * 沿 /proc/<pid>/stat 向上找 cmdline 为 kimi-code 的祖先（hook 是 shell 拉起的，
 * 直接父进程是 /bin/sh，所以必须遍历）。
 */
function selfTuiPid(procRoot) {
  const forced = Number(process.env.AGENT_BUS_TUI_PID);
  if (Number.isInteger(forced) && forced > 0) return forced;
  return identity.findKimiAncestor(process.ppid, procRoot);
}

/** 从 PreToolUse 载荷里抠出本次要触碰的绝对路径；抠不出来就返回 []（放行） */
function touchedPaths(payload) {
  const ti = payload.tool_input ?? {};
  const out = new Set();
  if (typeof ti.file_path === 'string') out.add(ti.file_path);
  if (Array.isArray(ti.file_paths)) for (const p of ti.file_paths) if (typeof p === 'string') out.add(p);
  if (typeof ti.command === 'string') {
    for (const m of ti.command.matchAll(/(?:^|[\s'"=])(\/[^\s'"|;&<>()]+)/g)) out.add(m[1]);
  }
  return [...out].filter(p => p.startsWith('/') && !p.startsWith('/dev/') && !p.startsWith('/proc/'));
}

function sessionStart(db, { payload, sid, tuiPid, cwd, home, procRoot }) {
  // R-H2：算 handle 与写 presence 之间不能有间隙，否则同 cwd 的并发窗口会撞名；而且
  // handleFromCwd 会把本窗口**自己已存在的那一行**当成"别人占了"，同一窗口每次 /new
  // 都会抖动 handle（agent-com → agent-com-2 → agent-com）。registerPresence 把两者
  // 收进同一个 BEGIN IMMEDIATE，并排除自身那一行。
  identity.registerPresence(db, {
    tuiPid, sessionId: sid, sessionTitle: payload.session_title ?? null, cwd,
  });
  try {
    // "房间隔离"的全部实现就是这一条默认订阅，不是规则
    posts.subscribe(db, { reader: sid, pattern: topicFromCwd(cwd) });
  } catch { /* cwd 推不出主题时只登记 presence */ }
  // spec §8.1：被 SIGKILL 的窗口不会有 SessionEnd，清扫搭在别的动作上顺带完成
  identity.reapDead(db, { procRoot });
  appendLog(home, { actor: sid || '?', action: 'session-start', detail: `${tuiPid} ${cwd}` });
  return 0;
}

function sessionEnd(db, { sid, tuiPid, home, now }) {
  if (tuiPid != null) identity.removePresence(db, { tuiPid });
  // R-E4：只回收**未完结**的租约。直接 `DELETE ... WHERE holder_session = ?` 会把
  // completed_at 非空的行一并删掉，于是已做完的一次性任务复活、变回可认领。
  claims.releaseAllForSession(db, { holderSession: sid });
  claims.syncMarker(db, { kimiHome: home, now });
  appendLog(home, { actor: sid || '?', action: 'session-end', detail: String(tuiPid) });
  return 0;
}

function preToolUse(db, { paths, sid, now }) {
  if (paths.length === 0) return 0;
  const hits = claims.conflicts(db, { paths, session: sid, now });
  if (hits.length === 0) return 0;
  // 文案进的是模型的上下文，所以两个插值都过 sanitize：resource 来自 `bus claim <resource>`
  // 的自由文本，holder 是 session_id——控制字符/换行/伪造标签都不该从这里漏进上下文。
  const lines = hits.map(h => `  ${render.sanitize(h.resource, 300)} —— 由 ${render.sanitize(h.holder)} 持有至 ${new Date(h.leaseUntil).toISOString()}`);
  process.stderr.write(
    `agent-bus: 以下资源已被其他窗口占用，本次操作被拒绝：\n${lines.join('\n')}\n` +
    `请等对方释放，或先与它协商（node ${pluginRoot}/bin/bus.mjs peers）。\n`
  );
  // L0 的强制力就来自这个 2：工具被拒，说明进上下文
  return 2;
}

function userPromptSubmit(db, { sid, now, procRoot }) {
  const r = posts.poll(db, { reader: sid });
  const peer = identity.listPresence(db, { now, procRoot }).find(p => p.sessionId === sid);
  // R4：`deaf === null` 是"在听"这个哨兵，只能用三元兜底——`?? 'never'` 只在 null/undefined
  // 上兜底，会把健康窗口误报成"从未武装"。
  const block = render.digestBlock({
    strong: r.strong, weak: r.weak, total: r.total,
    reader: sid, pluginRoot, deaf: peer ? peer.deaf : 'never',
  });
  // 投了就推进游标：同一条消息不该在每次用户说话时重复注入
  if (r.total > 0) posts.ack(db, { reader: sid, seq: r.nextCursor });
  if (block) process.stdout.write(block + '\n');
  return 0;
}

async function main() {
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { return 0; }
  if (!payload || typeof payload !== 'object') return 0;
  const event = payload.hook_event_name;
  if (!EVENTS.has(event)) return 0;

  const home = identity.kimiHome();
  const procRoot = process.env.AGENT_BUS_PROC_ROOT || identity.DEFAULT_PROC_ROOT;
  const now = Date.now();
  const dbPath = join(home, 'agent-bus', 'bus.db');
  const sid = typeof payload.session_id === 'string' ? payload.session_id : '';

  if (event === 'SessionStart') {
    const tuiPid = selfTuiPid(procRoot);
    // 认不出自己是哪个窗口就别乱写：写进去的行没有任何人能回收
    if (tuiPid == null) return 0;
    const cwd = payload.cwd || process.cwd();
    return sessionStart(openDb(dbPath), { payload, sid, tuiPid, cwd, home, procRoot });
  }

  if (event === 'SessionEnd') {
    return sessionEnd(openDb(dbPath), { sid, tuiPid: selfTuiPid(procRoot), home, now });
  }

  if (event === 'PreToolUse') {
    const paths = touchedPaths(payload);
    // 抠不出路径就连库都不开：这条路径挂在每次工具调用的关键路径上（node 冷启动 ~40ms）
    if (paths.length === 0) return 0;
    return preToolUse(openDb(dbPath), { paths, sid, now });
  }

  return userPromptSubmit(openDb(dbPath), { sid, now, procRoot });
}

// R-S1：绝不用 `process.exit()`——stdout 就是注入进上下文的内容，exit 会丢掉尚未排空的
// 异步缓冲，表现是一段 digest 被静默截断。`exitCode` 让进程自然退出；引擎自己有 hook
// timeout，不必担心挂死。
main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    // 唯一的非零码是 PreToolUse 的冲突分支，异常一律放行
    process.stderr.write(`agent-bus hook 失败（已放行）: ${err.message}\n`);
    process.exitCode = 0;
  });
