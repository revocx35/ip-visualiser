import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_VIEW_ALLOW, ipInCidr, isViewAllowed, parseCidrs } from '../src/viewallow.js';

test('CIDR matching covers the LAN ranges the view port exists for', () => {
  assert.equal(ipInCidr('192.168.1.54', '192.168.0.0/16'), true);
  assert.equal(ipInCidr('192.168.1.54', '192.168.1.0/24'), true);
  assert.equal(ipInCidr('192.168.2.54', '192.168.1.0/24'), false);
  assert.equal(ipInCidr('10.4.4.4', '10.0.0.0/8'), true);
  assert.equal(ipInCidr('172.17.0.1', '172.16.0.0/12'), true);
  assert.equal(ipInCidr('172.32.0.1', '172.16.0.0/12'), false);
});

test('public addresses are refused by the default allow list', () => {
  const allow = parseCidrs();
  assert.deepEqual(allow, DEFAULT_VIEW_ALLOW.split(','));
  for (const ip of ['8.8.8.8', '1.1.1.1', '45.33.32.156', '2001:4860:4860::8888']) {
    assert.equal(isViewAllowed(ip, allow), false, ip);
  }
  for (const ip of ['192.168.1.9', '127.0.0.1', '10.1.2.3', 'fd00::5', '::1']) {
    assert.equal(isViewAllowed(ip, allow), true, ip);
  }
});

test('v4-mapped v6 peers and exact /32 rules behave', () => {
  assert.equal(ipInCidr('::ffff:192.168.1.52', '192.168.0.0/16'), true);
  assert.equal(ipInCidr('::ffff:8.8.8.8', '192.168.0.0/16'), false);
  assert.equal(ipInCidr('192.168.1.54', '192.168.1.54/32'), true);
  assert.equal(ipInCidr('192.168.1.55', '192.168.1.54/32'), false);
  assert.equal(ipInCidr('203.0.113.9', '0.0.0.0/0'), true);
});

test('junk input never grants access', () => {
  for (const entry of [
    ['', '192.168.0.0/16'],
    [null, '192.168.0.0/16'],
    ['not-an-ip', '192.168.0.0/16'],
    ['192.168.1.1', 'garbage'],
    ['192.168.1.1', '192.168.0.0/99'],
    ['192.168.1.1', '192.168.0.0/abc'],
  ]) {
    assert.equal(ipInCidr(entry[0], entry[1]), false, String(entry));
  }
  assert.equal(isViewAllowed('192.168.1.1', []), false);
});
