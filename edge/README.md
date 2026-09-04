# Trussal edge tier — consistent-hash room → shard

The public deployment fronts **N full Jitsi shards** (one complete
`docker-jitsi-meet` stack per rack machine — `web` + `prosody` + `jicofo` +
`jvb` + `latency` + `jamulus-relay`) with an HAProxy load balancer that maps
each **room** to exactly one shard by a consistent hash of the room name.

```
Cloudflare (TLS)                          rack LAN 10.20.0.0/24
      │                          ┌────────────────────────────────┐
      ▼                          │  s1  Dell A  10.20.0.11  (full stack)
  AMD :80  ── HAProxy ───────────┤  s2  Dell B  10.20.0.21  (full stack)
   edge/haproxy.cfg              │ (s3  AMD     10.20.0.31  — later)
      │                          └────────────────────────────────┘
   coturn · Jamulus · bot conductor  also on the AMD
```

## Why a room may never span shards

Each shard runs its **own** `latency` sidecar, and the sidecar keeps every
room's roster, RTT/jitter metrics, Yjs metaprogram doc, aggregator claim and
turn state in **one in-memory process with no shared store**
(`latency-instrument/server.js`). So all of a room's traffic — the SPA, XMPP,
`/ws`, `/o2`, colibri-ws, and the room's aggregator bot + the conductor's
per-room `role=fleet`/`role=control` connections — must terminate on the same
shard. The edge guarantees that; nothing downstream coordinates across shards.

This is also what makes the per-shard sidecar *possible*: with rooms pinned,
there is no cross-shard state to replicate.

## How the room is derived (`fe_edge` in `haproxy.cfg`)

The Trussal room is the **last path segment** of the URL
(`getRoomNameFromUrl`, `AggregatorBot#roomAndProto`).

| Request | Room key | Backend | Notes |
|---|---|---|---|
| `GET /<room>` (SPA HTML) | last path segment | `jitsi_room` | consistent hash |
| `GET /ws?room=<room>` , `/o2?room=<room>` | `?room=` param | `jitsi_room` | bots & the aggregator use only this — they never fetch `/<room>` |
| `/http-bind` , `/xmpp-websocket` | *(room is in the body)* | `jitsi_xmpp` | follows the `SHARD` cookie the SPA set, then a per-client-IP stick-table |
| `/libs/…` `/css/…` `/static/…` `/` `/config.js` … | *(none)* | `jitsi_spa` | session-pinned per client IP + `SHARD` cookie, so the `?v=` cache-bust in `index.html` matches the assets that serve it |
| `/colibri-ws/<bridgeId>/…` | `<bridgeId>` (path seg 2) | `jitsi_colibri` | each shard's JVB id **is** the shard name (`JVB_WS_SERVER_ID` / `COLIBRI_WEBSOCKET_REGEX`) |
| `/jamulus-audio` | *(none)* | `jamulus_relays` | every shard relays to the same Jamulus on the AMD — round-robin |

Client IP is taken from `CF-Connecting-IP` (Cloudflare is in front), falling back
to `src`.

### Consistent, not modulo

`hash-type consistent` in `jitsi_room` means **adding shard `s3` re-homes only
~1/3 of rooms**, and **draining a shard re-homes only that shard's rooms** —
instead of `room_number % N` reshuffling almost everything. `src/deploy/room-shard.js`
models the same rendezvous mapping offline; run its tests
(`node --test test/room-shard.test.js`) or:

```js
import { shardDistribution, rehomedFraction } from '../src/deploy/room-shard.js';
shardDistribution(myRoomNames, ['s1','s2']);              // ~50/50
rehomedFraction(myRoomNames, ['s1','s2'], ['s1','s2','s3']); // ~0.33
```

HAProxy is the **runtime authority**; `room-shard.js` is for the conductor's
pre-compute (`bots/src/orchestrator/fleet-service.js`) and
`loadtest/figures/fig11_shard_balance.py`. A small divergence in tie handling is
harmless because the conductor confirms placement from its per-shard discovery.

## What runs on the edge host

`edge/docker-compose.yml` has three host-networked services:

| service | role |
|---|---|
| `edge` | HAProxy — this config |
| `coturn` | the **one** STUN/TURN relay for the whole rack. Every shard's prosody advertises it (`TURN_HOST` / `TURN_CREDENTIALS` in each shard `.env`, the same secret everywhere); shards set `EDGE_MODE=shard` so their own coturn stays inactive. `TURN_EXTERNAL_IP` is kept current by `scripts/refresh-turn-external-ip.sh` (`make deploy-edge` installs its cron). |
| `ddns` | the **one** Cloudflare DNS updater for `trussal.com` (again, off on the shards) |

## Run it

On the AMD:

