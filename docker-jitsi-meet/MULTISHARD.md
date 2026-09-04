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
| `DEPLOYMENTINFO_SHARD` | `s1` | `s2` | emits `X-Jitsi-Shard`; the edge's cookie/fallback name |
| `DOCKER_HOST_ADDRESS` | this host's LAN IP | this host's LAN IP | media candidate |
| `LOCAL_ADDRESS` | this host's LAN IP | this host's LAN IP | |
| `JVB_ADVERTISE_IPS` | `<amd-wan-ip>,<s1-lan-ip>` | `<amd-wan-ip>,<s2-lan-ip>` | one shared coturn on the AMD; each JVB advertises it + its own LAN IP |
| `JVB_WS_SERVER_ID` | `s1` | `s2` | colibri-ws id — the edge routes `/colibri-ws/<id>/…` on it |
| `COLIBRI_WEBSOCKET_REGEX` | `s1` | `s2` | nginx's own colibri-ws matcher must accept that id |
| `JVB_MUC_NICKNAME` | `jvb-s1` | `jvb-s2` | distinct brewery-MUC occupant |
| `JVB_INSTANCE_ID` | `1` | `2` | |
| `JVB_AUTH_PASSWORD` | unique | unique | each JVB authenticates to its own prosody |
| `JICOFO_AUTH_PASSWORD`, `JVB_AUTH_PASSWORD`, prosody secrets | regenerate per shard | | independent XMPP domains |

Identical on **every** shard:

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://trussal.com` (the edge's public name — all shards claim it) |
| `SIDECAR_CONTROL_TOKEN` | the one fleet secret; must equal `FLEET_CONTROL_TOKEN` on the bots VM |
| `ENABLE_P2P` | `0` (unchanged — all media bridged) |
| `ENABLE_OCTO` | unset / `0` |

`JVB_ADVERTISED_IPS` vs `JVB_ADVERTISE_IPS`: the compose file and `jvb.conf`
read `JVB_ADVERTISE_IPS`; some older `.env` / `env.example` prose uses the
`…D_IPS` spelling. Use `JVB_ADVERTISE_IPS`.

## Bring-up order

1. **Each shard**, on its own host: put the `.env` above in place, then
   `JAMULUS_HOST=jamulus.trussal.com ./run.sh` (full single-host build + stack).
   Confirm the served bundle (`curl -sk https://localhost/custom-config.js | grep -a orderTokens`).
2. **AMD**: `cd edge && docker compose up -d` (the LB). Point Cloudflare's origin
   for `trussal.com` at the AMD:80. coturn, the Jamulus systemd units, and the
   bot conductor also run here, unchanged.
3. **bots VM**: set `SIDECAR_WS_URL` to the **edge** (`wss://trussal.com/ws`) and
   `SIDECAR_CONTROL_URLS` to each shard's own origin-cert URL, comma-separated
   (`edge/README.md`, `bots/.env.example`). `SIDECAR_HOST_ALIAS` still aliases
   each origin name to its LAN IP. `docker compose up -d --force-recreate conductor`.
4. `make check-tokens` (extended to all shard hosts) — every shard's
   `SIDECAR_CONTROL_TOKEN` must equal the bots VM's `FLEET_CONTROL_TOKEN`, or
   that shard discovers no rooms.

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
