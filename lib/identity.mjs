import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeTopic } from './topic.mjs';

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

export function findKimiAncestor(startPid, procRoot = DEFAULT_PROC_ROOT, maxDepth = 16) {
  let pid = startPid;
  const seen = new Set();
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    if (seen.has(pid)) return null;
    seen.add(pid);
    let stat;
    try { stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'); }
    catch { return null; }
    const ppid = parseStatPpid(stat);
    if (ppid == null) return null;
    if (cmdlineRole(readCmdline(ppid, procRoot)) === 'kimi-code') return ppid;
    pid = ppid;
  }
  return null;
}

export function upsertPresence(db, { tuiPid, sessionId, sessionTitle, cwd, handle }) {
  db.prepare(`
    INSERT INTO presence (tui_pid, session_id, session_title, cwd, handle, watcher_pid, watcher_until)
    VALUES (:tuiPid, :sessionId, :sessionTitle, :cwd, :handle, NULL, NULL)
    ON CONFLICT(tui_pid) DO UPDATE SET
      session_id    = excluded.session_id,
      session_title = excluded.session_title,
      cwd           = excluded.cwd,
      handle        = excluded.handle,
      watcher_pid   = NULL,
      watcher_until = NULL
  `).run({ tuiPid, sessionId, sessionTitle: sessionTitle ?? null, cwd, handle });
}

export function removePresence(db, { tuiPid }) {
  db.prepare('DELETE FROM presence WHERE tui_pid = ?').run(tuiPid);
}

export function setWatcher(db, { tuiPid, watcherPid, watcherUntil }) {
  db.prepare('UPDATE presence SET watcher_pid = ?, watcher_until = ? WHERE tui_pid = ?')
    .run(watcherPid, watcherUntil, tuiPid);
}

export function clearWatcher(db, { tuiPid, watcherPid = null }) {
  const sql = watcherPid == null
    ? 'UPDATE presence SET watcher_pid = NULL, watcher_until = NULL WHERE tui_pid = ?'
    : 'UPDATE presence SET watcher_pid = NULL, watcher_until = NULL WHERE tui_pid = ? AND watcher_pid = ?';
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

export function listPresence(db, { now, procRoot = DEFAULT_PROC_ROOT }) {
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

export function handleFromCwd(db, cwd) {
  const base = normalizeTopic(cwd.replace(/\/+$/, '').split('/').pop() ?? '');
  const taken = new Set(db.prepare('SELECT handle FROM presence').all().map(r => r.handle));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  throw new Error(`handle 冲突过多: ${base}`);
}

export function reapDead(db, { procRoot = DEFAULT_PROC_ROOT } = {}) {
  const rows = db.prepare('SELECT tui_pid FROM presence').all();
  let n = 0;
  for (const r of rows) {
    if (!pidHasRole(r.tui_pid, 'kimi-code', procRoot)) {
      removePresence(db, { tuiPid: r.tui_pid });
      n++;
    }
  }
  return n;
}
