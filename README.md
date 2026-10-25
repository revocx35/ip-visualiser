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
GET  /api/servers              list
POST /api/servers              {name, lat, lon, color?}
PATCH|DELETE /api/servers/:id
POST /api/servers/:id/agents   mint an agent + token (token returned once)
PATCH|DELETE /api/agents/:id   rename / remove
POST /api/agents/:id/rotate    new token
GET  /api/geo?ip=…             lat/lon/city/country for a public IP
GET  /api/settings             PATCH: lineColor, timeWindowMinutes, retentionHours
POST /api/password             change the admin password
POST /api/ingest               {agentVersion, events:[{t, ip, host, b}]} (agent only)
```

## Notes

- Geolocation is local (`geoip-lite`, MaxMind-derived data shipped with the npm package);
  no third-party lookup service is contacted and no client IP leaves the hub.
- RFC1918/link-local/loopback addresses are counted and stored but not drawn — they have
  no place on a world map.
- Connection data is aggregated per minute per (server, ip, host), so a busy proxy does
  not blow up the database; retention prunes it every minute.
