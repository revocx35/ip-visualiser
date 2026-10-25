import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGeoResolver } from '../src/geo.js';
import { openDb } from '../src/db.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipvis-geo-'));
  return openDb(path.join(dir, 'geo.db'));
}

test('unresolvable addresses are never sent to the provider', () => {
  const db = tempDb();
  const geo = createGeoResolver(db, { provider: 'ip-api' });
  assert.deepEqual(geo.resolve('192.168.1.53'), { private: true, ip: '192.168.1.53' });
  assert.deepEqual(geo.resolve('127.0.0.1'), { private: true, ip: '127.0.0.1' });
  assert.equal(geo.stats().pending, 0, 'private ranges do not enter the queue');
  geo.stop();
});

test('a cold public address is queued once and answered from the offline fallback', () => {
  const db = tempDb();
  const geo = createGeoResolver(db, { provider: 'ip-api' });
  const first = geo.resolve('8.8.8.8');
  assert.equal(first.private, false);
  assert.equal(geo.stats().pending, 1);
  const row = db.prepare('SELECT source FROM geo WHERE ip = ?').get('8.8.8.8');
  assert.equal(row.source, 'offline', 'immediate answer is marked as the offline source');

  geo.resolve('8.8.8.8');
  assert.equal(geo.stats().pending, 1, 'the same address is not queued twice');
  geo.stop();
});

test('fresh online rows are served from cache without queueing', () => {
  const db = tempDb();
  const geo = createGeoResolver(db, { provider: 'ip-api' });
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO geo(ip, private, lat, lon, city, region, country, country_code, isp, source, looked_up_at)
     VALUES ('85.214.132.117', 0, 52.52, 13.44, 'Berlin', 'Berlin', 'Germany', 'DE', 'Hetzner', 'ip-api', ?)`,
  ).run(now);
  const hit = geo.resolve('85.214.132.117');
  assert.equal(hit.city, 'Berlin');
  assert.equal(hit.countryCode, 'DE');
  assert.equal(hit.isp, 'Hetzner');
  assert.equal(geo.stats().pending, 0);
  geo.stop();
});

test('rows written before the online provider are treated as stale', () => {
  const db = tempDb();
  const geo = createGeoResolver(db, { provider: 'ip-api' });
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO geo(ip, private, lat, lon, city, region, country, country_code, looked_up_at)
     VALUES ('203.0.113.7', 0, 55.75, 37.62, 'Moscow', NULL, 'RU', 'RU', ?)`,
  ).run(now);
  geo.resolve('203.0.113.7');
  assert.equal(geo.stats().pending, 1, 'a source-less row is queued for a real lookup');
  geo.stop();
});

test('the offline provider never queues anything', () => {
  const db = tempDb();
  const geo = createGeoResolver(db, { provider: 'offline' });
  const hit = geo.resolve('8.8.8.8');
  assert.equal(hit.private, false);
  assert.equal(geo.stats().pending, 0);
  assert.equal(geo.stats().provider, 'offline');
  geo.stop();
});

test('stale online rows expire after the ttl', () => {
  const db = tempDb();
  const geo = createGeoResolver(db, { provider: 'ip-api', ttlDays: 1 });
  const old = Math.floor(Date.now() / 1000) - 2 * 86400;
  db.prepare(
    `INSERT INTO geo(ip, private, lat, lon, city, region, country, country_code, isp, source, looked_up_at)
     VALUES ('81.2.69.142', 0, 51.75, -0.32, 'St Albans', NULL, 'United Kingdom', 'GB', NULL, 'ip-api', ?)`,
  ).run(old);
  geo.resolve('81.2.69.142');
  assert.equal(geo.stats().pending, 1);
  geo.stop();
});
