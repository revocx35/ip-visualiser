import { normalizeIp } from './geo.js';

/**
 * The address a request came from, for logging and the login throttle.
 *
 * Behind a reverse proxy (TRUST_PROXY) the client address is the one the proxy *appended*
 * to X-Forwarded-For, i.e. the right-most entry. Everything left of it was sent by the
 * client itself and is attacker-controlled: keying the login throttle on the left-most
 * entry let anyone pick a fresh address per attempt and never get locked out.
 */
export function clientIpFrom(headers, remoteAddress, trustProxy) {
  if (trustProxy) {
    const xff = headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return normalizeIp(hops[hops.length - 1]);
    }
  }
  return normalizeIp(remoteAddress);
}
