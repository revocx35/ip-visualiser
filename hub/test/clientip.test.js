import test from 'node:test';
import assert from 'node:assert/strict';

import { clientIpFrom } from '../src/clientip.js';

test('behind a proxy the right-most X-Forwarded-For hop is the client', () => {
  // NPM appends the real peer to whatever the client sent.
  const headers = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' };
  assert.equal(clientIpFrom(headers, '172.18.0.2', true), '203.0.113.9');
});

test('a spoofed left-most entry cannot rotate the throttle key', () => {
  const a = clientIpFrom({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }, '172.18.0.2', true);
  const b = clientIpFrom({ 'x-forwarded-for': '2.2.2.2, 203.0.113.9' }, '172.18.0.2', true);
  assert.equal(a, b);
});

test('without TRUST_PROXY the header is ignored', () => {
  assert.equal(clientIpFrom({ 'x-forwarded-for': '1.1.1.1' }, '::ffff:192.168.1.4', false), '192.168.1.4');
  assert.equal(clientIpFrom({}, '192.168.1.4', true), '192.168.1.4');
});
