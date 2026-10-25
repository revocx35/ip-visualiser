import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  remote_ip TEXT,
  version TEXT,
  events_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS buckets (
  server_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  host TEXT NOT NULL,
  ts_minute INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, ip, host, ts_minute)
);
CREATE INDEX IF NOT EXISTS buckets_ts ON buckets(ts_minute);
CREATE INDEX IF NOT EXISTS buckets_ip ON buckets(ip);

CREATE TABLE IF NOT EXISTS geo (
  ip TEXT PRIMARY KEY,
  private INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lon REAL,
  city TEXT,
  region TEXT,
  country TEXT,
  country_code TEXT,
  looked_up_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  lineColor: '#35e0ff',
  timeWindowMinutes: 120,
  retentionHours: 168,
  showPrivate: false,
};

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
  }
  return db;
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore corrupt value */
    }
  }
  return out;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export function prune(db, retentionHours) {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, retentionHours) * 3600;
  const res = db.prepare('DELETE FROM buckets WHERE ts_minute < ?').run(cutoff);
  const stale = db
    .prepare('DELETE FROM geo WHERE looked_up_at < ?')
    .run(Math.floor(Date.now() / 1000) - 90 * 86400);
  return { buckets: Number(res.changes || 0), geo: Number(stale.changes || 0) };
}
