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

function lookupRaw(ip) {
  const hit = geoip.lookup(ip);
  if (!hit || !hit.ll) return null;
  return {
    lat: hit.ll[0],
    lon: hit.ll[1],
    city: hit.city || null,
    region: hit.region || null,
    country: hit.country || null,
    countryCode: hit.country || null,
  };
}

/**
 * Resolve an IP to geo data, caching both hits and misses in the `geo` table.
 * Returns { private: true } for RFC1918 / loopback or a geo object.
 */
export function resolveIp(db, rawIp, { refreshMissAfter = 7 * 86400 } = {}) {
  const ip = normalizeIp(rawIp);
  if (!ip) return { private: true };
  if (isPrivateIp(ip)) {
    const existing = db.prepare('SELECT * FROM geo WHERE ip = ?').get(ip);
    if (!existing) {
      db.prepare('INSERT OR REPLACE INTO geo(ip, private, looked_up_at) VALUES (?, 1, ?)').run(
        ip,
        Math.floor(Date.now() / 1000),
      );
    }
    return { private: true, ip };
  }
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT * FROM geo WHERE ip = ?').get(ip);
  if (row && !row.private) {
    if (row.lat !== null || now - Number(row.looked_up_at) < refreshMissAfter) {
      return {
        private: false,
        ip,
        lat: row.lat,
        lon: row.lon,
        city: row.city,
        region: row.region,
        country: row.country,
        countryCode: row.country_code,
      };
    }
  }
  const hit = lookupRaw(ip);
  db.prepare(
    `INSERT INTO geo(ip, private, lat, lon, city, region, country, country_code, looked_up_at)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, city=excluded.city,
       region=excluded.region, country=excluded.country, country_code=excluded.country_code,
       looked_up_at=excluded.looked_up_at, private=0`,
  ).run(
    ip,
    hit ? hit.lat : null,
    hit ? hit.lon : null,
    hit ? hit.city : null,
    hit ? hit.region : null,
    hit ? hit.country : null,
    hit ? hit.countryCode : null,
    now,
  );
  return hit ? { private: false, ip, ...hit } : { private: false, ip, lat: null, lon: null };
}

export function geoLookupPublic(ip) {
  if (isPrivateIp(ip)) return { private: true, ip: normalizeIp(ip) };
  const hit = lookupRaw(normalizeIp(ip));
  return hit ? { private: false, ip: normalizeIp(ip), ...hit } : { private: false, ip: normalizeIp(ip), lat: null, lon: null };
}
