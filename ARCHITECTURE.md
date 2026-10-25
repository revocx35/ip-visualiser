# ARCHITECTURE

## Goal

Answer one question at a glance: *who, from where, is hitting my services right now and for
the last N hours?* One hub, many agents — one agent per Nginx Proxy Manager installation.

## Components

```
┌──────────────── agent (per NPM host, docker) ────────────────┐
│ tailer  ──►  parser  ──►  queue  ──►  shipper                │
│ proxy-host-N_access.log    (NPM format)  batched POST        │
└──────────────────────────────────────────────────────────────┘
                              │  Bearer token, HTTPS
                              ▼
┌──────────────────────── hub (docker) ────────────────────────┐
│ http server ──► api.js ──► ingest.js ──► SQLite buckets       │
│            └─► static UI     geo.js ──► geo cache            │
│ UI: canvas world map, lines from IP → server, brightness=age  │
└──────────────────────────────────────────────────────────────┘
```

### Agent

- Discovers `proxy-host-<id>_access.log` in the mounted NPM `logs` directory.
- Remembers `{inode, offset, partial}` per file in `/state/offsets.json`, so restarts do not
  replay data and rotation/truncation is detected.
- Parses NPM's log line (custom format, not nginx `combined`) into
  `{t, ip, host, method, status, bytes, sentTo}`.
- Queues up to 50 000 events in memory, ships batches of 800, retries with exponential
  backoff (1 s → 30 s), sends an empty heartbeat every 25 s so an idle proxy still looks
  online, and exposes `/healthz` on 8099 for Docker health checks.

### Hub

- Zero-framework HTTP server: static files with ETag revalidation, JSON API, JSON-line logs.
- SQLite via `node:sqlite` (built into Node 24) — no native modules, no build toolchain.
- **Storage model:** one row per (server, ip, host, minute) with a counter and byte sum.
  A busy proxy with thousands of requests/minute produces a number of rows proportional to
  distinct IPs × hosts × minutes, not requests.
- **Retention:** prune timer every 60 s deletes buckets older than `retentionHours`
  (default 168 h). Changing the setting prunes immediately.
- **Geo:** `geoip-lite` (offline MaxMind-derived dataset). Lookups are cached in the `geo`
  table, including misses. Private ranges are classified and never drawn.
- **Sessions:** random 32-byte token in an `HttpOnly; SameSite=Lax` cookie (plus `Secure`
  behind TLS), stored as sha256, 7-day sliding expiry, one row per session.

### UI

Vanilla ES modules, one canvas, no bundler:

- Equirectangular projection fitted to the viewport, land polygons pre-rendered once into an
  offscreen canvas (`world.json`, derived from Natural Earth 110 m land).
- Every connection within the window is drawn as a quadratic curve from the client location
  to its server tile, in `server.color || settings.lineColor`, with
  `alpha = 0.05 + 0.95 · (1 - age/window)^1.7` and a width that also follows recency.
  Additive blending (`globalCompositeOperation = 'lighter'`) gives the glow.
- 30–60 fps redraw from `requestAnimationFrame`; only brightness changes between frames, so
  there is no per-frame data fetching. Data refreshes every 10 s.
- Time-window slider is logarithmic (2 min … 24 h, capped by retention); dragging refilters
  client-side instantly and debounces one server refetch.

## API surface

See `README.md`. All endpoints are JSON; agent ingest is the only token-authenticated one.

## Design decisions

| decision | why |
|----------|-----|
| Aggregate into minute buckets in the hub, not raw request rows | keeps a 90-day retention realistic on a small LXC |
| Agent stays dumb (no geo, no storage) | one place to upgrade; an agent is ~350 lines and has no dependencies |
| Offline GeoIP instead of a lookup API | no rate limits, no third-party requests carrying the owner's client IPs |
| `node:sqlite` over better-sqlite3 | no native build in the image, no musl/glibc surprises |
| Local docker build instead of a registry image | the owning repo is private, so a GHCR image would need credentials on every host |
| Server location placed by hand (mini map / IP lookup) | the map should show the *place*, not the geolocation of a reverse proxy's IP |

## Threat model

- **Hub exposure:** published on the LAN, fronted by Nginx Proxy Manager with TLS and (in this
  estate) authentik forward auth in front of the UI. `/api/health` and `/api/ingest` are exempt
  from that gate by design: monitors need an anonymous 200 and agents authenticate with their own
  token. Everything else — including the SPA and `/api/state` — requires an authentik session,
  and the app's own admin session still sits on top.
- **Agents:** reach the hub over the LAN, or over a VPN when the hub is at home and the agent is
  not (this deployment uses a Hysteria2 tunnel whose TUN device lives in the agent's own network
  namespace). The ingest endpoint rejects unknown tokens with 401 and never trusts a body it
  cannot validate.
- **Agent tokens:** 24 random bytes, stored sha256, returned once, rotatable per agent,
  revocable by deleting the agent. A leaked token can inject fake events for its own server
  and nothing else.
- **Admin:** scrypt (N=16384) password hashing, 10-char minimum, per-IP throttle (5 free
  failures then 30 s doubling to 15 min), generic error messages, session invalidation on
  password change.
- **CSRF:** SameSite=Lax cookies plus an origin check on every state-changing request.
- **XSS:** the UI escapes every server-provided string; CSP is `default-src 'self'` with no
  inline scripts.
- **Data sensitivity:** client IPs and hostnames are stored in a local SQLite file on the
  owner's hardware; nothing is sent anywhere except from an agent to its own hub.
- **Containers:** non-root user (`node`), `cap_drop: ALL`, `no-new-privileges`; the agent
  mounts NPM's data directory read-only.
