import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEvent, targetHost } from '../src/authentik.js';

const failed = {
  pk: '13a4c6cc-f9da-4bb2-b126-fc3086a57d3f',
  action: 'login_failed',
  client_ip: '81.2.69.142',
  created: '2026-10-25T19:20:05.474444Z',
  user: { username: 'someone@example.com', email: 'someone@example.com' },
  context: {
    username: 'someone@example.com',
    password: '********',
    http_request: {
      args: {
        next: '/application/o/authorize/?client_id=x&redirect_uri=https%3A%2F%2Fapp.example.com%2Foutpost.goauthentik.io%2Fcallback&response_type=code',
      },
    },
  },
};

test('normalises a failed login', () => {
  const row = normalizeEvent(failed, 3);
  assert.equal(row.action, 'login_failed');
  assert.equal(row.username, 'someone@example.com');
  assert.equal(row.clientIp, '81.2.69.142');
  assert.equal(row.serverId, 3);
  assert.equal(row.app, 'app.example.com');
  assert.equal(row.ts, Math.floor(Date.parse(failed.created) / 1000));
});

test('normalises a successful login', () => {
  const ok = {
    pk: 'abc',
    action: 'login',
    client_ip: '198.51.100.7',
    created: '2026-10-25T19:00:00Z',
    user: { username: 'Revocx' },
    context: { auth_method: 'password' },
  };
  const row = normalizeEvent(ok, null);
  assert.equal(row.username, 'Revocx');
  assert.equal(row.action, 'login');
  assert.equal(row.serverId, null);
  assert.equal(row.app, null);
});

test('ignores non-login events', () => {
  assert.equal(normalizeEvent({ action: 'model_created', created: '2026-10-25T19:00:00Z' }, 1), null);
  assert.equal(normalizeEvent({ action: 'login', created: 'not-a-date' }, 1), null);
  assert.equal(normalizeEvent(null, 1), null);
});

test('never carries the password field', () => {
  const row = normalizeEvent(failed, 1);
  assert.equal(Object.values(row).some((v) => String(v).includes('****')), false);
});

test('the target host comes out of the nested redirect_uri', () => {
  assert.equal(
    targetHost({ redirect_uri: 'https://app.example.com/outpost.goauthentik.io/callback?x=1' }),
    'app.example.com',
  );
  assert.equal(
    targetHost({ next: '/application/o/authorize/?redirect_uri=https%3A%2F%2Fa.example.org%2Fcb' }),
    'a.example.org',
  );
  assert.equal(targetHost({}), null);
  assert.equal(targetHost(null), null);
});

test('the authentik host itself is not reported as the target app', () => {
  const row = normalizeEvent(failed, 1, { ownHost: 'app.example.com' });
  assert.equal(row.app, null);
});

// A burst bigger than MAX_PAGES * PAGE_SIZE (500) must not lose the events past page 5.
test('poller keeps every event of a burst larger than five pages', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { openDb } = await import('../src/db.js');
  const { createAuthentikPoller } = await import('../src/authentik.js');
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ipvis-ak-')), 'ak.db'));

  const base = Date.parse('2026-10-31T10:00:00.000Z');
  const all = Array.from({ length: 730 }, (_, i) => ({
    pk: `e${i}`,
    action: 'login_failed',
    client_ip: '81.2.69.142',
    created: new Date(base + i * 1000).toISOString(),
    context: { username: `u${i}` },
  }));

  // Minimal authentik: filters on created__gte, honours ordering and page/page_size.
  const fetchJson = async (url) => {
    const u = new URL(url);
    const action = u.searchParams.get('action');
    const since = u.searchParams.get('created__gte');
    const size = Number(u.searchParams.get('page_size'));
    const page = Number(u.searchParams.get('page') || 1);
    let rows = all.filter((e) => e.action === action && e.created >= since);
    rows.sort((a, b) => (a.created < b.created ? -1 : 1));
    if (u.searchParams.get('ordering') === '-created') rows.reverse();
    return {
      pagination: { total_pages: Math.ceil(rows.length / size) || 1 },
      results: rows.slice((page - 1) * size, page * size),
    };
  };

  const poller = createAuthentikPoller({
    db,
    log: { info() {}, warn() {} },
    baseUrl: 'https://ak.example',
    token: 't',
    backfillHours: 24 * 365 * 10,
    fetchJson,
  });
  poller.loadCursor();
  await poller.poll();
  await poller.poll();
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM auth_events').get().n);
  assert.equal(n, all.length);
});
