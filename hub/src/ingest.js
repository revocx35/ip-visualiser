import { isIpAddress, normalizeIp } from './geo.js';

const MAX_EVENTS = 5000;

/**
 * Validate and store a batch of events coming from an agent.
 * Every event is rolled up into a per-minute bucket so a busy proxy does not
 * grow the database by one row per request.
 */
export function ingestBatch(db, agent, body) {
  const events = Array.isArray(body?.events) ? body.events : null;
  if (!events) return { accepted: 0, rejected: body?.events === undefined ? 0 : -1 };
  if (events.length > MAX_EVENTS) return { accepted: 0, rejected: events.length, error: 'batch too large' };

  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(
    `INSERT INTO buckets(server_id, ip, host, ts_minute, count, bytes)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(server_id, ip, host, ts_minute)
     DO UPDATE SET count = count + 1, bytes = bytes + excluded.bytes`,
  );

  let accepted = 0;
  let rejected = 0;
  db.exec('BEGIN');
  try {
    for (const ev of events) {
      const ip = normalizeIp(ev?.ip);
      const host = typeof ev?.host === 'string' ? ev.host.slice(0, 253) : '';
      let ts = Number(ev?.t);
      if (!ip || !isIpAddress(ip) || !host || !Number.isFinite(ts)) {
        rejected += 1;
        continue;
      }
      ts = Math.floor(ts);
      if (ts > now + 300) ts = now; // clock skew guard
      if (ts < now - 400 * 86400) {
        rejected += 1;
        continue;
      }
      const bytes = Number.isFinite(Number(ev?.b)) ? Math.max(0, Math.min(Number(ev.b), 1e9)) : 0;
      stmt.run(Number(agent.server_id), ip, host, Math.floor(ts / 60) * 60, Math.floor(bytes));
      accepted += 1;
    }
    if (accepted > 0) {
      db.prepare('UPDATE agents SET events_total = events_total + ? WHERE id = ?').run(accepted, Number(agent.id));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { accepted, rejected };
}

export function touchAgent(db, agentId, remoteIp, version) {
  db.prepare('UPDATE agents SET last_seen = ?, remote_ip = ?, version = COALESCE(?, version) WHERE id = ?').run(
    Math.floor(Date.now() / 1000),
    remoteIp || null,
    typeof version === 'string' ? version.slice(0, 40) : null,
    Number(agentId),
  );
}
