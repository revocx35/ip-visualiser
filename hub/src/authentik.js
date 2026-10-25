// Pull authentik login events (successful and failed) so the map can show attempts against
// the SSO front door. Read-only: the poller never touches authentik's configuration.

import https from 'node:https';

const MAX_PAGES = 5;
const PAGE_SIZE = 100;

/** Pull the hostname a login was headed for out of authentik's nested http_request args. */
export function targetHost(args) {
  if (!args || typeof args !== 'object') return null;
  const candidates = [];
  if (typeof args.redirect_uri === 'string') candidates.push(args.redirect_uri);
  if (typeof args.next === 'string' && args.next) {
    candidates.push(args.next);
    const decoded = safeDecode(args.next);
    const nested = /redirect_uri=([^&]+)/.exec(decoded || '');
    if (nested) candidates.push(safeDecode(nested[1]) || nested[1]);
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, 'https://placeholder.invalid');
      if (url.hostname && url.hostname !== 'placeholder.invalid') return url.hostname.toLowerCase();
    } catch {
      /* ignore */
    }
  }
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** authentik event -> row (or null when it is not a login event). */
export function normalizeEvent(event, serverId, { ownHost } = {}) {
  if (!event || typeof event !== 'object') return null;
  const action = event.action;
  if (action !== 'login' && action !== 'login_failed') return null;
  const ts = Math.floor(Date.parse(event.created) / 1000);
  if (!Number.isFinite(ts)) return null;

  const context = event.context && typeof event.context === 'object' ? event.context : {};
  let username = null;
  if (action === 'login_failed') username = context.username || event.user?.username || null;
  else username = event.user?.username || null;

  let app = targetHost(context.http_request?.args);
  if (ownHost && app === ownHost) app = null;

  return {
    pk: String(event.pk || '').slice(0, 64) || `${ts}:${action}:${username || ''}`,
    serverId: serverId === null || serverId === undefined ? null : Number(serverId),
    ts,
    action,
    username: username ? String(username).slice(0, 120) : null,
    clientIp: event.client_ip || null,
    app: app ? app.slice(0, 190) : null,
  };
}

function getJson(url, token, { insecure = true, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        rejectUnauthorized: !insecure,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`authentik answered ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`invalid JSON from authentik: ${body.slice(0, 120)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('authentik request timed out')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ db: any, log: any, baseUrl: string, token: string, serverId?: number|null,
 *           insecure?: boolean, intervalMs?: number, backfillHours?: number, ownHost?: string }} opts
 */
export function createAuthentikPoller(opts) {
  const { db, log, baseUrl, token } = opts;
  const intervalMs = Math.max(5000, Number(opts.intervalMs || 30000));
  const serverId = opts.serverId ?? null;
  const insecure = opts.insecure !== false;
  const backfillHours = Math.max(1, Number(opts.backfillHours || 24));
  const ownHost = opts.ownHost || null;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO auth_events(pk, server_id, ts, action, username, client_ip, app) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const stats = { polls: 0, inserted: 0, failedPolls: 0, lastError: null, lastPoll: null };
  let running = true;
  let cursor = null; // newest `created` we have stored, ISO string
  let cursorLoadFailed = false;

  function loadCursor() {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'authentik_cursor'").get();
      if (row) cursor = JSON.parse(row.value);
    } catch {
      cursorLoadFailed = true;
    }
    if (!cursor) cursor = new Date(Date.now() - backfillHours * 3600 * 1000).toISOString();
  }

  function saveCursor(value) {
    cursor = value;
    try {
      db.prepare(
        "INSERT INTO settings(key, value) VALUES ('authentik_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(value));
    } catch (err) {
      log.warn('could not persist the authentik cursor', { error: String(err && err.message) });
    }
  }

  async function fetchAction(action, sinceIso) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url =
        `${baseUrl.replace(/\/+$/, '')}/api/v3/events/events/?action=${encodeURIComponent(action)}` +
        `&created__gte=${encodeURIComponent(sinceIso)}&ordering=-created&page_size=${PAGE_SIZE}` +
        (page ? `&page=${page + 1}` : '');
      const data = await getJson(url, token, { insecure });
      const results = Array.isArray(data.results) ? data.results : [];
      rows.push(...results);
      if (results.length < PAGE_SIZE || !data.pagination || page + 1 >= (data.pagination.total_pages || 1)) break;
    }
    return rows;
  }

  async function poll() {
    const since = cursor;
    const [failed, ok] = await Promise.all([fetchAction('login_failed', since), fetchAction('login', since)]);
    let newest = since;
    let inserted = 0;
    for (const event of [...failed, ...ok]) {
      const row = normalizeEvent(event, serverId, { ownHost });
      if (!row) continue;
      const res = insert.run(row.pk, row.serverId, row.ts, row.action, row.username, row.clientIp, row.app);
      inserted += Number(res.changes) || 0;
      if (typeof event.created === 'string' && event.created > newest) newest = event.created;
    }
    if (newest !== since) saveCursor(newest);
    stats.polls += 1;
    stats.inserted += inserted;
    stats.lastPoll = Math.floor(Date.now() / 1000);
    if (inserted) log.info('authentik events ingested', { inserted, actions: { failed: failed.length, ok: ok.length } });
  }

  return {
    stats() {
      const row = db.prepare('SELECT COUNT(*) AS n, MAX(ts) AS last FROM auth_events').get();
      return {
        ...stats,
        stored: Number(row.n || 0),
        newest: row.last === null ? null : Number(row.last),
        cursor,
      };
    },
    start() {
      loadCursor();
      if (cursorLoadFailed) log.warn('authentik cursor was unreadable, backfilling', { hours: backfillHours });
      (async () => {
        while (running) {
          try {
            await poll();
          } catch (err) {
            stats.failedPolls += 1;
            stats.lastError = String(err && err.message);
            log.warn('authentik poll failed', { error: stats.lastError });
            await sleep(Math.min(300000, intervalMs * 4));
            continue;
          }
          await sleep(intervalMs);
        }
      })();
    },
    stop() {
      running = false;
    },
  };
}
