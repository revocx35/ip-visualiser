// Peer filtering for the view-only listener.
//
// The view port has no authentication on purpose (it is a wall display on the LAN), so the
// one thing standing between it and a stranger is which addresses may reach it. Two layers
// do that: the compose file publishes the port on the LAN address only, and this check
// refuses anything outside the configured CIDRs. Kept as pure functions so it can be
// unit-tested without a socket.

export const DEFAULT_VIEW_ALLOW =
  '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7,fe80::/10';

export function parseCidrs(raw) {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_VIEW_ALLOW.split(',');
}

function v4ToBigInt(value) {
  const parts = String(value ?? '').trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function v6ToBigInt(value) {
  let str = String(value ?? '').trim().toLowerCase().split('%')[0];
  if (!str.includes(':')) return null;
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out = (out << 16n) | BigInt(parseInt(group, 16));
  }
  return out;
}

// "::ffff:192.168.1.9" is an IPv4 peer that the socket layer wrapped in IPv6.
function normalize(ip) {
  const value = String(ip ?? '').trim();
  if (!value) return '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped ? mapped[1] : value;
}

export function ipInCidr(ip, cidr) {
  const addr = normalize(ip);
  if (!addr) return false;
  const [netRaw, bitsRaw] = String(cidr ?? '').trim().split('/');
  const net = String(netRaw ?? '').trim();
  if (!net) return false;
  const isV6 = net.includes(':');
  const width = isV6 ? 128 : 32;
  const bits = bitsRaw === undefined || bitsRaw === '' ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;

  const netValue = isV6 ? v6ToBigInt(net) : v4ToBigInt(net);
  const ipValue = isV6 ? v6ToBigInt(addr) : v4ToBigInt(addr);
  if (netValue === null || ipValue === null) return false;

  const shift = BigInt(width - bits);
  return ipValue >> shift === netValue >> shift;
}

export function isViewAllowed(ip, cidrs = parseCidrs()) {
  return (cidrs || []).some((cidr) => ipInCidr(ip, cidr));
}
