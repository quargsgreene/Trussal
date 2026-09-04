# Running Trussal as N sharded Jitsi stacks

The public deployment fronts **one full `docker-jitsi-meet` stack per rack
machine** ("shard") with the consistent-hash edge LB in `../edge/`. Each shard
is an ordinary single-host Trussal stack — `web` + `prosody` + `jicofo` + `jvb`
+ `latency` + `jamulus-relay` — brought up by `./run.sh` exactly as today. The
only differences are a handful of per-shard `.env` values and the edge in front.

A room lives **entirely on one shard** (the edge pins every one of its surfaces
there), so no shard ever has to talk to another: **OCTO / cross-shard bridge
relay stays OFF**. See "When you would enable OCTO" at the bottom.

## Per-shard `docker-jitsi-meet/.env`

`.env` is gitignored and lives on each shard host. Start from the current
production `.env` and change only these:

| Key | s1 (Dell A) | s2 (Dell B) | Why |
|---|---|---|---|
| `EDGE_MODE` | `shard` | `shard` | `run.sh` then skips coturn + ddns + the TURN-IP cron — the edge host owns those |
| `DEPLOYMENTINFO_SHARD` | `s1` | `s2` | emits `X-Jitsi-Shard`; the edge's cookie/fallback name |
| `DOCKER_HOST_ADDRESS` | this host's LAN IP | this host's LAN IP | media candidate |
| `LOCAL_ADDRESS` | this host's LAN IP | this host's LAN IP | |
| `JVB_ADVERTISE_IPS` | `<wan-ip>#<s1-jvb-port>,<s1-lan-ip>` | `<wan-ip>#<s2-jvb-port>,<s2-lan-ip>` | one WAN IP for the rack — give each shard's JVB its own external UDP port (below) and advertise it |
| `JVB_PORT` | `10000` | `10001` | distinct external media port; the router forwards each to its Dell |
| `JVB_WS_SERVER_ID` | `s1` | `s2` | colibri-ws id — the edge routes `/colibri-ws/<id>/…` on it |
| `COLIBRI_WEBSOCKET_REGEX` | `s1` | `s2` | nginx's own colibri-ws matcher must accept that id |
| `JVB_MUC_NICKNAME` | `jvb-s1` | `jvb-s2` | distinct brewery-MUC occupant |
| `JVB_INSTANCE_ID` | `1` | `2` | |
| `JVB_AUTH_PASSWORD` | unique | unique | each JVB authenticates to its own prosody |
| `JICOFO_AUTH_PASSWORD`, prosody secrets | regenerate per shard | | independent XMPP domains |

Identical on **every** shard:

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://trussal.com` (the edge's public name — all shards claim it) |
| `TURN_HOST` | `trussal.com` — clients reach the one coturn on the edge |
| `TURN_CREDENTIALS` | the one TURN secret; must equal `edge/.env` `TURN_CREDENTIALS` |
| `SIDECAR_CONTROL_TOKEN` | the one fleet secret; must equal `FLEET_CONTROL_TOKEN` on the bots VM |
| `ENABLE_P2P` | `0` (unchanged — all media bridged) |
| `ENABLE_OCTO` | unset / `0` |

**Single WAN IP.** A home rack has one public IP for all three machines. TURN
relay (3478/5349) is forwarded from the router to the **edge**; each shard's JVB
media port (`JVB_PORT` above, `10000` / `10001` / …) is forwarded to **that
shard**. `JVB_ADVERTISE_IPS` carries the `<wan-ip>#<port>` so ICE offers the
right port per shard. If you instead have a public IP per machine, drop the
`#port` juggling and give each its own.

`JVB_ADVERTISED_IPS` vs `JVB_ADVERTISE_IPS`: the compose file and `jvb.conf`
read `JVB_ADVERTISE_IPS`; some older `.env` / `env.example` prose uses the
`…D_IPS` spelling. Use `JVB_ADVERTISE_IPS`.

## Bring-up order

Fill `.env.deploy` (`SHARD_VMS`, `EDGE_VM`, …) and run `make deploy-multishard`,
or by hand:

1. **AMD (edge)**: `cd edge && cp .env.example .env` (fill `CF_API_TOKEN`,
   `TURN_CREDENTIALS`, `TURN_HOST`), then `make deploy-edge` — HAProxy + the
   rack's one `coturn` + `ddns`, config validated, TURN-IP refresh cron
   installed. Jamulus systemd units and the bot conductor also live here.
   Point Cloudflare's origin for `trussal.com` at the AMD:80.
2. **Each shard**, on its own host: `.env` per the tables above (incl.
   `EDGE_MODE=shard`), then `JAMULUS_HOST=jamulus.trussal.com ./run.sh`
   (full single-host build + stack, coturn/ddns skipped). Confirm the served
   bundle: `curl -sk https://localhost/custom-config.js | grep -a orderTokens`,
   and the `?v=` matches the commit: `curl -sk https://localhost/ | grep -o 'v=[0-9a-f-]*'`.
3. **bots VM**: `SIDECAR_WS_URL` = the **edge** (`wss://trussal.com/ws`, routes
   per-room `?role=fleet` by `?room=`); `SIDECAR_CONTROL_URLS` = each shard's own
   origin-cert URL, comma-separated (`bots/.env.example`). `SIDECAR_HOST_ALIAS`
   still aliases each origin name to its LAN IP.
   `docker compose up -d --force-recreate conductor`.
4. `make check-tokens` — every shard's `SIDECAR_CONTROL_TOKEN` must equal the
   bots VM's `FLEET_CONTROL_TOKEN`, or that shard discovers no rooms.

Losing a shard, or running everything on one box, is covered in
`edge/README.md` → "Running degraded / on one machine".

## Verifying a room is pinned

Open `https://trussal.com/somroom` in two browsers. In each shard's logs, only
ONE shard should show that room's nginx hits, `latency` roster, prosody MUC and
JVB conference. `curl -skI https://trussal.com/someroom | grep -i x-jitsi-shard`
names it; a second participant and the room's aggregator must report the same.

## When you would enable OCTO

Only for a **single room too large for one JVB** (hundreds of participants).
Then, per shard: `ENABLE_OCTO=1`, `ENABLE_OCTO_SCTP` matched between `jvb` and
`jicofo` (they crash if they disagree — see `jicofo.conf`), set
`JVB_OCTO_REGION` / `JICOFO_OCTO_REGION`, and
`OCTO_BRIDGE_SELECTION_STRATEGY=RegionBasedBridgeSelectionStrategy` +
`JICOFO_BRIDGE_REGION_GROUPS`. That is a different axis from this document —
it splits one *conference* across bridges; the edge here splits *rooms* across
shards and needs none of it.
