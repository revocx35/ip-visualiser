import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoginThrottle, sessionUser } from './auth.js';
import { getSettings, openDb, prune } from './db.js';
import { buildApi, HttpError } from './api.js';
import { createGeoResolver, normalizeIp } from './geo.js';
import { createAuthentikPollers } from './authentik.js';
import { isViewAllowed, parseCidrs } from './viewallow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || '/data/ipvis.db';
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
const MAX_BODY = 4 * 1024 * 1024;
const VERSION = PKG.version;

// View-only listener: a second port with no login that serves nothing but the map
// (read-only API + the shell). 0 = disabled. See README "View-only port".
const VIEW_PORT = Number(process.env.VIEW_PORT || 0);
const VIEW_BIND = process.env.VIEW_BIND || '0.0.0.0';
const VIEW_ALLOW = parseCidrs(process.env.VIEW_ALLOW);
const VIEW_FILES = new Set(['/style.css', '/app.js', '/viewmath.js', '/world.json', '/favicon.svg']);

const log = {
  line(level, msg, extra) {
    const entry = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
    console.log(JSON.stringify(entry));
  },
  info(msg, extra) {
    this.line('info', msg, extra);
  },
  warn(msg, extra) {
    this.line('warn', msg, extra);
  },
  error(msg, extra) {
    this.line('error', msg, extra);
  },
};

const db = openDb(DB_PATH);
const throttle = new LoginThrottle();
const geo = createGeoResolver(db, {
  provider: process.env.GEO_PROVIDER || 'ip-api',
  ttlDays: Number(process.env.GEO_TTL_DAYS || 30),
  log,
});
geo.start();

// Optional: pull authentik login events. Either AUTHENTIK_INSTANCES (JSON list) or the
// single-instance AUTHENTIK_URL/AUTHENTIK_TOKEN pair.
let authentik = null;
function authentikConfigs() {
  const raw = (process.env.AUTHENTIK_INSTANCES || '').trim();
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter((c) => c && c.url && c.token);
    } catch (err) {
      log.error('AUTHENTIK_INSTANCES is not valid JSON', { error: String(err && err.message) });
    }
    return [];
  }
  if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_TOKEN) {
    return [
      {
        url: process.env.AUTHENTIK_URL,
        token: process.env.AUTHENTIK_TOKEN,
        server: process.env.AUTHENTIK_SERVER || null,
        host: process.env.AUTHENTIK_HOST || null,
        insecure: process.env.AUTHENTIK_INSECURE !== '0',
        backfillHours: Number(process.env.AUTHENTIK_BACKFILL_HOURS || 168),
        intervalMs: Number(process.env.AUTHENTIK_POLL_MS || 30000),
      },
    ];
  }
  return [];
}

function resolveServer(wanted) {
  const name = (wanted || '').trim();
  if (!name) return null;
  const row = /^\d+$/.test(name)
    ? db.prepare('SELECT id, name FROM servers WHERE id = ?').get(Number(name))
    : db.prepare('SELECT id, name FROM servers WHERE name = ?').get(name);
  if (!row) log.warn('authentik instance points at an unknown server, events stay unattributed', { wanted: name });
  return row || null;
}

const akConfigs = authentikConfigs()
  .map((cfg) => {
    const serverRow = resolveServer(cfg.server);
    return {
      baseUrl: cfg.url,
      token: cfg.token,
      serverId: serverRow ? Number(serverRow.id) : null,
      insecure: cfg.insecure !== false,
      intervalMs: Number(cfg.intervalMs || process.env.AUTHENTIK_POLL_MS || 30000),
      backfillHours: Number(cfg.backfillHours || process.env.AUTHENTIK_BACKFILL_HOURS || 168),
      ownHost: cfg.host || null,
    };
  })
  .filter((cfg) => cfg.baseUrl && cfg.token);

if (akConfigs.length) {
  authentik = createAuthentikPollers(akConfigs, { db, log });
  authentik.start();
  log.info('authentik polling enabled', {
    instances: akConfigs.map((c) => c.baseUrl),
    servers: akConfigs.map((c) => c.serverId),
  });
}