```bash
cd edge
cp .env.example .env          # CF_API_TOKEN, TURN_CREDENTIALS, TURN_HOST, …
docker compose up -d
docker compose exec -T edge haproxy -c -V -f /usr/local/etc/haproxy/haproxy.cfg   # "Configuration file is valid"
```

or `make deploy-edge` (git pull + up + validate + `kill -s HUP` reload + TURN-IP
refresh/cron). Cloudflare's origin / DNS for `trussal.com` points at the AMD:80.

Each shard's `docker-jitsi-meet/.env`: `PUBLIC_URL=https://trussal.com` (identical
everywhere), `EDGE_MODE=shard`, its own `DEPLOYMENTINFO_SHARD` (`s1` / `s2` / …),
`DOCKER_HOST_ADDRESS` / `LOCAL_ADDRESS` / `JVB_ADVERTISE_IPS` for that machine, a
shard-unique `JVB_AUTH_PASSWORD` / `JVB_MUC_NICKNAME` / `JVB_WS_SERVER_ID`
( = the shard name), and `TURN_HOST` / `TURN_CREDENTIALS` matching the edge.
Full list: `docker-jitsi-meet/MULTISHARD.md`.

## Running degraded / on one machine

Every layer collapses to the single-box path, so the app survives losing any
part of the rack:

- **A shard is down.** Verified: its health check goes red, `hash-type consistent`
  re-homes its rooms onto the survivors, in-flight requests are retried
  (`option redispatch`, `retry-on all-retryable-errors`). **One shard left still
  serves every room.** Recovery re-homes only that shard's rooms back. Zero
  shards up is the only hard-down.
- **Down to one Dell.** It is already a full stack — point Cloudflare straight at
  it and skip the edge. On the bots VM leave `SIDECAR_CONTROL_URLS` unset (one
  control connection) and `SIDECAR_WS_URL` = that host.
- **Only the AMD.** Run a full stack on it: leave `EDGE_MODE` unset (so `run.sh`
  brings up `web`/`prosody`/`jicofo`/`jvb`/`latency` **plus** coturn + ddns via
  the `local-turn` compose profile) and point Cloudflare at it. Optionally still
  run the edge in front of a single `server s1 127.0.0.1:<web-port>`.
- **`make deploy-all`** with `SHARD_VMS` / `EDGE_VM` unset in `.env.deploy` is
  byte-identical to the historical single-VM deploy.
- **`# ring hash`** (the room turn ring) is pure per-browser logic —
  `orderTokens(local roster, room-name seed)` — with no shard or edge awareness
  at all. It behaves identically on one machine or fifty; `test/turn-ring.test.js`
  and the `# ring hash` cases in `test/metaprogram-scheduler.test.js` are the
  single-machine proof (a fake local roster, no network).

## Add or drain a shard

1. Bring the new shard up as a full stack with its own `DEPLOYMENTINFO_SHARD`.
2. Add a `server s3 10.20.0.31:80 check …` line to **every** backend in
   `haproxy.cfg` (`jitsi_room`, `jitsi_spa`, `jitsi_xmpp`, `jitsi_colibri`,
   `jamulus_relays`) and the matching `use-server s3 if …` lines in
   `jitsi_xmpp` and `jitsi_colibri`. Keep existing names unchanged.
3. `docker compose exec edge haproxy -c -f …` then `docker compose kill -s HUP edge`
   (seamless reload).
4. `hash-type consistent` moves ~`1/newN` of rooms onto `s3`; those rooms'
   users reconnect within ~15 s (sidecar roster rebuild). Drain is the reverse:
   comment the `s3` lines out, reload — only rooms that were on `s3` move.

## Health checks

Backends probe `GET /about/health` (jitsi-meet web returns 200). If your `web`
image lacks that route, change the `http-check` lines to `GET /` +
`expect status 200,304`.

## TLS

Cloudflare terminates TLS; HAProxy is a **plain-HTTP LAN origin** (decision 3),
so `bind :80` with no certs. If you later move TLS onto the edge, add
`bind :443 ssl crt …` and an `http-request redirect scheme https` on `:80`.

TURN over TLS (`turns:` on 5349) does need a cert — `edge/docker-compose.yml`'s
`coturn` runs without TLS listeners by default (plain `turn:` on 3478 is enough
behind CF for most clients); add `--cert` / `--pkey` pointing at a mounted cert
and set `TURNS_PORT` if you want `turns:`.

## What this tier does NOT do

- **OCTO / cross-shard bridge relay** — not enabled and not needed: a room lives
  entirely on one shard, so its JVB never has to reach another shard's JVB. Keep
  it as the lever for a future single-huge-room case
  (`docker-jitsi-meet/MULTISHARD.md`).
- **Sidecar research-log aggregation** — each shard writes `SESSION_LOG_DIR`
  JSONL locally; `make collect-session-logs` rsyncs them together for
  `loadtest/analysis/ingest.py`.
