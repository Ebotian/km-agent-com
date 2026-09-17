import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { topicFromCwd } from './topic.mjs';

export const DEFAULT_PROC_ROOT = '/proc';

export function kimiHome() {
  return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

export function parseStatPpid(statContent) {
  const s = String(statContent);
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const rest = s.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

export function readCmdline(pid, procRoot = DEFAULT_PROC_ROOT) {
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8');
    return raw.replace(/\0+$/, '').replace(/\0/g, ' ').trimEnd();
  } catch { return null; }
}

export function cmdlineRole(cmdline) {
  if (cmdline == null) return null;
  if (/^kimi-code\s*$/.test(cmdline)) return 'kimi-code';
  if (/(^|\s|\/)bus\.mjs\s+watch(\s|$)/.test(cmdline)) return 'bus-watch';
  return null;
}

export function pidEntryExists(pid, procRoot = DEFAULT_PROC_ROOT) {
  return existsSync(join(procRoot, String(pid)));
}

function pidHasRole(pid, role, procRoot) {
  return pidEntryExists(pid, procRoot) && cmdlineRole(readCmdline(pid, procRoot)) === role;
}

/**
 * 从 `startPid` **自己**开始沿 `/proc` 向上找 cmdline 为 `kimi-code` 的进程，返回它的 pid；
 * 找不到返回 null。
 *
 * 起点是**含在链里**的。调用方一律传 `process.pid`（"从我自己往上找"），不必、也不该传
 * `process.ppid` 替实现补一层——**这里曾经正是错的**：实现只查父链、把起点那一层跳过去，
 * 而引擎用 `shell: true` 起 hook，`/bin/sh -c "单条命令"` 会把命令 **exec 掉**，于是 hook
 * 的直接父进程**就是** kimi-code 窗口自己。传 ppid 等于从窗口的父进程开始找，整整跳过一层：
 * 结果是 `SessionStart` 认不出窗口、**静默**不登记（`SessionEnd` 也只留下 `detail: "null"`）。
 *
 * 自包含之后，无论调用方从哪一层起算、也无论中间隔着几个 shell，这条 walk 都能找到同一个
 * 窗口；生产者那条链（hook ← 窗口）只要走上一步就到。
 */
export function findKimiAncestor(startPid, procRoot = DEFAULT_PROC_ROOT, maxDepth = 16) {
  let pid = startPid;
  const seen = new Set();
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    if (seen.has(pid)) return null;
    seen.add(pid);
    if (cmdlineRole(readCmdline(pid, procRoot)) === 'kimi-code') return pid;
    let stat;
    try { stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'); }
    catch { return null; }
    const ppid = parseStatPpid(stat);
    if (ppid == null) return null;
    pid = ppid;
  }
  return null;
}

/** 正整数才是 pid；`0`、空串、非数字一律当作"没给"，不能当成 pid 0 去查库 */
export function asPid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 认领本窗口身份：返回本进程所属的 kimi-code 窗口 pid，认不出返回 null。
 *
 * hook（SessionStart / SessionEnd）与 CLI（`resolveSelf`）共用这一步。抽出来是为了让它
 * **可测**：以前它内联在 hook 里、又被 `AGENT_BUS_TUI_PID` 覆盖掉了那条 walk，于是"跳过
 * 起点一层"这个缺陷在整轮里没有任何用例碰得到。
 *
 * @param procRoot /proc 的根，测试用假 procRoot 注入。
 * @param startPid 从哪里开始往上找。默认 `process.pid`——**不要传 `process.ppid`**，见
 *   `findKimiAncestor` 的注释：起点是含在链里的，传 ppid 会跳过窗口那一层。
 * @param pid 显式指定（hook 的 `AGENT_BUS_TUI_PID` / CLI 的 `--tui-pid`），给测试与降级用；
 *   给了就不查 /proc。非正整数值等同于"没给"。
 */
export function resolveWindow({ procRoot = DEFAULT_PROC_ROOT, startPid = process.pid, pid = null } = {}) {
  const forced = asPid(pid);
  return forced != null ? forced : findKimiAncestor(startPid, procRoot);
}

/**
 * 登记/刷新本窗口那一行（`tui_pid` 是主键 ⇒ 同一窗口永远只有一行）。
 *
 * **watcher 登记只在"会话真的换了"时才清（R-E6）。** 判据与 `removePresence` 是同一句话：
 * "这一行还是我的吗"——`session_id` 与旧值相同（`source=resume` 恢复同一会话）就保留
 * `watcher_pid`/`watcher_until`。无条件清掉的话，旧 watcher 很可能**还在跑**，而窗口被判成
 * "从未武装" ⇒ 自愈逻辑会**再武装一个 watcher** ⇒ 同一窗口两个 watcher 抢同一条消息
 * （每一次命中都是整上下文重读的成本），`peers` 里的 watcher 状态也是假的。
 *
 * 保留的另一半同样重要：如果那个 watcher 其实已经死了，保留登记也没关系——`deafState` 会
 * 判成 `'dead'`，自愈逻辑照样会重新武装。**保留是安全的，清除才是不安全的。**
 *
 * 为什么是一条 SQL 的 `CASE`，而不是"先查再写"或"另起一个事务"：
 * - **没有读写间隙**。判据就在 UPSERT 的 `DO UPDATE` 里求值（`presence.<col>` 指的是**旧行**、
 *   `excluded.<col>` 是新行），所以不存在"查完之后、写之前别人改了行"的窗口；
 * - **不碰事务**。`registerPresence` 已经在 `BEGIN IMMEDIATE` 里调它，SQLite 不支持嵌套事务：
 *   在这里再 `BEGIN IMMEDIATE` 会直接抛，改用 `SAVEPOINT` 则多出一条只在"被事务包着"时才
 *   成立的代码路径。一条语句在两种调用形态下都对；
 * - 副作用是**零额外往返**（比先 SELECT 再写少一次查询）。
 */
export function upsertPresence(db, { tuiPid, sessionId, sessionTitle, cwd, handle }) {
  db.prepare(`
    INSERT INTO presence (tui_pid, session_id, session_title, cwd, handle, watcher_pid, watcher_until)
    VALUES (:tuiPid, :sessionId, :sessionTitle, :cwd, :handle, NULL, NULL)
    ON CONFLICT(tui_pid) DO UPDATE SET
      session_id    = excluded.session_id,
      session_title = excluded.session_title,
      cwd           = excluded.cwd,
      handle        = excluded.handle,
      watcher_pid   = CASE WHEN presence.session_id = excluded.session_id
                           THEN presence.watcher_pid ELSE NULL END,
      watcher_until = CASE WHEN presence.session_id = excluded.session_id
                           THEN presence.watcher_until ELSE NULL END
  `).run({ tuiPid, sessionId, sessionTitle: sessionTitle ?? null, cwd, handle });
}

/**
 * 删掉**本会话自己**那一行；返回删掉的行数（0 = 那一行已经不是我的，什么都没动）。
 *
 * 判据是"那一行还是我的吗"，**不是**"这个 pid 还在吗"。`presence` 以 `tui_pid` 为主键，
 * 而 `/new` 的动作顺序是「先 start 新会话（同一 pid 上 `upsertPresence` 覆盖），**后** end
 * 旧会话」——`SessionEnd` 只按 pid 删的话，删掉的正是新会话刚写好的那一行（连同它刚武装的
 * watcher 登记）：凡走过 `/new` 的窗口都登记不上，`peers`/`whoami`/`claim`/`post` 全部报
 * "本窗口未在 presence 中登记"。
 *
 * `sessionId` 因此是**必填**：按 pid 删的能力留在同一个函数名下，迟早会再被这么用一次。
 * "这个 pid 已经不是活窗口了"是另一条语义（被 SIGKILL 的窗口走这条），用 `reapPresence`。
 */
export function removePresence(db, { tuiPid, sessionId }) {
  if (!sessionId) {
    throw new Error('removePresence 需要 sessionId：只按 tui_pid 删会删掉同一窗口后来者的行');
  }
  return db.prepare('DELETE FROM presence WHERE tui_pid = ? AND session_id = ?')
    .run(tuiPid, sessionId).changes;
}

/**
 * 回收"这个 pid 已经不是活窗口了"的行；返回删掉的行数。
 *
 * **只有这条路径上，"按 pid 删"才是对的**：窗口被 SIGKILL 时不会有 `SessionEnd`，那一行
 * 再没有主人能声明"这是我的"，只能由 pid 的死活来判（`reapDead`）。名字与 `removePresence`
 * 分开，是为了让调用点一眼看得出用的是哪种判据。
 */
export function reapPresence(db, { tuiPid }) {
  return db.prepare('DELETE FROM presence WHERE tui_pid = ?').run(tuiPid).changes;
}

export function setWatcher(db, { tuiPid, watcherPid, watcherUntil }) {
  db.prepare('UPDATE presence SET watcher_pid = ?, watcher_until = ? WHERE tui_pid = ?')
    .run(watcherPid, watcherUntil, tuiPid);
}

/**
 * 清掉 watcher 登记。
 *
 * `keepUntil` 是 M7 的修法：**干净超时退出**（租约用完）必须只清 `watcher_pid`、把已经过期
 * 的 `watcher_until` 留着，否则 `deafState` 会把这次退出报成 `'never'`（"从未武装"）——
 * 那既不是事实，也让 `'expired'`（"超时退出"）这个状态实际不可达：文案把"该重新武装"
 * 说成"你从来没武装过"，运维方向完全不同（前者是时间到了，后者是 skill 没照做）。
 */
export function clearWatcher(db, { tuiPid, watcherPid = null, keepUntil = false }) {
  const set = keepUntil
    ? 'watcher_pid = NULL'
    : 'watcher_pid = NULL, watcher_until = NULL';
  const sql = watcherPid == null
    ? `UPDATE presence SET ${set} WHERE tui_pid = ?`
    : `UPDATE presence SET ${set} WHERE tui_pid = ? AND watcher_pid = ?`;
  db.prepare(sql).run(...(watcherPid == null ? [tuiPid] : [tuiPid, watcherPid]));
}

function deafState(row, { now, procRoot }) {
  if (row.watcherPid == null) {
    if (row.watcherUntil != null && row.watcherUntil <= now) return 'expired';
    return 'never';
  }
  if (!pidHasRole(row.watcherPid, 'bus-watch', procRoot)) return 'dead';
  if (row.watcherUntil != null && row.watcherUntil <= now) return 'expired';
  return null;
}

export function listPresence(db, { now = Date.now(), procRoot = DEFAULT_PROC_ROOT } = {}) {
  return db.prepare(`
    SELECT tui_pid AS tuiPid, session_id AS sessionId, session_title AS sessionTitle,
           cwd, handle, watcher_pid AS watcherPid, watcher_until AS watcherUntil
      FROM presence ORDER BY tui_pid
  `).all().map(row => ({
    ...row,
    alive: pidHasRole(row.tuiPid, 'kimi-code', procRoot),
    deaf: deafState(row, { now, procRoot }),
  }));
}

export function handleFromCwd(db, cwd, { excludeTuiPid = null } = {}) {
  const base = topicFromCwd(cwd);
  const rows = excludeTuiPid == null
    ? db.prepare('SELECT handle FROM presence').all()
    : db.prepare('SELECT handle FROM presence WHERE tui_pid <> ?').all(excludeTuiPid);
  const taken = new Set(rows.map(r => r.handle));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  throw new Error(`handle 冲突过多: ${base}`);
}

export function registerPresence(db, { tuiPid, sessionId, sessionTitle, cwd }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const handle = handleFromCwd(db, cwd, { excludeTuiPid: tuiPid });
    upsertPresence(db, { tuiPid, sessionId, sessionTitle, cwd, handle });
    db.exec('COMMIT');
    return handle;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function reapDead(db, { procRoot = DEFAULT_PROC_ROOT } = {}) {
  const rows = db.prepare('SELECT tui_pid FROM presence').all();
  let n = 0;
  for (const r of rows) {
    if (!pidHasRole(r.tui_pid, 'kimi-code', procRoot)) {
      reapPresence(db, { tuiPid: r.tui_pid });
      n++;
    }
  }
  return n;
}
