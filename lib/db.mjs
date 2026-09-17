import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA_VERSION = 1;

/**
 * `Date` 能表示的最大毫秒数（±275760-09-13）。时间戳列是 int64，SQLite 收得下更大的数，
 * 但 `new Date(x).toISOString()` 会抛 `RangeError`：一旦这样的值落库，读它的那条命令就从
 * 「被占用」（2）掉成「用法错」（1），或被 hook 的 fail-open 吞成"放行"。
 *
 * 上界只在这里定义一份——CLI 的 `--now` 守卫、hook 的租约文案兜底、`log` 的坏行过滤
 * 三处引用它。分散的字面量副本正是它一开始各处不一致的原因。
 */
export const DATE_MAX_MS = 8.64e15;

const DDL = `
CREATE TABLE IF NOT EXISTS presence (
  tui_pid       INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL,
  session_title TEXT,
  cwd           TEXT NOT NULL,
  handle        TEXT NOT NULL,
  watcher_pid   INTEGER,
  watcher_until INTEGER
);

CREATE TABLE IF NOT EXISTS posts (
  seq            INTEGER PRIMARY KEY,
  topic          TEXT NOT NULL,
  author_session TEXT NOT NULL,
  author_cwd     TEXT,
  origin         TEXT NOT NULL CHECK (origin IN ('human','agent')),
  kind           TEXT NOT NULL CHECK (kind IN ('request','finding')),
  to_session     TEXT,
  title          TEXT NOT NULL,
  body           TEXT,
  reply_to       INTEGER,
  ts             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_topic_seq ON posts(topic, seq);

CREATE TABLE IF NOT EXISTS claims (
  resource       TEXT PRIMARY KEY,
  holder_session TEXT NOT NULL,
  lease_until    INTEGER NOT NULL,
  completed_at   INTEGER,
  note           TEXT
);

CREATE TABLE IF NOT EXISTS read_cursor (
  reader_session TEXT PRIMARY KEY,
  last_seq       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subs (
  reader_session TEXT NOT NULL,
  pattern        TEXT NOT NULL,
  PRIMARY KEY (reader_session, pattern)
);
`;

export function migrate(db) {
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

const SQLITE_BUSY = 5;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

// 切 WAL 要拿独占锁，而 SQLite 对这条锁升级路径不调 busy handler（deadlock avoidance，见
// sqlite3_busy_handler 文档），busy_timeout 在这里不起作用，必须自己重试。第一个进程转换
// 完成后，其余进程重试时已是 no-op。
function switchToWal(db) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if ((err.errcode & 0xff) !== SQLITE_BUSY || Date.now() >= deadline) throw err;
      sleepSync(5);
    }
  }
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  switchToWal(db);
  migrate(db);
  return db;
}

export function appendLog(kimiHome, { actor, action, detail = '' }) {
  const dir = join(kimiHome, 'agent-bus');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ts: Date.now(), actor, action, detail }) + '\n';
  appendFileSync(join(dir, 'log.jsonl'), line);
}
