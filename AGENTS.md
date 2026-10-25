# AGENTS.md — ip-visualiser

Working notes for anyone (human or agent) changing this repo. `ARCHITECTURE.md` explains the
design; this file is the practical map.

## Layout

```
hub/                 the server: web UI + JSON API + SQLite
  src/index.js       http servers (authenticated + view-only), static files, logging
  src/api.js         route table; buildApi({viewOnly}) returns the read-only surface
  src/viewallow.js   CIDR matching for the view-only listener (unit-tested)
  src/db.js          node:sqlite schema, settings helpers, retention prune
  src/geo.js         ip-api batch resolver + geoip-lite fallback
  src/authentik.js   optional authentik login-event pollers
  public/            the UI (vanilla ES modules, no build step): index.html, app.js, style.css,
                     viewmath.js (projection maths, unit-tested), world.json (land polygons)
  test/              node --test files
agent/               the log tailer that ships events to the hub
docker-compose.yml   hub stack; agent/docker-compose.yml for an agent
```

## Commands

```sh
cd hub   && npm test             # node --test test/*.test.js
cd agent && npm test
node --check hub/public/app.js   # the UI has no build step, so syntax-check the bundle
docker compose up -d --build     # hub; data/ must be owned by uid 1000
```

Run a throwaway hub locally (no docker) to poke at the API:

```sh
cd hub && PORT=18080 VIEW_PORT=18921 VIEW_BIND=127.0.0.1 DB_PATH=/tmp/ipv.db node src/index.js
curl -s localhost:18080/api/health
```

## Conventions

- Node 24, ESM, zero dependencies in the UI and in the agent; the hub takes only `geoip-lite`.
- No framework, no bundler, no build step. If a change needs one, it is the wrong change.
- `hub/src/api.js` is the only place routes are declared. Handlers that both APIs need are named
  functions (`stateHandler`, `connectionsHandler`, `authEventsHandler`, `healthHandler`).
- The version lives in `hub/package.json` only; `index.js` reads it and passes it to `buildApi`.
- Log lines are JSON (`{"ts","level","msg",...}`); keep them greppable.
- UI text goes through `esc()`; the CSP forbids inline scripts, so pass flags through HTML
  attributes (`data-view-only`) — never inject a `<script>`.

## Never

- Never add a route to the view-only API that writes, needs a session, or is not a GET.
- Never publish `VIEW_PORT` through the reverse proxy, a port forward, or `0.0.0.0` on a host that
  is not LAN-bound. It has no authentication by design.
- Never trust `X-Forwarded-For` on the view-only listener.
- Never store client IPs anywhere but the local SQLite file, and never turn on an outbound geo
  provider without knowing that client IPs leave the box (`GEO_PROVIDER=offline` prevents it).
- Never log request bodies, agent tokens or passwords.

## Gotchas

- `public/world.json` is a single ~96 KB line; `wc -l` reports 0. That is normal.
- `node:sqlite` throws if the data dir is not writable by uid 1000 — chown `data/` before `up`.
- The server card refreshes through `applyState()` → `map.loadConnections()`; a new poll field must
  be added there or the card silently goes stale.
- `buildApi(...)` registers `/api/bootstrap`, `/api/setup`, `/api/login` and `/api/ingest` as public
  routes *before* the `viewOnly` branch, so that branch clears `publicRoutes` first — without it
  the kiosk port would serve `/api/bootstrap`.
- A published docker port keeps the client's source address for traffic from other hosts (the
  `VIEW_ALLOW` check sees the real peer), but hairpin traffic from the docker host itself can look
  like the bridge gateway.
- The view-only page draws every third frame (~20 fps). That is deliberate: 60 fps full-screen
  canvas cost ~3 cores on the reference kiosk host, 20 fps costs ~1 and looks the same.
