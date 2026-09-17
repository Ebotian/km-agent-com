import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

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

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}
