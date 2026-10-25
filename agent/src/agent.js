import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const HEARTBEAT_MS = 25000;

const cfg = {
  hubUrl: (process.env.HUB_URL || '').replace(/\/+$/, ''),
  token: process.env.AGENT_TOKEN || '',
  name: process.env.AGENT_NAME || '',
  logDir: process.env.LOG_DIR || '/npm-logs',
  confDir: process.env.NGINX_CONF_DIR || '/npm-conf',
  stateFile: process.env.STATE_FILE || '/state/offsets.json',
  pollMs: Math.max(500, Number(process.env.POLL_MS || 2000)),
  backlogBytes: Math.max(0, Number(process.env.BACKLOG_BYTES || 65536)),
  maxBatch: Math.max(50, Number(process.env.MAX_BATCH || 800)),
  healthPort: Number(process.env.HEALTH_PORT || 8099),
  ignoreHosts: (process.env.IGNORE_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra || {}) }));
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// NPM (2.x) writes one access log per proxy host with this format:
// [25/Oct/2026:21:19:27 +0300] - 200 200 - GET https host "/path" [Client 1.2.3.4]
//   [Length 1085] [Gzip -] [Sent-to 10.0.0.5] "user agent" "referer"
const LINE_RE =
  /^\[([^\]]+)\] - (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) "(.*?)" \[Client ([^\]]+)\] \[Length (\d+)\] \[Gzip ([^\]]*)\] \[Sent-to ([^\]]*)\] "([^"]*)" "([^"]*)"/;

export function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const t = parseTimestamp(m[1]);
  if (!t) return null;
  return {
    t,
    status: Number(m[2]),
    method: m[5],
    scheme: m[6],
    host: m[7].toLowerCase(),
    path: m[8].slice(0, 300),
    ip: m[9].replace(/^::ffff:/, ''),
    bytes: Number(m[10]) || 0,
    sentTo: m[12],
    userAgent: m[13].slice(0, 200),
  };
}

export function parseTimestamp(raw) {
  const m = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(raw);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (month === undefined) return null;
  const tz = m[7];
  const iso = `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${tz.slice(0, 3)}:${tz.slice(3)}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export class Tailer {
  constructor(dir, stateFile) {
    this.dir = dir;
    this.stateFile = stateFile;
    this.files = new Map(); // name -> { offset, ino, partial }
    this.loaded = false;
  }

  async loadState() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      for (const [name, st] of Object.entries(raw.files || {})) {
        this.files.set(name, { offset: Number(st.offset) || 0, ino: Number(st.ino) || 0, partial: '' });
      }
      log('info', 'restored tail offsets', { files: this.files.size });
    } catch {
      /* first run */
    }
  }

  async saveState() {
    const files = {};
    for (const [name, st] of this.files) files[name] = { offset: st.offset, ino: st.ino };
    const tmp = `${this.stateFile}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify({ files }, null, 1));
      await fsp.rename(tmp, this.stateFile);
    } catch (err) {
      log('warn', 'could not persist offsets', { error: String(err && err.message) });
    }
  }

  /** Read new complete lines from every proxy-host access log. */
  async poll(onLine) {
    await this.loadState();
    let names = [];
    try {
      names = (await fsp.readdir(this.dir)).filter((n) => /^proxy-host-\d+_access\.log$/.test(n));
    } catch (err) {
      log('warn', 'log dir unreadable', { dir: this.dir, error: String(err && err.message) });
      return;
    }
    for (const name of names) {
      const full = path.join(this.dir, name);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      let st = this.files.get(name);
      if (!st || st.ino !== stat.ino) {
        // New file (or rotated): start from the tail so a restart does not replay history.
        const start = Math.max(0, stat.size - cfg.backlogBytes);
        st = { offset: start, ino: stat.ino, partial: '' };
        this.files.set(name, st);
      } else if (stat.size < st.offset) {
        st.offset = 0; // truncated
        st.partial = '';
      }
      if (stat.size === st.offset) continue;

      const length = Math.min(stat.size - st.offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(length);
      let fd;
      try {
        fd = await fsp.open(full, 'r');
        const { bytesRead } = await fd.read(buf, 0, length, st.offset);
        st.offset += bytesRead;
        const text = st.partial + buf.subarray(0, bytesRead).toString('utf8');
        const lines = text.split('\n');
        st.partial = lines.pop() ?? '';
        if (st.partial.length > 64 * 1024) st.partial = '';
        const hostId = name.replace(/^proxy-host-(\d+)_access\.log$/, '$1');
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = parseLine(line);
          if (!ev) continue;
          if (cfg.ignoreHosts.includes(ev.host)) continue;
          onLine({ ...ev, hostId });
        }
      } catch (err) {
        log('warn', 'read failed', { file: name, error: String(err && err.message) });
      } finally {
        if (fd) await fd.close().catch(() => {});
      }
    }
    // Offsets are only persisted once the shipped queue is empty (see main loop), so a hub
    // outage or crash replays events instead of silently dropping them.
  }
}

