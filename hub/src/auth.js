import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 32;
const SESSION_TTL_SECONDS = 7 * 86400;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createSession(db, userId) {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, now, now + SESSION_TTL_SECONDS, now);
  return { token, expiresAt: now + SESSION_TTL_SECONDS };
}

export function sessionUser(db, token) {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.id, u.username
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now);
  if (!row) return null;
  // Slide the session forward at most once a minute to keep writes cheap.
  if (now - Number(row.last_seen ?? 0) > 60) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(
      now,
      now + SESSION_TTL_SECONDS,
      row.token_hash,
    );
  }
  return { id: Number(row.id), username: row.username, tokenHash: row.token_hash };
}

export function destroySession(db, tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/** Per-IP login throttle: 5 free failures, then 30s doubling up to 15 min. */
export class LoginThrottle {
  constructor({ free = 5, base = 30, cap = 900, forget = 1800 } = {}) {
    this.free = free;
    this.base = base;
    this.cap = cap;
    this.forget = forget;
    this.buckets = new Map();
  }

  #bucket(key, now = Date.now()) {
    const b = this.buckets.get(key);
    if (!b) return null;
    if (now - b.last > this.forget * 1000) {
      this.buckets.delete(key);
      return null;
    }
    return b;
  }

  /** Returns remaining lockout in seconds, or 0 when a login attempt may proceed. */
  retryAfter(key) {
    const now = Date.now();
    const b = this.#bucket(key, now);
    if (!b || !b.lockedUntil) return 0;
    const left = Math.ceil((b.lockedUntil - now) / 1000);
    return left > 0 ? left : 0;
  }

  fail(key) {
    const now = Date.now();
    const b = this.#bucket(key, now) ?? { fails: 0, lockedUntil: 0, last: now };
    b.fails += 1;
    b.last = now;
    if (b.fails > this.free) {
      const step = b.fails - this.free - 1;
      const delay = Math.min(this.base * 2 ** step, this.cap);
      b.lockedUntil = now + delay * 1000;
    }
    this.buckets.set(key, b);
    return this.retryAfter(key);
  }

  succeed(key) {
    this.buckets.delete(key);
  }
}
