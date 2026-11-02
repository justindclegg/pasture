import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'team',
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, slug)
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  html TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  author_kind TEXT NOT NULL DEFAULT 'user',
  author_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(space_id, n)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  version_n INTEGER NOT NULL,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL DEFAULT 'user',
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  anchor_json TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS state (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, key)
);
CREATE TABLE IF NOT EXISTS stream_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  stream TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_stream ON stream_points(space_id, stream, id);
CREATE INDEX IF NOT EXISTS idx_comments ON comments(space_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS spaces_fts USING fts5(
  title, body, comments, space_id UNINDEXED, tokenize = 'porter unicode61'
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Strip an HTML document down to readable text for search indexing. */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function reindexSpace(db, spaceId) {
  const s = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId);
  db.prepare('DELETE FROM spaces_fts WHERE space_id = ?').run(spaceId);
  if (!s) return;
  const v = db.prepare('SELECT html FROM versions WHERE space_id = ? AND n = ?').get(spaceId, s.current_version);
  const comments = db
    .prepare('SELECT body FROM comments WHERE space_id = ?')
    .all(spaceId)
    .map((c) => c.body)
    .join('\n');
  db.prepare('INSERT INTO spaces_fts (title, body, comments, space_id) VALUES (?, ?, ?, ?)').run(
    s.title,
    v ? htmlToText(v.html) : '',
    comments,
    spaceId
  );
}

/** Turn free text into a safe FTS5 query: every word must match, last word as prefix. */
export function ftsQuery(q) {
  const words = String(q)
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!words || !words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}
