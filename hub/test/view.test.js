// The view-only API is a wall-display surface: it must serve the map feed and refuse
// everything else, including every write verb.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { LoginThrottle } from '../src/auth.js';
import { createGeoResolver } from '../src/geo.js';
import { buildApi, HttpError } from '../src/api.js';

function fakeCtx(method, pathname, search = '') {
  const url = new URL(`http://view.local${pathname}${search}`);
  const captured = { status: 0, headers: {}, body: '' };
  const res = {
    headersSent: false,
    setHeader(name, value) {
      captured.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      captured.status = status;
      Object.assign(captured.headers, headers || {});
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) captured.body += chunk;
      return this;
    },
  };
  return { ctx: { req: { headers: {} }, res, url, body: null, user: null, clientIp: '192.168.1.52', secure: false, method }, captured };
}

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipvis-view-'));
  const db = openDb(path.join(dir, 'view.db'));
  const server = db.prepare("INSERT INTO servers(name, lat, lon, created_at) VALUES ('home', 1, 1, 0)").run();
  const serverId = Number(server.lastInsertRowid);
  db.prepare('INSERT INTO agents(server_id, name, token_hash, created_at) VALUES (?, ?, ?, 0)').run(serverId, 'homelab', 'x');
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO buckets(server_id, ip, host, ts_minute, count, bytes) VALUES (?, ?, ?, ?, ?, 0)').run(
    serverId,
    '8.8.8.8',
    'example.com',
    now,
    3,
  );
  const silent = { info() {}, warn() {}, error() {} };
  const geo = createGeoResolver(db, { provider: 'offline', log: silent });
  const viewApi = buildApi({ db, throttle: new LoginThrottle(), log: silent, geo, version: '9.9.9', viewOnly: true });
  const fullApi = buildApi({ db, throttle: new LoginThrottle(), log: silent, geo, version: '9.9.9' });
  return { db, serverId, viewApi, fullApi };
}

async function call(api, method, pathname, search) {
  const { ctx, captured } = fakeCtx(method, pathname, search);
  try {
    await api(ctx);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    captured.status = err.status;
    captured.body = JSON.stringify({ error: err.message });
  }
  return captured;
}

test('the map feed is public on the view listener and carries the same payload', async () => {
  const { viewApi } = harness();
  const res = await call(viewApi, 'GET', '/api/view', '?window=60');
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.windowMinutes, 60);
  assert.equal(payload.servers.length, 1);
  assert.equal(payload.connections[0].ip, '8.8.8.8');
  assert.deepEqual(Object.keys(payload.stats).sort(), ['distinctIpHosts', 'events', 'lines', 'topHosts']);
});

test('HEAD is accepted for the map feed', async () => {
  const { viewApi } = harness();
  const res = await call(viewApi, 'HEAD', '/api/view');
  assert.equal(res.status, 200);
});

test('the same feed needs a session on the authenticated listener', async () => {
  const { fullApi } = harness();
  const res = await call(fullApi, 'GET', '/api/state');
  assert.equal(res.status, 401);
});

test('the per-server address list is read-only-public', async () => {
  const { viewApi, serverId } = harness();
  const ok = await call(viewApi, 'GET', `/api/servers/${serverId}/connections`, '?minutes=60');
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).items[0].ip, '8.8.8.8');
});

test('writes and admin routes are not part of the view listener', async () => {
  const { viewApi, serverId } = harness();
  for (const [method, pathname] of [
    ['POST', '/api/setup'],
    ['POST', '/api/login'],
    ['POST', '/api/servers'],
    ['PATCH', '/api/settings'],
    ['PATCH', `/api/servers/${serverId}`],
    ['DELETE', `/api/servers/${serverId}`],
    ['POST', '/api/agents/1/rotate'],
  ]) {
    const res = await call(viewApi, method, pathname);
    assert.equal(res.status, 405, `${method} ${pathname}`);
  }
  for (const pathname of ['/api/settings', '/api/state', '/api/me', '/api/bootstrap', '/api/nope']) {
    const res = await call(viewApi, 'GET', pathname);
    assert.equal(res.status, 404, `GET ${pathname}`);
  }
  // health stays, so a monitor can watch the kiosk port without a session
  const health = await call(viewApi, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).version, '9.9.9');
});

test('the view listener leaves the database untouched', async () => {
  const { db, viewApi, serverId } = harness();
  const before = db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
  await call(viewApi, 'POST', `/api/servers/${serverId}`);
  await call(viewApi, 'DELETE', `/api/servers/${serverId}`);
  await call(viewApi, 'PATCH', '/api/settings');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM servers').get().n, before);
});