class Shippper {
  constructor() {
    this.queue = [];
    this.max = 50000;
    this.failures = 0;
    this.sent = 0;
    this.lastError = null;
    this.lastBeat = 0;
  }

  push(events) {
    this.queue.push(...events);
    if (this.queue.length > this.max) {
      const drop = this.queue.length - this.max;
      this.queue.splice(0, drop);
      log('warn', 'shipper queue overflow, dropped oldest events', { drop });
    }
  }

  async flush(force = false) {
    if (!this.queue.length && !force) return;
    const batch = this.queue.slice(0, cfg.maxBatch);
    const payload = JSON.stringify({
      agentVersion: VERSION,
      agent: cfg.name,
      events: batch.map((e) => ({ t: e.t, ip: e.ip, host: e.host, hid: e.hostId, s: e.status, b: e.bytes, m: e.method })),
    });
    try {
      const res = await fetch(`${cfg.hubUrl}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: payload,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`hub answered ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
      this.queue.splice(0, batch.length);
      this.sent += batch.length;
      this.failures = 0;
      this.lastError = null;
      this.lastBeat = Date.now();
    } catch (err) {
      this.failures += 1;
      this.lastError = String(err && err.message);
      if (this.failures === 1 || this.failures % 15 === 0) {
        log('warn', 'ship failed, will retry', { failures: this.failures, error: this.lastError });
      }
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function hostNames() {
  // Optional: map proxy-host-<id> -> domain from NPM's generated nginx config.
  try {
    const dir = path.join(cfg.confDir, 'proxy_host');
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.conf'));
    const out = {};
    for (const n of names) {
      const id = n.replace(/\.conf$/, '');
      const text = await fsp.readFile(path.join(dir, n), 'utf8');
      const m = /server_name\s+([^;]+);/.exec(text);
      if (m) out[id] = m[1].trim().split(/\s+/).filter(Boolean);
    }
    return out;
  } catch {
    return {};
  }
}

async function main() {
  if (!cfg.hubUrl || !cfg.token) {
    log('error', 'HUB_URL and AGENT_TOKEN are required');
    process.exit(2);
  }
  if (!fs.existsSync(cfg.logDir)) log('warn', 'log dir does not exist yet', { dir: cfg.logDir });

  const known = await hostNames();
  log('info', 'agent starting', {
    version: VERSION,
    hub: cfg.hubUrl,
    logDir: cfg.logDir,
    hosts: Object.keys(known).length,
    name: cfg.name || '(hub default)',
  });

  const tailer = new Tailer(cfg.logDir, cfg.stateFile);
  const shipper = new Shippper();
  let running = true;

  const health = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      const ok = shipper.failures < 20;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok,
          version: VERSION,
          queued: shipper.queue.length,
          sent: shipper.sent,
          failures: shipper.failures,
          lastError: shipper.lastError,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(cfg.healthPort, '0.0.0.0');

  const loop = async () => {
    let fresh = 0;
    const batch = [];
    await tailer.poll((ev) => {
      fresh += 1;
      batch.push(ev);
    });
    if (batch.length) shipper.push(batch);
    if (fresh) log('info', 'parsed events', { fresh, queued: shipper.queue.length });
    // An idle proxy still needs to look alive in the hub, so ping with an empty batch.
    await shipper.flush(Date.now() - shipper.lastBeat > HEARTBEAT_MS);
    if (shipper.queue.length === 0) await tailer.saveState();
  };

  while (running) {
    const started = Date.now();
    try {
      await loop();
    } catch (err) {
      log('error', 'poll loop failed', { error: String(err && err.stack) });
    }
    const spent = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(250, cfg.pollMs - spent)));
  }
}

process.on('SIGTERM', () => {
  log('info', 'agent stopping');
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('error', 'fatal', { error: String(err && err.stack) });
    process.exit(1);
  });
}
