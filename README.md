# ip-visualiser

A world map of who is hitting your services. An **agent** sits next to Nginx Proxy
Manager, tails the per-host access logs and streams connection events to a **hub**.
The hub stores them, resolves public IPs to coordinates and serves a web UI that draws
a line from every client location to the server that received the request.

Lines are brightest for a connection that just happened and fade towards the edge of the
chosen time window; anything older than the window is not drawn at all.

```
browser ──► hub (web UI + SQLite + ingest API)
              ▲
              │ HTTPS, agent token
      ┌───────┴────────┐
   agent            agent
 (NPM at home)   (NPM on VPS)
```

## Components

| part | path | what it does |
|------|------|--------------|
| hub | `hub/` | Node 24, no framework, `node:sqlite`, serves `/` UI + JSON API, ingests agent batches |
| agent | `agent/` | Node 24, tails `proxy-host-*_access.log`, parses NPM's log format, batches to the hub |
| compose | `docker-compose.yml`, `agent/docker-compose.yml` | one stack for the hub, one per agent |
| UI | `hub/public/` | vanilla ES modules + canvas world map, no build step |

## Deploy the hub

```sh
mkdir -p data && chown -R 1000:1000 data   # the container runs as uid 1000 (node)
docker compose up -d --build               # publishes 8920 -> 8080
```

Open the UI, create the admin account on first visit, add a server
(name + place it on the mini map), then press **Add agent** to get a token.

## View-only port (wall display)

The hub can open a **second port that serves the map and nothing else**: no login, no tabs,
no settings, no write endpoints. It exists so a screen on the LAN (a kiosk, a TV, an old
iMac) can show the map permanently without a session that expires or an SSO redirect.

```
VIEW_PORT=8921                      # port inside the container; 0/empty disables the listener
VIEW_ALLOW=192.168.0.0/16           # comma-separated CIDRs allowed to connect (default: RFC1918 + loopback)
```

and publish it on the LAN address only — this is the real access control:

```yaml
ports:
  - "192.168.1.10:8921:8921"         # VIEW_HOST_BIND in the compose file
```

What the view listener serves: `GET /` (the same page with `data-view-only="1"`, so the UI
runs in map-only mode), the five static assets it needs, `GET /api/view` (the map feed — the
same payload as `/api/state`), `GET /api/servers/:id/connections`, `GET /api/auth-events` and
`GET /api/health`. Every other path is a 404 and every non-GET is a 405; no session, no
cookie, no admin route exists on that port. Peers outside `VIEW_ALLOW` get a 403.

Do **not** put this port behind the reverse proxy — the point is that it needs no
authentication, which is only acceptable because it is LAN-bound and read-only.

## Deploy an agent

```sh
cd agent
cp .env.example .env    # HUB_URL, AGENT_TOKEN, AGENT_NAME
docker compose up -d --build
```

Mounts, defaults and knobs are in `agent/docker-compose.yml` and `AGENTS.md`.

## API

All JSON. Cookie session for the UI, `Authorization: Bearer <agent token>` for ingest.

```
GET  /api/bootstrap            setupRequired, version
POST /api/setup                first-run admin creation
POST /api/login | /api/logout  session cookie (HttpOnly, SameSite=Lax)
GET  /api/state?window=120     servers, agents, settings, connections, stats
GET  /api/view?window=120      the same payload, public, **view-only listener only**
GET  /api/servers              list
GET  /api/servers/:id/connections?minutes=60   addresses that reached one server, newest first
POST /api/servers              {name, lat, lon, color?}
PATCH|DELETE /api/servers/:id
POST /api/servers/:id/agents   mint an agent + token (token returned once)
PATCH|DELETE /api/agents/:id   rename / remove
POST /api/agents/:id/rotate    new token
GET  /api/geo?ip=…             lat/lon/city/country for a public IP
GET  /api/auth-events?minutes=60   authentik login attempts (when the integration is on)
GET  /api/settings             PATCH: lineColor, timeWindowMinutes, retentionHours
POST /api/password             change the admin password
POST /api/ingest               {agentVersion, events:[{t, ip, host, b}]} (agent only)
```

## authentik login events (optional)

Set these on the hub to pull authentik's authentication events into the map and the server card:

Several instances can be polled at once (each has its own cursor and server attribution) with
`AUTHENTIK_INSTANCES`, a JSON array; the single-instance variables below are the shorthand:

```
AUTHENTIK_INSTANCES=[{"url":"https://authentik.internal:9443","token":"...","server":"home",
                      "insecure":true},{"url":"https://auth.example.com","token":"...","server":"vps"}]

# or a single instance:
AUTHENTIK_URL=https://authentik.internal:9443   # direct API address, not necessarily the public host
AUTHENTIK_TOKEN=<api token>                 # service account with authentik_events.view_event only
AUTHENTIK_SERVER=home                       # server name the events are attributed to
AUTHENTIK_HOST=auth.example.com             # do not report this host as the target app
AUTHENTIK_BACKFILL_HOURS=168                # how far back the first poll reaches
```

The hub polls `action=login` and `action=login_failed` every 30 s, stores the attempted username,
IP, target app and outcome (never the password — authentik masks it) and draws failed attempts as
red rings. Leaving `AUTHENTIK_URL` empty disables the integration completely.

## Notes

- The UI is normally put behind authentik forward auth (NPM advanced config). Two endpoints are
  deliberately exempt: `/api/health` (uptime monitors) and `/api/ingest` (agents authenticate with
  their own bearer token). Gating ingest breaks every agent with a 302.
- Geolocation comes from the online **ip-api.com** batch API (`GEO_PROVIDER=ip-api`, the default):
  addresses are resolved in batches of 100 with the answers cached in SQLite for `GEO_TTL_DAYS`
  (30 by default). The bundled offline database (`geoip-lite`) is the immediate fallback while a
  batch is in flight, and `GEO_PROVIDER=offline` turns the network lookups off completely.
  Note the trade-off: with the online provider the client IPs are sent to ip-api.com.
- The map zooms (scroll, pinch, +/− buttons, double-click) and pans (drag), 1×–12×; the
  graticule densifies as you zoom in.
- RFC1918/link-local/loopback addresses are counted and stored but not drawn — they have
  no place on a world map.
- Connection data is aggregated per minute per (server, ip, host), so a busy proxy does
  not blow up the database; retention prunes it every minute.