const handleApi = buildApi({ db, throttle, log, geo, authentik, version: VERSION });
const handleViewApi = VIEW_PORT
  ? buildApi({ db, throttle, log, geo, authentik, version: VERSION, viewOnly: true })
  : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return normalizeIp(xff.split(',')[0]);
  }
  return normalizeIp(req.socket.remoteAddress);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function securityHeaders(res, secure) {
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  if (secure) res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    // SPA fallback: unknown paths render the app shell.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(await fsp.readFile(path.join(PUBLIC_DIR, 'index.html')));
    return;
  }
  if (stat.isDirectory()) {
    return serveStatic(req, res, new URL(url.pathname.replace(/\/?$/, '/index.html'), 'http://x'));
  }
  const ext = path.extname(filePath).toLowerCase();
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
    etag,
    'last-modified': stat.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function sendError(res, err, pathname) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) log.error('request failed', { path: pathname, error: String(err && err.message) });
  const payload = JSON.stringify({ error: status >= 500 ? 'internal error' : err.message });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket.encrypted);
  securityHeaders(res, secure);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();
  const ip = clientIp(req);

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url);
    }

    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') {
      const raw = await readBody(req);
      const ct = String(req.headers['content-type'] || '');
      if (raw.length && !ct.includes('application/json')) throw new HttpError(415, 'expected application/json');
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'invalid JSON');
        }
      } else {
        body = {};
      }
    }

    const cookies = parseCookies(req.headers.cookie);
    const user = sessionUser(db, cookies.ipv_session);

    // CSRF: cookie-authenticated writes must come from the same origin.
    const isAgentIngest = url.pathname === '/api/ingest';
    if (!isAgentIngest && user && req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const host = String(req.headers.host || '');
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = 'invalid';
        }
        if (originHost !== host) throw new HttpError(403, 'cross-origin request rejected');
      } else if (!String(req.headers['sec-fetch-site'] || '').match(/same-origin|none/)) {
        throw new HttpError(403, 'missing origin for state-changing request');
      }
    }

    const ctx = { req, res, url, body, user, clientIp: ip, secure, method: req.method };
    const handled = await handleApi(ctx);
    if (!handled) throw new HttpError(404, 'not found');
  } catch (err) {
    sendError(res, err, url.pathname);
  } finally {
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/state') {
      log.info('api', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
    }
  }
});

server.listen(PORT, '0.0.0.0', () => log.info('hub listening', { port: PORT, version: VERSION }));

// ---- view-only listener ---------------------------------------------------
// No session, no writes, LAN peers only. The compose file publishes this port on the
// host's LAN address so it is never reachable from outside the network.
let viewServer = null;

async function serveViewShell(req, res) {
  const shell = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const html = shell.replace('<html lang="en"', '<html lang="en" data-view-only="1"');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  res.end(html);
}

if (VIEW_PORT) {
  viewServer = http.createServer(async (req, res) => {
    securityHeaders(res, false);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const peer = normalizeIp(req.socket.remoteAddress);
    const started = Date.now();
    try {
      if (!isViewAllowed(peer, VIEW_ALLOW)) {
        log.warn('view-only access denied', { peer, path: url.pathname });
        throw new HttpError(403, 'the view-only endpoint is only reachable from the local network');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        throw new HttpError(405, 'the view-only endpoint is read-only');
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        await serveViewShell(req, res);
      } else if (VIEW_FILES.has(url.pathname)) {
        await serveStatic(req, res, url);
      } else {
        const ctx = { req, res, url, body: null, user: null, clientIp: peer, secure: false, method: req.method };
        const handled = await handleViewApi(ctx);
        if (!handled) throw new HttpError(404, 'not found');
      }
    } catch (err) {
      sendError(res, err, url.pathname);
    } finally {
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/view') {
        log.info('view api', { method: req.method, path: url.pathname, peer, status: res.statusCode, ms: Date.now() - started });
      }
    }
  });
  viewServer.listen(VIEW_PORT, VIEW_BIND, () =>
    log.info('view-only listener up', { port: VIEW_PORT, bind: VIEW_BIND, allow: VIEW_ALLOW }),
  );
}

// Retention: prune aggressively but cheaply.
const pruneTimer = setInterval(() => {
  try {
    const settings = getSettings(db);
    const res = prune(db, settings.retentionHours || 168);
    if (res.buckets) log.info('retention prune', { ...res, retentionHours: settings.retentionHours });
  } catch (err) {
    log.error('prune failed', { error: String(err && err.message) });
  }
}, 60_000);
pruneTimer.unref?.();

function shutdown(signal) {
  log.info('shutting down', { signal });
  geo.stop();
  if (authentik) authentik.stop();
  if (viewServer) viewServer.close();
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String(err) }));
