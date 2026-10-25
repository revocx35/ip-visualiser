import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSettings, openDb, prune, setSetting } from '../src/db.js';
import { LoginThrottle, hashPassword, hashToken, verifyPassword } from '../src/auth.js';
import { ingestBatch } from '../src/ingest.js';
import { isPrivateIp, normalizeIp } from '../src/geo.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipvis-'));
  const db = openDb(path.join(dir, 'test.db'));
  const server = db.prepare("INSERT INTO servers(name, lat, lon, created_at) VALUES ('home', 1, 1, 0)").run();
  const agent = db
    .prepare('INSERT INTO agents(server_id, name, token_hash, created_at) VALUES (?, ?, ?, 0)')
    .run(Number(server.lastInsertRowid), 'homelab', 'x');
  return { db, dir, serverId: Number(server.lastInsertRowid), agentId: Number(agent.lastInsertRowid) };
}

test('password hashing verifies and rejects', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('token hashing is stable', () => {
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.notEqual(hashToken('abc'), hashToken('abd'));
  assert.equal(hashToken('abc').length, 64);
});

test('login throttle locks after 5 failures and reports retry-after', () => {
  const t = new LoginThrottle();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(t.retryAfter('1.2.3.4'), 0);
    t.fail('1.2.3.4');
  }
  assert.equal(t.retryAfter('1.2.3.4'), 0, 'still free at exactly 5 failures');
  t.fail('1.2.3.4');
  assert.ok(t.retryAfter('1.2.3.4') > 0, 'locked after the sixth');
  assert.equal(t.retryAfter('5.6.7.8'), 0, 'other addresses are unaffected');
  t.succeed('1.2.3.4');
  assert.equal(t.retryAfter('1.2.3.4'), 0);
});

test('settings defaults and overrides round-trip', () => {
  const { db } = tempDb();
  const s = getSettings(db);
  assert.equal(s.retentionHours, 168);
  assert.equal(s.lineColor, '#35e0ff');
  setSetting(db, 'retentionHours', 24);
  assert.equal(getSettings(db).retentionHours, 24);
});

test('ingest rolls events into per-minute buckets', () => {
  const { db, serverId, agentId } = tempDb();
  const now = Math.floor(Date.now() / 1000);
  const agent = { id: agentId, server_id: serverId };
  const res = ingestBatch(db, agent, {
    events: [
      { t: now, ip: '8.8.8.8', host: 'a.example.com', b: 10 },
      { t: now + 5, ip: '8.8.8.8', host: 'a.example.com', b: 20 },
      { t: now, ip: '1.1.1.1', host: 'a.example.com', b: 5 },
      { t: now, ip: '::ffff:9.9.9.9', host: 'b.example.com', b: 1 },
      { t: now, ip: 'not-an-ip', host: 'a.example.com' },
      { t: now, ip: '8.8.4.4', host: '' },
    ],
  });
  assert.equal(res.accepted, 4);
  assert.equal(res.rejected, 2);

  const rows = db.prepare('SELECT ip, host, count, bytes FROM buckets ORDER BY ip').all();
  assert.equal(rows.length, 3);
  const a = rows.find((r) => r.ip === '8.8.8.8');
  assert.equal(Number(a.count), 2);
  assert.equal(Number(a.bytes), 30);
  assert.ok(rows.some((r) => r.ip === '9.9.9.9'), 'v4-mapped v6 addresses are normalised');

  const total = db.prepare('SELECT events_total FROM agents WHERE id = ?').get(agentId);
  assert.equal(Number(total.events_total), 4);
});

test('ingest rejects oversized batches', () => {
  const { db, serverId, agentId } = tempDb();
  const events = Array.from({ length: 5001 }, () => ({ t: 1, ip: '8.8.8.8', host: 'x' }));
  const res = ingestBatch(db, { id: agentId, server_id: serverId }, { events });
  assert.equal(res.accepted, 0);
  assert.ok(res.error);
});

test('retention prune removes only old buckets', () => {
  const { db, serverId, agentId } = tempDb();
  const now = Math.floor(Date.now() / 1000);
  ingestBatch(db, { id: agentId, server_id: serverId }, {
    events: [
      { t: now, ip: '8.8.8.8', host: 'now.example' },
      { t: now - 7200, ip: '8.8.8.8', host: 'old.example' },
    ],
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM buckets').get().n, 2);
  const res = prune(db, 1);
  assert.equal(res.buckets, 1);
  const left = db.prepare('SELECT host FROM buckets').all();
  assert.equal(left.length, 1);
  assert.equal(left[0].host, 'now.example');
});

test('private and loopback addresses are classified', () => {
  for (const ip of ['10.0.0.1', '192.168.1.53', '172.16.4.2', '127.0.0.1', '100.64.1.1', '::1', 'fd00::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '5.6.7.8', '172.32.1.1']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
  assert.equal(normalizeIp('::ffff:8.8.8.8'), '8.8.8.8');
  assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1');
});
