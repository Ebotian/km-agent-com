#!/usr/bin/env node
// agent-bus 与引擎的唯一接触面：4 个事件走同一个入口（spec §8.2）。
//
// 这四件事里只有 PreToolUse 保证**正确性**：它挂在访问点上，别人占了你要碰的资源就
// 拒绝这次调用（"做不成"），比任何"通知"（"被告知别做"）都强。其余三个都是尽力而为的
// 副作用与投递，所以整个流程 fail-open——总线一挂绝不能卡死所有窗口的工具调用。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, appendLog, DATE_MAX_MS } from '../lib/db.mjs';
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

/**
 * 插件根**靠自定位**：从本文件的位置往上推一层（`hooks/` → 插件根）。
 *
 * 不读 `KIMI_PLUGIN_ROOT`：这个变量确实只注入 hook 进程，看起来够用，但它与"哪个脚本
 * 在跑"是两个可以不一致的来源；而且写进 agent 上下文的提示行绝不能依赖"当前进程恰好
 * 有那个变量"——CLI 侧（`bin/bus.mjs`）就是反例，agent 的 `Bash` 环境里没有它，
 * 提示行于是退化成 `node ./bin/bus.mjs …`。同一条自定位规则在两侧各写一次，两边都只
 * 依赖"脚本自己的位置"这一件在任何环境里都成立的事实。
 */
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 读 stdin 必须是**有界**的（R-T3）。契约形态下（引擎按 spec F10 pipe 进 JSON）'end'
 * 在 20ms 内就到，这条上限不产生任何影响；但没有它，hook 自己就不保证不阻塞——引擎
 * 不给 stdin 时只能靠引擎的 timeout=5 兜底，而 PreToolUse 挂在**每次工具调用**的关键
 * 路径上。到点就用已读到的内容继续（读不到东西则 fail-open）。
 *
 * 这里曾经用过 `isTTY` 快路，**那是错的**：万一引擎改用 pty 投递，载荷会被静默丢掉，
 * PreToolUse 于是对每次调用都拿到空载荷 ⇒ L0 全灭且没有任何信号。
 */
