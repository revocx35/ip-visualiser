import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Tailer, parseLine, parseTimestamp } from '../src/agent.js';

const SAMPLE =
  '[25/Oct/2026:21:19:27 +0300] - 200 200 - GET https photos.example.com "/" [Client 10.0.0.1] [Length 10849] [Gzip -] [Sent-to 10.0.0.5] "Uptime-Kuma/2.5.5" "-"';

test('parses the NPM access log format', () => {
  const ev = parseLine(SAMPLE);
  assert.ok(ev);
  assert.equal(ev.host, 'photos.example.com');
  assert.equal(ev.ip, '10.0.0.1');
  assert.equal(ev.status, 200);
  assert.equal(ev.method, 'GET');
  assert.equal(ev.bytes, 10849);
  assert.equal(ev.path, '/');
  assert.equal(ev.sentTo, '10.0.0.5');
});

test('parses a foreign client with query string and referer', () => {
  const line =
    '[01/Feb/2026:03:04:05 +0000] - 302 302 0.001 POST https app.example.org "/oauth?code=abc" [Client 81.2.69.142] [Length 42] [Gzip -] [Sent-to 10.0.0.9] "Mozilla/5.0" "https://app.example.org/login"';
  const ev = parseLine(line);
  assert.ok(ev);
  assert.equal(ev.ip, '81.2.69.142');
  assert.equal(ev.path, '/oauth?code=abc');
  assert.equal(ev.method, 'POST');
  assert.equal(ev.status, 302);
});

test('timestamps honour the offset', () => {
  const a = parseTimestamp('25/Oct/2026:21:19:27 +0300');
  const b = parseTimestamp('25/Oct/2026:18:19:27 +0000');
  assert.equal(a, b);
  assert.equal(parseTimestamp('nonsense'), null);
});

test('rejects malformed lines instead of throwing', () => {
  assert.equal(parseLine('garbage'), null);
  assert.equal(parseLine('[bad] - 200'), null);
});

test('tailer reads new lines once and follows appends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipvis-agent-'));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const file = path.join(logs, 'proxy-host-7_access.log');
  // Start small so the tailer's initial backlog window covers both lines.
  fs.writeFileSync(file, SAMPLE + '\n' + SAMPLE + '\n');

  const stateFile = path.join(dir, 'state', 'offsets.json');
  const tailer = new Tailer(logs, stateFile);
  const first = [];
  await tailer.poll((ev) => first.push(ev));
  assert.equal(first.length, 2);
  assert.equal(first[0].hostId, '7');

  const second = [];
  await tailer.poll((ev) => second.push(ev));
  assert.equal(second.length, 0, 'no duplicate reads');

  fs.appendFileSync(file, SAMPLE + '\n');
  const third = [];
  await tailer.poll((ev) => third.push(ev));
  assert.equal(third.length, 1);
  assert.equal(fs.existsSync(stateFile), false, 'offsets are not committed by a plain poll');
  await tailer.saveState();
  assert.ok(fs.existsSync(stateFile), 'offsets are committed on request');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(saved.files['proxy-host-7_access.log'].offset > 0);
});

test('tailer handles truncation and a partial trailing line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipvis-agent-'));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const file = path.join(logs, 'proxy-host-2_access.log');
  fs.writeFileSync(file, SAMPLE + '\n' + SAMPLE.slice(0, 40));

  const tailer = new Tailer(logs, path.join(dir, 'state.json'));
  const events = [];
  await tailer.poll((ev) => events.push(ev));
  assert.equal(events.length, 1, 'incomplete line is held back');

  fs.appendFileSync(file, SAMPLE.slice(40) + '\n');
  await tailer.poll((ev) => events.push(ev));
  assert.equal(events.length, 2, 'the completed line is emitted');

  fs.writeFileSync(file, SAMPLE + '\n');
  await tailer.poll((ev) => events.push(ev));
  assert.equal(events.length, 3, 'truncated file is re-read from the start');
});
