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
- **Geo:** ip-api.com batch lookups (100 addresses per request, one request every 1.5 s,
  30-day cache in the `geo` table, `isp` stored for the tooltip) with the bundled `geoip-lite`
  dataset as the instant fallback while a batch is queued. `GEO_PROVIDER=offline` disables all
  outbound lookups. Rows written before the online provider existed carry no `source` column
  value, so an upgrade re-resolves them on first sight instead of keeping stale coordinates.
  Private ranges are classified and never drawn, and never sent to the provider.
- **authentik events (optional):** one poller per authentik instance (home and the VPS each run
  their own; configured through `AUTHENTIK_INSTANCES`) reads `login` / `login_failed` events every 30 s into an `auth_events` table (attempted username, client IP, target app, outcome;
  passwords are never read — authentik masks them). The map draws failed attempts as red rings and
  the server card lists the last hour. It uses a dedicated service account whose only permission is
  `authentik_events.view_event`; the integration is off when `AUTHENTIK_URL` is unset.
- **Sessions:** random 32-byte token in an `HttpOnly; SameSite=Lax` cookie (plus `Secure`
  behind TLS), stored as sha256, 7-day sliding expiry, one row per session.

### View-only listener

A second `http.Server` on `VIEW_PORT` reuses the same DB, geo resolver and state builder but
gets its **own** `buildApi(..., { viewOnly: true })` instance. That instance starts from an
empty route table and registers only four public GETs (`/api/view`, `/api/servers/:id/connections`,
`/api/auth-events`, `/api/health`); the authenticated routes, session lookup and CSRF check are
never built for it, so a write cannot reach the database even by mistake — every non-GET is a
405 and every unknown path a 404. The page is the *same* `index.html`, served with
`data-view-only="1"` injected into the `<html>` tag (no inline script: the CSP forbids it), and
`app.js` reads that attribute to skip `/api/bootstrap`, `/api/me` and every write, hide the tabs
and the sign-out button, poll `/api/view` instead of `/api/state`, and draw ~20 frames per second
instead of 60 (a wall display has nobody watching individual frames, and this cut the CPU of the
reference kiosk from ~3.2 cores to ~1.0). The rate is per screen: `?fps=N` in the kiosk URL, which
matters because the cost scales with how many lines are on the map, not only with the panel size —
the busier node runs `?fps=12`. The LAN restriction is two-layered: the compose port is
published on the host's LAN address only (default `127.0.0.1`), and `VIEW_ALLOW` CIDR matching in
`src/viewallow.js` refuses other peers with a 403. Docker's DNAT preserves the client's source
address for traffic from other hosts (verified: the log shows the real LAN peer), so the CIDR check
sees the actual client; only hairpin traffic from the docker host itself can look like the gateway.

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
- Zoom (1×–12×) and pan are a pure projection transform (`public/viewmath.js`, unit-tested):
  the land/graticule base is re-rendered for the current zoom *and* pan into an offscreen
  canvas and blitted 1:1, which keeps panning gap-free at 60 fps and keeps coastlines crisp at
  any zoom. Viewport clamping keeps the map covering the canvas.
- Time-window slider is logarithmic (2 min … 24 h, capped by retention); dragging refilters
  client-side instantly and debounces one server refetch.

- Clicking a server marker selects it: a ring around the tile plus a card listing its agents and the
  addresses that reached it in the last hour (`GET /api/servers/:id/connections`, refreshed with each poll).

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
  namespace). Ingest is therefore **not published**: both agents post to the hub's own address
  (`http://hub.internal:8920`), and the public host does not forward `/api/ingest` at all. The
  endpoint rejects unknown tokens with 401 and never trusts a body it cannot validate.
- **Agent tokens:** 24 random bytes, stored sha256, returned once, rotatable per agent,
  revocable by deleting the agent. A leaked token can inject fake events for its own server
  and nothing else.
- **View-only port:** intentionally unauthenticated, so it is bound to the LAN address and
  further filtered by `VIEW_ALLOW`. Its API surface is read-only by construction (its own route
  table has no write handlers); it exposes server names, client IPs and proxy hostnames to
  anyone on the local network, which is the accepted trade-off for a screen with no login.
  Never publish it through the reverse proxy or a port forward.
- **Admin:** scrypt (N=16384) password hashing, 10-char minimum, per-IP throttle (5 free
  failures then 30 s doubling to 15 min), generic error messages, session invalidation on
  password change.
- **CSRF:** SameSite=Lax cookies plus an origin check on every state-changing request.
- **XSS:** the UI escapes every server-provided string; CSP is `default-src 'self'` with no
  inline scripts.
- **Data sensitivity:** client IPs and hostnames are stored in a local SQLite file on the
  owner's hardware. The only outbound traffic is the geo batch (client IPs only, no hostnames,
  no user agents) to ip-api.com, and it exists only when `GEO_PROVIDER=ip-api`; set it to
  `offline` to keep everything on the box.
- **Containers:** non-root user (`node`), `cap_drop: ALL`, `no-new-privileges`; the agent
  mounts NPM's data directory read-only.
