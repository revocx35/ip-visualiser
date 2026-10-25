import { createSession, destroySession, hashPassword, hashToken, randomToken, verifyPassword } from './auth.js';
import { getSettings, setSetting, prune } from './db.js';
import { normalizeIp } from './geo.js';
import { ingestBatch, touchAgent } from './ingest.js';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const USERNAME_RE = /^[A-Za-z0-9_.@-]{3,64}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function requireString(value, field, { min = 1, max = 512 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(400, `${field} must be a string of ${min}-${max} characters`);
  }
  return value;
}

function clampNumber(value, field, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be a number between ${min} and ${max}`);
  return n;
}

function serverRow(row) {
  return { id: Number(row.id), name: row.name, lat: row.lat, lon: row.lon, color: row.color || null };
}

function agentRow(row) {
  return {
    id: Number(row.id),
    serverId: Number(row.server_id),
    name: row.name,
    lastSeen: row.last_seen === null ? null : Number(row.last_seen),
    remoteIp: row.remote_ip,
    version: row.version,
    eventsTotal: Number(row.events_total || 0),
  };
}

export function buildApi({ db, throttle, log, geo, authentik = null, version = '0.0.0', viewOnly = false }) {
  const handlers = [];
  const route = (method, pattern, opts, handler) => handlers.push({ method, pattern, ...opts, handler });

  const publicRoutes = [];
  const pub = (method, pattern, handler) => publicRoutes.push({ method, pattern, handler });

  // ---- public -----------------------------------------------------------
  const healthHandler = async (ctx) =>
    json(ctx.res, 200, { ok: true, version, geo: geo.stats(), ...(authentik ? { authentik: authentik.stats() } : {}) });

  pub('GET', /^\/api\/health$/, healthHandler);

  pub('GET', /^\/api\/bootstrap$/, async (ctx) => {
    const users = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
    json(ctx.res, 200, { setupRequired: users === 0, app: 'ip-visualiser', version });
  });

  pub('POST', /^\/api\/setup$/, async (ctx) => {
    const users = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
    if (users > 0) throw new HttpError(409, 'an admin account already exists');
    const username = requireString(ctx.body?.username, 'username', { min: 3, max: 64 });
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'username may only contain letters, digits and . _ - @');
    const password = requireString(ctx.body?.password, 'password', { min: 10, max: 200 });
    const now = Math.floor(Date.now() / 1000);
    const info = db
      .prepare('INSERT INTO users(username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), now);
    const { token, expiresAt } = createSession(db, Number(info.lastInsertRowid));
    setSessionCookie(ctx, token, expiresAt);
    log.info('admin account created', { username });
    json(ctx.res, 201, { user: { id: Number(info.lastInsertRowid), username } });
  });

  pub('POST', /^\/api\/login$/, async (ctx) => {
    const key = ctx.clientIp || 'unknown';
    const wait = throttle.retryAfter(key);
    if (wait > 0) throw new HttpError(429, `too many failed logins, try again in ${wait}s`);
    const username = requireString(ctx.body?.username, 'username', { min: 1, max: 64 }).trim();
    const password = requireString(ctx.body?.password, 'password', { min: 1, max: 200 });
    const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      const left = throttle.fail(key);
      log.warn('failed login', { ip: key, username, locked: left > 0 });
      throw new HttpError(401, 'wrong username or password');
    }
    throttle.succeed(key);
    const { token, expiresAt } = createSession(db, Number(row.id));
    setSessionCookie(ctx, token, expiresAt);
    log.info('login', { ip: key, username });
    json(ctx.res, 200, { user: { id: Number(row.id), username: row.username } });
  });

  // ---- agent ingest (bearer token, no cookies) --------------------------
  pub('POST', /^\/api\/ingest$/, async (ctx) => {
    const auth = String(ctx.req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'missing agent token');
    const agent = db
      .prepare('SELECT id, server_id, name FROM agents WHERE token_hash = ?')
      .get(hashToken(token));
    if (!agent) throw new HttpError(401, 'unknown agent token');
    const result = ingestBatch(db, agent, ctx.body);
    touchAgent(db, agent.id, ctx.clientIp, ctx.body?.agentVersion);
    json(ctx.res, 202, result);
  });

  // ---- authenticated ----------------------------------------------------
  route('POST', /^\/api\/logout$/, {}, async (ctx) => {
    destroySession(db, ctx.user.tokenHash);
    ctx.res.writeHead(204, { 'set-cookie': cookieString('', 0, ctx.secure), 'cache-control': 'no-store' });
    ctx.res.end();
  });

  route('GET', /^\/api\/me$/, {}, async (ctx) => json(ctx.res, 200, { user: { id: ctx.user.id, username: ctx.user.username } }));

  // Map feed. `GET /api/state` is the authenticated original; the view-only listener
  // exposes the same payload as `GET /api/view` so the kiosk needs no session.
  const stateHandler = async (ctx) => {
    const settings = getSettings(db);
    const windowMin = Math.min(1440, Math.max(1, Number(ctx.url.searchParams.get('window') || settings.timeWindowMinutes) || 120));
    const since = Math.floor(Date.now() / 1000) - windowMin * 60;

    const servers = db.prepare('SELECT * FROM servers ORDER BY id').all().map(serverRow);
    const agents = db.prepare('SELECT * FROM agents ORDER BY id').all().map(agentRow);

    const grouped = db
      .prepare(
        `SELECT server_id, ip, MAX(ts_minute) AS last_ts, SUM(count) AS count
           FROM buckets WHERE ts_minute >= ? GROUP BY server_id, ip
          ORDER BY last_ts DESC LIMIT 4000`,
      )
      .all(since);

    const hostRows = db
      .prepare(
        `SELECT server_id, ip, host, SUM(count) AS c
           FROM buckets WHERE ts_minute >= ? GROUP BY server_id, ip, host`,
      )
      .all(since);

    const byKey = new Map();
    for (const h of hostRows) {
      const k = `${h.server_id}|${h.ip}`;
      const list = byKey.get(k) || [];
      list.push({ host: h.host, count: Number(h.c) });
      byKey.set(k, list);
    }

    const connections = [];
    const geoCache = new Map();
    for (const row of grouped) {
      const ip = row.ip;
      if (!geoCache.has(ip)) geoCache.set(ip, geo.resolve(ip));
      const geoInfo = geoCache.get(ip);
      if (geoInfo.private || geoInfo.lat === null || geoInfo.lon === null) continue;
      const hosts = (byKey.get(`${row.server_id}|${ip}`) || []).sort((a, b) => b.count - a.count);
      connections.push({
        serverId: Number(row.server_id),
        ip,
        lat: geoInfo.lat,
        lon: geoInfo.lon,
        city: geoInfo.city,
        region: geoInfo.region,
        country: geoInfo.country,
        isp: geoInfo.isp || null,
        lastTs: Number(row.last_ts),
        count: Number(row.count),
        hosts: hosts.slice(0, 4),
        host: hosts[0]?.host || null,
      });
    }

    const totals = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(count),0) AS c FROM buckets WHERE ts_minute >= ?')
      .get(since);

    const topHosts = db
      .prepare(
        `SELECT host, SUM(count) AS c FROM buckets WHERE ts_minute >= ? GROUP BY host ORDER BY c DESC LIMIT 8`,
      )
      .all(since)
      .map((r) => ({ host: r.host, count: Number(r.c) }));

    let auth = null;
    if (authentik) {
      const counts = db
        .prepare("SELECT action, COUNT(*) AS n FROM auth_events WHERE ts >= ? GROUP BY action")
        .all(since);
      const authSummary = { failed: 0, success: 0, ips: [] };
      for (const row of counts) {
        if (row.action === 'login_failed') authSummary.failed = Number(row.n);
        if (row.action === 'login') authSummary.success = Number(row.n);
      }
      const failedRows = db
        .prepare(
          `SELECT client_ip AS ip, COUNT(*) AS n, MAX(ts) AS last_ts,
                  GROUP_CONCAT(DISTINCT username) AS users
             FROM auth_events
            WHERE action = 'login_failed' AND ts >= ? AND client_ip IS NOT NULL
            GROUP BY client_ip ORDER BY last_ts DESC LIMIT 200`,
        )
        .all(since);
      for (const row of failedRows) {
        const loc = geo.resolve(row.ip);
        if (loc.private || loc.lat === null || loc.lon === null) continue;
        authSummary.ips.push({
          ip: row.ip,
          lat: loc.lat,
          lon: loc.lon,
          city: loc.city,
          country: loc.country,
          countryCode: loc.countryCode,
          count: Number(row.n),
          lastTs: Number(row.last_ts),
          users: row.users ? String(row.users).split(',').slice(0, 4) : [],
        });
      }
      auth = authSummary;
    }

    json(ctx.res, 200, {
      serverTime: Math.floor(Date.now() / 1000),
      windowMinutes: windowMin,
      settings,
      servers,
      agents,
      connections,
      auth,
      stats: {
        events: Number(totals.c || 0),
        distinctIpHosts: Number(totals.n || 0),
        lines: connections.length,
        topHosts,
      },
    });
  };

  route('GET', /^\/api\/state$/, {}, stateHandler);

  route('POST', /^\/api\/password$/, {}, async (ctx) => {
    const current = requireString(ctx.body?.current, 'current', { min: 1, max: 200 });
    const password = requireString(ctx.body?.password, 'password', { min: 10, max: 200 });
    const row = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!row || !verifyPassword(current, row.password_hash)) throw new HttpError(401, 'current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), ctx.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(ctx.user.id, ctx.user.tokenHash);
    log.info('password changed', { user: ctx.user.username });
    json(ctx.res, 200, { ok: true });
  });

  // authentik login attempts (successful and failed) for the last N minutes.
  const authEventsHandler = async (ctx) => {
    if (!authentik) throw new HttpError(404, 'authentik integration is not configured');
    const minutes = Math.round(clampNumber(ctx.url.searchParams.get('minutes') || 60, 'minutes', 1, 1440));
    const limit = Math.round(clampNumber(ctx.url.searchParams.get('limit') || 80, 'limit', 1, 300));
    const serverParam = ctx.url.searchParams.get('serverId');
    const since = Math.floor(Date.now() / 1000) - minutes * 60;

    const where = ['ts >= ?'];
    const params = [since];
    if (serverParam) {
      where.push('server_id = ?');
      params.push(Number(serverParam));
    }
    const rows = db
      .prepare(
        `SELECT pk, server_id, ts, action, username, client_ip, app FROM auth_events
          WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
      )
      .all(...params, limit);

    const totals = db
      .prepare(
        `SELECT action, COUNT(*) AS n FROM auth_events WHERE ${where.join(' AND ')} GROUP BY action`,
      )
      .all(...params);
    const summary = { failed: 0, success: 0, distinctIps: 0 };
    for (const t of totals) {
      if (t.action === 'login_failed') summary.failed = Number(t.n);
      if (t.action === 'login') summary.success = Number(t.n);
    }
    summary.distinctIps = Number(
      db
        .prepare(`SELECT COUNT(DISTINCT client_ip) AS n FROM auth_events WHERE ${where.join(' AND ')} AND client_ip IS NOT NULL`)
        .get(...params).n,
    );

    const items = rows.map((r) => {
      const loc = r.client_ip ? geo.resolve(r.client_ip) : { private: true };
      return {
        ts: Number(r.ts),
        action: r.action,
        username: r.username,
        ip: r.client_ip,
        app: r.app,
        serverId: r.server_id === null ? null : Number(r.server_id),
        private: Boolean(loc.private),
        city: loc.city || null,
        country: loc.country || null,
        countryCode: loc.countryCode || null,
      };
    });

    json(ctx.res, 200, { minutes, summary, items });
  };

  route('GET', /^\/api\/auth-events$/, {}, authEventsHandler);

  // Addresses that reached one server during the last N minutes (default: one hour).
  const connectionsHandler = async (ctx, id) => {
    const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(id);
    if (!server) throw new HttpError(404, 'server not found');
    const minutes = Math.round(clampNumber(ctx.url.searchParams.get('minutes') || 60, 'minutes', 1, 1440));
    const limit = Math.round(clampNumber(ctx.url.searchParams.get('limit') || 120, 'limit', 1, 500));
    const since = Math.floor(Date.now() / 1000) - minutes * 60;

    const rows = db
      .prepare(
        `SELECT ip, MAX(ts_minute) AS last_ts, SUM(count) AS count
           FROM buckets WHERE server_id = ? AND ts_minute >= ?
          GROUP BY ip ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(id, since, limit);

    const hostRows = db
      .prepare(
        `SELECT ip, host, SUM(count) AS c
           FROM buckets WHERE server_id = ? AND ts_minute >= ?
          GROUP BY ip, host`,
      )
      .all(id, since);
    const hostsByIp = new Map();
    for (const h of hostRows) {
      const list = hostsByIp.get(h.ip) || [];
      list.push({ host: h.host, count: Number(h.c) });
      hostsByIp.set(h.ip, list);
    }

    const items = rows.map((r) => {
      const loc = geo.resolve(r.ip);
      const hosts = (hostsByIp.get(r.ip) || []).sort((a, b) => b.count - a.count);
      return {
        ip: r.ip,
        private: Boolean(loc.private),
        city: loc.city || null,
        region: loc.region || null,
        country: loc.country || null,
        countryCode: loc.countryCode || null,
        isp: loc.isp || null,
        lastTs: Number(r.last_ts),
        count: Number(r.count),
        host: hosts[0]?.host || null,
      };
    });

    const total = Number(
      db
        .prepare('SELECT COUNT(DISTINCT ip) AS n FROM buckets WHERE server_id = ? AND ts_minute >= ?')
        .get(id, since).n,
    );

    json(ctx.res, 200, { server: { id: Number(server.id), name: server.name }, minutes, total, items });
  };

  route('GET', /^\/api\/servers\/(\d+)\/connections$/, {}, connectionsHandler);

  route('GET', /^\/api\/servers$/, {}, async (ctx) => {
    const rows = db.prepare('SELECT * FROM servers ORDER BY id').all().map(serverRow);
    json(ctx.res, 200, { servers: rows });
  });

  route('POST', /^\/api\/servers$/, {}, async (ctx) => {
    const name = requireString(ctx.body?.name, 'name', { min: 1, max: 64 }).trim();
    const lat = clampNumber(ctx.body?.lat, 'lat', -85, 85);
    const lon = clampNumber(ctx.body?.lon, 'lon', -180, 180);
    const color = ctx.body?.color === undefined || ctx.body?.color === null || ctx.body?.color === '' ? null : String(ctx.body.color);
    if (color && !COLOR_RE.test(color)) throw new HttpError(400, 'color must be a hex value like #35e0ff');
    const info = db
      .prepare('INSERT INTO servers(name, lat, lon, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, lat, lon, color, Math.floor(Date.now() / 1000));
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(info.lastInsertRowid));
    log.info('server added', { name });
    json(ctx.res, 201, { server: serverRow(row) });
  });

  route('PATCH', /^\/api\/servers\/(\d+)$/, {}, async (ctx, id) => {
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'server not found');
    const next = { ...serverRow(row) };
    if (ctx.body?.name !== undefined) next.name = requireString(ctx.body.name, 'name', { min: 1, max: 64 }).trim();
    if (ctx.body?.lat !== undefined) next.lat = clampNumber(ctx.body.lat, 'lat', -85, 85);
    if (ctx.body?.lon !== undefined) next.lon = clampNumber(ctx.body.lon, 'lon', -180, 180);
    if (ctx.body?.color !== undefined) {
      if (ctx.body.color === null || ctx.body.color === '') next.color = null;
      else if (!COLOR_RE.test(String(ctx.body.color))) throw new HttpError(400, 'color must be a hex value like #35e0ff');
      else next.color = String(ctx.body.color);
    }
    db.prepare('UPDATE servers SET name = ?, lat = ?, lon = ?, color = ? WHERE id = ?').run(
      next.name,
      next.lat,
      next.lon,
      next.color,
      id,
    );
    json(ctx.res, 200, { server: next });
  });

  route('DELETE', /^\/api\/servers\/(\d+)$/, {}, async (ctx, id) => {
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'server not found');
    db.prepare('DELETE FROM buckets WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM agents WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    log.info('server deleted', { id });
    json(ctx.res, 200, { ok: true });
  });

  route('POST', /^\/api\/servers\/(\d+)\/agents$/, {}, async (ctx, id) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!server) throw new HttpError(404, 'server not found');
    const name = ctx.body?.name ? requireString(ctx.body.name, 'name', { min: 1, max: 48 }).trim() : server.name;
    const token = randomToken(24);
    const info = db
      .prepare('INSERT INTO agents(server_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, hashToken(token), Math.floor(Date.now() / 1000));
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(info.lastInsertRowid));
    log.info('agent created', { server: server.name, name });
    json(ctx.res, 201, { agent: agentRow(row), token });
  });

  route('PATCH', /^\/api\/agents\/(\d+)$/, {}, async (ctx, id) => {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'agent not found');
    const name = requireString(ctx.body?.name, 'name', { min: 1, max: 48 }).trim();
    db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(name, id);
    json(ctx.res, 200, { agent: agentRow(db.prepare('SELECT * FROM agents WHERE id = ?').get(id)) });
  });

  route('POST', /^\/api\/agents\/(\d+)\/rotate$/, {}, async (ctx, id) => {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'agent not found');
    const token = randomToken(24);
    db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
    log.info('agent token rotated', { id });
    json(ctx.res, 200, { token });
  });

  route('DELETE', /^\/api\/agents\/(\d+)$/, {}, async (ctx, id) => {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'agent not found');
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    log.info('agent deleted', { id });
    json(ctx.res, 200, { ok: true });
  });

  route('GET', /^\/api\/geo$/, {}, async (ctx) => {
    const ip = normalizeIp(ctx.url.searchParams.get('ip') || '');
    if (!ip) throw new HttpError(400, 'ip is required');
    json(ctx.res, 200, geo.lookupPublic(ip));
  });

  route('GET', /^\/api\/settings$/, {}, async (ctx) => json(ctx.res, 200, { settings: getSettings(db) }));

  route('PATCH', /^\/api\/settings$/, {}, async (ctx) => {
    const body = ctx.body || {};
    if (body.lineColor !== undefined) {
      if (!COLOR_RE.test(String(body.lineColor))) throw new HttpError(400, 'lineColor must be a hex value like #35e0ff');
      setSetting(db, 'lineColor', String(body.lineColor));
    }
    if (body.lineWidth !== undefined) {
      const width = clampNumber(body.lineWidth, 'lineWidth', 0.2, 3);
      setSetting(db, 'lineWidth', Math.round(width * 100) / 100);
    }
    if (body.timeWindowMinutes !== undefined) {
      setSetting(db, 'timeWindowMinutes', Math.round(clampNumber(body.timeWindowMinutes, 'timeWindowMinutes', 1, 1440)));
    }
    if (body.retentionHours !== undefined) {
      const hours = Math.round(clampNumber(body.retentionHours, 'retentionHours', 1, 8760));
      setSetting(db, 'retentionHours', hours);
      prune(db, hours);
    }
    if (body.showPrivate !== undefined) setSetting(db, 'showPrivate', Boolean(body.showPrivate));
    json(ctx.res, 200, { settings: getSettings(db) });
  });

  function setSessionCookie(ctx, token, expiresAt) {
    ctx.res.setHeader('set-cookie', cookieString(token, expiresAt, ctx.secure));
  }

  function cookieString(token, expiresAt, secure) {
    const parts = [`ipv_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, expiresAt - Math.floor(Date.now() / 1000))}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  // View-only listener (`VIEW_PORT`): a second API surface with no session, no writes and
  // no admin routes at all — just the map feed and the two read-only detail endpoints the
  // map itself calls. Anything else is a 404, every non-GET is a 405.
  if (viewOnly) {
    // Start from an empty surface: nothing registered for the authenticated hub leaks in.
    publicRoutes.length = 0;
    pub('GET', /^\/api\/view$/, stateHandler);
    pub('GET', /^\/api\/servers\/(\d+)\/connections$/, connectionsHandler);
    pub('GET', /^\/api\/auth-events$/, authEventsHandler);
    pub('GET', /^\/api\/health$/, healthHandler);

    return async function handleViewApi(ctx) {
      const path = ctx.url.pathname;
      if (!path.startsWith('/api/')) return false;
      const readMethod = ctx.method === 'GET' || ctx.method === 'HEAD';
      if (!readMethod) throw new HttpError(405, 'the view-only endpoint is read-only');
      for (const r of publicRoutes) {
        if (r.method !== 'GET' || !r.pattern.test(path)) continue;
        const args = path.match(r.pattern).slice(1).map((v) => (v === undefined ? undefined : Number(v)));
        await r.handler(ctx, ...args);
        return true;
      }
      throw new HttpError(404, 'not found');
    };
  }

  return async function handleApi(ctx) {
    const path = ctx.url.pathname;
    if (!path.startsWith('/api/')) return false;

    for (const r of publicRoutes) {
      if (r.method === ctx.method && r.pattern.test(path)) {
        const args = path.match(r.pattern).slice(1).map((v) => (v === undefined ? undefined : Number(v)));
        await r.handler(ctx, ...args);
        return true;
      }
    }

    const match = handlers.find((r) => r.method === ctx.method && r.pattern.test(path));
    if (!match) throw new HttpError(404, 'not found');
    const ctxArgs = path.match(match.pattern).slice(1).map((v) => (v === undefined ? undefined : Number(v)));
    if (!ctx.user) throw new HttpError(401, 'login required');
    await match.handler(ctx, ...ctxArgs);
    return true;
  };
}

export { HttpError };
