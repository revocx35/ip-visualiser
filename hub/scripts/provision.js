#!/usr/bin/env node
// Provision a server + agent without the web UI (useful for automated deploys, or before
// the admin account exists). The hub's setup flow is untouched: this only writes rows.
//
//   node scripts/provision.js --server home --lat 41.0479 --lon 28.9773 --color '#35e0ff' \
//        --agent homelab
//
// Prints JSON: { serverId, agentId, name, token }. Treat the token like a password.

import crypto from 'node:crypto';
import { openDb } from '../src/db.js';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const dbPath = process.env.DB_PATH || '/data/ipvis.db';
const db = openDb(dbPath);

if (arg('list')) {
  const servers = db.prepare('SELECT id, name, lat, lon, color FROM servers ORDER BY id').all();
  const agents = db.prepare('SELECT id, server_id, name, last_seen, events_total FROM agents ORDER BY id').all();
  console.log(JSON.stringify({ servers, agents }, null, 1));
  process.exit(0);
}

const name = arg('server');
if (!name || name === true) {
  console.error('usage: provision.js --server NAME --lat N --lon N [--color #rrggbb] [--agent NAME]');
  process.exit(2);
}
const lat = Number(arg('lat', '0'));
const lon = Number(arg('lon', '0'));
if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
  console.error('lat/lon are required and must be valid');
  process.exit(2);
}
const color = arg('color', null);
const agentName = arg('agent', name);

let server = db.prepare('SELECT * FROM servers WHERE name = ?').get(name);
if (!server) {
  const info = db
    .prepare('INSERT INTO servers(name, lat, lon, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, lat, lon, color && color !== true ? color : null, Math.floor(Date.now() / 1000));
  server = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(info.lastInsertRowid));
} else {
  db.prepare('UPDATE servers SET lat = ?, lon = ?, color = ? WHERE id = ?').run(
    lat,
    lon,
    color && color !== true ? color : server.color,
    server.id,
  );
  server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
}

const token = crypto.randomBytes(24).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const existingAgent = db.prepare('SELECT * FROM agents WHERE server_id = ? AND name = ?').get(server.id, agentName);
let agentId;
if (existingAgent) {
  db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(tokenHash, existingAgent.id);
  agentId = Number(existingAgent.id);
} else {
  const info = db
    .prepare('INSERT INTO agents(server_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(server.id, agentName, tokenHash, Math.floor(Date.now() / 1000));
  agentId = Number(info.lastInsertRowid);
}

console.log(
  JSON.stringify(
    { serverId: Number(server.id), agentId, name: agentName, token },
    null,
    1,
  ),
);