const STDIN_DEADLINE_MS = 2000;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(buf);
    };
    timer = setTimeout(() => {
      // 光"不再等"还不够：stdin 还是开着的句柄，会把进程留在事件循环里 ⇒ "有界"只
      // 体现在解析上、不体现在退出上。先关掉它再收工。
      try { process.stdin.destroy(); } catch { /* 已经关了 */ }
      finish();
    }, STDIN_DEADLINE_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * 本窗口的 tui_pid：`AGENT_BUS_TUI_PID` 显式指定优先（测试与降级用），否则从**自己**往上
 * 沿 /proc 找 cmdline 为 kimi-code 的祖先。
 *
 * 起点必须是 `process.pid` 而不是 `process.ppid`：引擎用 `shell: true` 起 hook，
 * `/bin/sh -c "单条命令"` 会把命令 exec 掉，此时直接父进程**就是**窗口自己——传 ppid 会
 * 让 `resolveWindow` 从窗口的父进程起算，整整跳过一层，认不出自己的窗口。
 */
function selfTuiPid(procRoot) {
  return identity.resolveWindow({ procRoot, pid: process.env.AGENT_BUS_TUI_PID });
}

/** 从 PreToolUse 载荷里抠出本次要触碰的路径；抠不出来就返回 []（放行） */
function touchedPaths(payload) {
  const ti = payload.tool_input ?? {};
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
  const out = new Set();
  // **`path` 是主键，`file_path` / `file_paths` 只为兼容旧载荷保留。**
  // C1：引擎发的就是 `path`——`WriteInputSchema` / `EditInputSchema` 的入参名（见
  // packages/agent-core-v2/.../write.ts、edit.ts），而 `runPreToolUse` 把工具调用
  // 的 args **原样**塞进 `tool_input`。只认 `file_path` 等于：文档里的真实键一律放行，
  // `Write` / `Edit` 这两个最主要的写入工具上，L0 是**静默关闭**的。
  if (typeof ti.path === 'string') out.add(ti.path);
  if (typeof ti.file_path === 'string') out.add(ti.file_path);
  if (Array.isArray(ti.file_paths)) for (const p of ti.file_paths) if (typeof p === 'string') out.add(p);
  if (typeof ti.command === 'string') {
    // 启发式（对 Bash 只有启发式可言，见 README「L0 是唯一的硬约束」）：按 shell 分隔符
    // 切词，取出"看起来像路径"的词——绝对路径、`./`/`../` 开头、以及含 `/` 的词（`lib/db.mjs`
    // 这种相对路径以前整个漏掉）。`2>>` / `>` / `<` 这类重定向前后没有空白，所以再单独扫一遍
    // 重定向目标：紧跟 `>`/`>>`/`<` 的词必是路径（`2>&1` 这种 fd 复制要排除）。
    for (const tok of ti.command.split(/[\s'"|;&()<>`=]+/)) addCommandPath(out, tok);
    for (const m of ti.command.matchAll(/(?<![<>])(?:>>?|<)\s*([^\s'"|;&<>()]+)/g)) addCommandPath(out, m[1]);
  }
  const resolved = [];
  for (const raw of out) {
    const abs = resolveAgainst(raw, cwd);
    if (abs) resolved.push(abs);
  }
  return [...new Set(resolved)].filter(p => !p.startsWith('/dev/') && !p.startsWith('/proc/'));
}

/** 命令里"看起来像路径"的词：选项（`-rf`）、URL、fd 复制（`&1`）都不是路径 */
function addCommandPath(out, tok) {
  if (!tok || tok.startsWith('-') || tok.startsWith('&')) return;
  if (tok.includes('://')) return;                       // URL，不是本机路径
  if (tok.startsWith('/') || tok.startsWith('./') || tok.startsWith('../')) { out.add(tok); return; }
  if (tok.includes('/')) out.add(tok);                   // 相对路径：`lib/db.mjs`
}

/**
 * 路径归一化（I1）。认领侧（`bus claim|busy|release`）也做同一件事，两边必须用同一个
 * 基准，而 `lib/claims.mjs` 的 `conflicts` 是**精确字符串比较**——所以归一化只能发生在
 * 传进去之前：`/p/x/./y`、`/p//x/y`、相对路径本来是三种写法、三个不同的字符串。
 *
 * 没有 `cwd` 时**不猜**：拿 hook 自己的 cwd（插件根）去补相对路径会得到一条永远不会
 * 撞上的路径，那是"看起来拦了、其实没拦"。
 */
function resolveAgainst(p, cwd) {
  try {
    if (p.startsWith('/')) return resolve(p);
    if (!cwd) return null;
    return resolve(cwd, p);
  } catch { return null; }
}

/** 审计明细是有界的：tool_input 里可能有 64KB 正文 */
function boundedJson(value, max = 200) {
  let s;
  try { s = JSON.stringify(value ?? null); } catch { return '(不可序列化)'; }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
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

/**
 * 租约期限的渲染**绝不能抛**（R-T1）。`lease_until` 落在 `(DATE_MAX_MS, 9.007e15]` 时它仍是
 * JS **安全整数**：SQL 侧比较照常（`conflicts` 会正常判出冲突），但 `new Date(lu)`
 * `.toISOString()` 会抛。文案能不能拼出来，绝不能改变"拦不拦"这个判定。
 * 上界取自 `lib/db.mjs`（与 CLI 的 `--now` 守卫同一个常量）。
 */
function leaseLabel(leaseUntil) {
  return Number.isSafeInteger(leaseUntil) && Math.abs(leaseUntil) <= DATE_MAX_MS
    ? new Date(leaseUntil).toISOString()
    : `原值 ${leaseUntil}（超出 Date 表示范围）`;
}

/**
 * R-T1：**先定决策，再拼文案。** 已判定的冲突必须原样返回 2——文案渲染（含 stderr 写入）
 * 整个包在 try/catch 里，异常只影响文案；若让它冒泡到 `main()` 的 fail-open catch，
 * 一次格式化失败就会把"拒绝这次工具调用"降级成"exit 0 + 已放行"，也就是 L0 对该资源
 * 静默失效。
 */
function preToolUse(db, { paths, sid, now }) {
  if (paths.length === 0) return 0;
  const hits = claims.conflicts(db, { paths, session: sid, now });
  if (hits.length === 0) return 0;
  const decision = 2;
  try {
    // 文案进的是模型的上下文，所以两个插值都过 sanitize：resource 来自 `bus claim <resource>`
    // 的自由文本，holder 是 session_id——控制字符/换行/伪造标签都不该从这里漏进上下文。
    const lines = hits.map(h =>
      `  ${render.sanitize(h.resource, 300)} —— 由 ${render.sanitize(h.holder)} 持有至 ${leaseLabel(h.leaseUntil)}`);
    process.stderr.write(
      `agent-bus: 以下资源已被其他窗口占用，本次操作被拒绝：\n${lines.join('\n')}\n` +
      `请等对方释放，或先与它协商（node ${pluginRoot}/bin/bus.mjs peers）。\n`
    );
  } catch {
    // 兜底文案不再碰日期与 sanitize：只点出持有者，够操作者知道去找谁
    try {
      const holders = hits.map(h => String(h.holder)).join('、');
      process.stderr.write(`agent-bus: 以下资源已被其他窗口占用，本次操作被拒绝（持有者: ${holders}）\n`);
    } catch { /* 连兜底都写不出去，也照样拦 */ }
  }
  // L0 的强制力就来自这个 2：工具被拒，说明进上下文
  return decision;
}

function userPromptSubmit(db, { sid, now, procRoot, home, pluginRoot }) {
  const r = posts.poll(db, { reader: sid });
  const peer = identity.listPresence(db, { now, procRoot }).find(p => p.sessionId === sid);
  // R4：`deaf === null` 是"在听"这个哨兵，只能用三元兜底——`?? 'never'` 只在 null/undefined
  // 上兜底，会把健康窗口误报成"从未武装"。
  const block = render.digestBlock({
    strong: r.strong, weak: r.weak, strongHidden: r.strongHidden, weakHidden: r.weakHidden, total: r.total,
    reader: sid, pluginRoot, deaf: peer ? peer.deaf : 'never',
  });
  // 投了就推进游标：同一条消息不该在每次用户说话时重复注入。推到 `ackUpTo` 而不是
  // `nextCursor`——某一轴超过单轮上限时被截掉的那几条还没投出去，推过它们等于永久丢失。
  if (r.total > 0) posts.ack(db, { reader: sid, seq: r.ackUpTo });
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
    // 认不出自己是哪个窗口就别乱写：写进去的行没有任何人能回收。但**不能无声无息**——
    // 这条分支以前连审计都没有（不开库、不写日志），于是"窗口从未登记"在现场什么都不剩：
    // 这次那个"祖先遍历跳过一层"的缺陷就是这样潜伏了整轮，`presence` 一直是空的而没人知道。
    if (tuiPid == null) {
      try {
        appendLog(home, {
          actor: sid || '?', action: 'session-start-unidentified',
          detail: `self=${process.pid} ppid=${process.ppid}` +
            `(${boundedJson(identity.readCmdline(process.ppid, procRoot))})` +
            ` cwd=${payload.cwd || process.cwd()}`,
        });
      } catch { /* 审计写不出去也不该影响退出码 */ }
      return 0;
    }
    const cwd = payload.cwd || process.cwd();
    return sessionStart(openDb(dbPath), { payload, sid, tuiPid, cwd, home, procRoot });
  }

  if (event === 'SessionEnd') {
    return sessionEnd(openDb(dbPath), { sid, tuiPid: selfTuiPid(procRoot), home, now });
  }

  if (event === 'PreToolUse') {
    const paths = touchedPaths(payload);
    if (paths.length === 0) {
      // **抠不出路径时不再是无痕的。** 以前这里是直接 return 0：连库都不开、不留任何日志，
      // 于是"载荷的键名对不上"这类缺陷可以整轮潜伏——文档说 L0 在拦，实际每次调用都放行，
      // 而现场什么都不剩。审计是旁路（写不出去也不该影响放行），成本只有一次 appendFile，
      // 且只在"这次调用我们一点路径都没看懂"时发生。
      try {
        appendLog(home, {
          actor: sid || '?', action: 'pretooluse-no-path',
          detail: `${payload.tool_name ?? '?'} ${boundedJson(payload.tool_input)}`,
        });
      } catch { /* 审计写不出去也要放行 */ }
      // 抠不出路径仍连库都不开：这条路径挂在每次工具调用的关键路径上（node 冷启动 ~40ms）
      return 0;
    }
    return preToolUse(openDb(dbPath), { paths, sid, now });
  }

  return userPromptSubmit(openDb(dbPath), { sid, now, procRoot, home, pluginRoot });
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
