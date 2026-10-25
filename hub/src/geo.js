// Hub-side geolocation: an online batch provider (ip-api.com) with the bundled offline
// database as an immediate fallback, and every answer cached in SQLite.

import geoip from 'geoip-lite';
import net from 'node:net';

const PRIVATE = [
  [/^10\./, '10/8'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16/12'],
  [/^192\.168\./, '192.168/16'],
  [/^0\./, 'this-network'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'cgnat'],
];

const IP_API_BATCH = 'http://ip-api.com/batch?fields=status,message,country,countryCode,regionName,city,lat,lon,isp';
const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = 1500; // ip-api allows 45 requests/minute on the free tier

export function isPrivateIp(ip) {
  if (!ip) return true;
  const clean = String(ip).replace(/^::ffff:/, '');
  if (clean.includes(':')) {
    return clean === '::1' || clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80');
  }
  return PRIVATE.some(([re]) => re.test(clean));
}

export function normalizeIp(raw) {
  if (!raw) return null;
  let ip = String(raw).trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  ip = ip.replace(/^::ffff:/, '');
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

/** True only for syntactically valid IPv4/IPv6 literals. */
export function isIpAddress(raw) {
  if (typeof raw !== 'string' || !raw.length) return false;
  return net.isIP(raw) !== 0;
}

function offlineLookup(ip) {
  const hit = geoip.lookup(ip);
  if (!hit || !hit.ll) return null;
  return {
    lat: hit.ll[0],
    lon: hit.ll[1],
    city: hit.city || null,
    region: hit.region || null,
    country: hit.country || null,
    countryCode: hit.country || null,
    isp: null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ provider?: 'ip-api'|'offline', ttlDays?: number, log?: any }} opts
 */
export function createGeoResolver(db, opts = {}) {
  const provider = opts.provider === 'offline' ? 'offline' : 'ip-api';
  const ttlSeconds = Math.max(1, Number(opts.ttlDays || 30)) * 86400;
  const retrySeconds = 900; // a failed online lookup is retried after 15 minutes
  const log = opts.log || { info() {}, warn() {} };

  const queue = new Set();
  let running = true;
  const stats = { queued: 0, batches: 0, updated: 0, failed: 0, lastError: null };

  const selectStmt = db.prepare('SELECT * FROM geo WHERE ip = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO geo(ip, private, lat, lon, city, region, country, country_code, isp, source, looked_up_at)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, city=excluded.city,
       region=excluded.region, country=excluded.country, country_code=excluded.country_code,
       isp=excluded.isp, source=excluded.source, looked_up_at=excluded.looked_up_at, private=0`,
  );

  function rowToGeo(row) {
    return {
      private: false,
      ip: row.ip,
      lat: row.lat,
      lon: row.lon,
      city: row.city,
      region: row.region,
      country: row.country,
      countryCode: row.country_code,
      isp: row.isp || null,
      source: row.source || 'offline',
    };
  }

  function isFresh(row) {
    if (!row) return false;
    if (row.private) return true;
    const age = Math.floor(Date.now() / 1000) - Number(row.looked_up_at);
    // Rows written before the online provider existed have no source: treat them as stale
    // so an upgrade replaces the old, wrong coordinates automatically.
    if (!row.source) return false;
    if (row.source === 'offline') return age < retrySeconds;
    return age < ttlSeconds;
  }

  function ensureRow(ip) {
    const row = selectStmt.get(ip);
    if (isFresh(row)) return row;
    if (provider !== 'offline') {
      queue.add(ip);
      stats.queued += 1;
    }
    if (row) return row;
    // Nothing cached yet: answer from the offline database right away, and let the worker
    // overwrite it with the online answer a moment later.
    const fallback = offlineLookup(ip);
    const now = Math.floor(Date.now() / 1000);
    if (fallback) {
      upsertStmt.run(
        ip,
        fallback.lat,
        fallback.lon,
        fallback.city,
        fallback.region,
        fallback.country,
        fallback.countryCode,
        null,
        'offline',
        now,
      );
    } else {
      upsertStmt.run(ip, null, null, null, null, null, null, null, 'offline', now);
    }
    return selectStmt.get(ip);
  }

  return {
    /** Resolve one address, queueing an online lookup when the cache is cold or stale. */
    resolve(rawIp) {
      const ip = normalizeIp(rawIp);
      if (!ip) return { private: true };
      if (isPrivateIp(ip)) {
        const existing = selectStmt.get(ip);
        if (!existing) {
          db.prepare('INSERT OR REPLACE INTO geo(ip, private, looked_up_at) VALUES (?, 1, ?)').run(
            ip,
            Math.floor(Date.now() / 1000),
          );
        }
        return { private: true, ip };
      }
      const row = ensureRow(ip);
      if (!row) return { private: false, ip, lat: null, lon: null };
      return rowToGeo(row);
    },

    /** One-off lookup for the "locate by IP" helper (cached or offline answer). */
    lookupPublic(rawIp) {
      const ip = normalizeIp(rawIp);
      if (!ip) return { private: true, ip };
      if (isPrivateIp(ip)) return { private: true, ip };
      const row = ensureRow(ip);
      return row ? rowToGeo(row) : { private: false, ip, lat: null, lon: null };
    },

    stats() {
      return { provider, ...stats, pending: queue.size };
    },

    start() {
      if (provider === 'offline') return;
      (async () => {
        while (running) {
          if (queue.size === 0) {
            await sleep(400);
            continue;
          }
          const batch = [...queue].slice(0, BATCH_SIZE);
          batch.forEach((ip) => queue.delete(ip));
          stats.batches += 1;
          try {
            const res = await fetch(IP_API_BATCH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(batch),
              signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error(`ip-api answered ${res.status}`);
            const data = await res.json();
            const now = Math.floor(Date.now() / 1000);
            let updated = 0;
            data.forEach((hit, index) => {
              const ip = batch[index];
              if (!ip) return;
              if (hit && hit.status === 'success' && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)) {
                upsertStmt.run(
                  ip,
                  hit.lat,
                  hit.lon,
                  hit.city || null,
                  hit.regionName || null,
                  hit.country || null,
                  hit.countryCode || null,
                  hit.isp || null,
                  'ip-api',
                  now,
                );
                updated += 1;
                return;
              }
              const message = String((hit && hit.message) || 'unknown');
              if (/quota|limit|rate/i.test(message)) {
                queue.add(ip);
                stats.failed += 1;
                return;
              }
              // Private, reserved or unparseable: keep the offline answer, retry slowly.
              db.prepare("UPDATE geo SET source='offline', looked_up_at=? WHERE ip=?").run(now, ip);
            });
            stats.updated += updated;
            if (updated) log.info('geo batch resolved', { ips: batch.length, updated });
          } catch (err) {
            stats.failed += 1;
            stats.lastError = String(err && err.message);
            log.warn('geo batch failed', { error: stats.lastError, ips: batch.length });
            batch.forEach((ip) => queue.add(ip));
            await sleep(30000);
            continue;
          }
          await sleep(BATCH_INTERVAL_MS);
        }
      })();
    },

    stop() {
      running = false;
    },
  };
}
