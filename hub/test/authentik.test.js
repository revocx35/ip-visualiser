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
        next: '/application/o/authorize/?client_id=x&redirect_uri=https%3A%2F%2Fimmich.example.com%2Foutpost.goauthentik.io%2Fcallback&response_type=code',
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
  assert.equal(row.app, 'immich.example.com');
  assert.equal(row.ts, Math.floor(Date.parse(failed.created) / 1000));
});

test('normalises a successful login', () => {
  const ok = {
    pk: 'abc',
    action: 'login',
    client_ip: '198.51.100.114',
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
  const row = normalizeEvent(failed, 1, { ownHost: 'immich.example.com' });
  assert.equal(row.app, null);
});
