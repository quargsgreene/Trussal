# `# ring` — how the NetCycles rotation order is chosen

The metaprogram's `$ participants` line is a scheduling sequence: it names the
tokens that take turns and, in `<…>` alternation, the order they take them. The
`# ring` directive chooses how that rotation order is **derived**.

```
'metaprogram editor'
$ participants <0>
# ring hash
# cycles "wcl" 20
```

That is the default program (`buildDefaultProgram()`), so a fresh room already
runs `# ring hash`.

## The two modes

### `# ring hash` (default)

The rotation is the **consistent-hash order of the room's PRESENT tokens**,
recomputed every cycle from the live roster (`src/audio-net/TurnRing.js`,
`orderTokens`). What `$ participants` lists no longer decides who plays — every
non-aggregator participant in the room takes turns as soon as they join, and a
join or leave needs **no `$ participants` edit and no CRDT round-trip**.

`$ participants <0>` must still be present (a program has a `$` scheduling
sequence — the grammar requires it) but its contents seed nothing in hash mode.

The hash is *weighted rendezvous* (HRW): the order is a pure function of
`(the set of present tokens, the room name as seed)`, so every browser and the
aggregator compute the identical ring with nothing stored. Its defining
property is **minimal disruption** — adding or removing one token leaves every
other token's successor unchanged, so a join/leave perturbs O(1/N) of the ring
instead of reshuffling it. (Absolute slot *positions* do shift, by design; what
is preserved is who-follows-whom and where a leaver lands when it rejoins.)

### `# ring explicit`

The literal walk: the rotation is exactly the `$ participants <…>` sequence a
performer maintains by hand, and an unlisted participant stays silent until an
edit adds their token. This is byte-identical to Trussal before `# ring` existed
— **an older program with no `# ring` line at all is treated as `explicit`.**

## Biasing turn share — `w <token> <weight> …`

Only with `# ring hash`. Each pair gives a token a weight (a positive number;
absent = 1); a token with twice the weight wins about twice as many turns.

```
# ring hash w 0 3 2a 2
```

Token `0` gets ~3× a normal share of turns, `2a` ~2×, everyone else 1×.
Weights on `# ring explicit` are a parse error.

## Errors

- `# ring` with no mode, or a mode other than `explicit` / `hash`
- a second `# ring` line (`duplicate # ring directive`)
- `w` with no `<token> <weight>` pair, or a non-positive / non-numeric weight
- `w` on `# ring explicit`

## How it runs everywhere the same

`src/audio-net/TurnRing.js` is a pure module (no DOM, no audio, no imports) with
the same determinism contract as `SeededRandom.js`. `MetaprogramScheduler`
calls `orderTokens(roster, { seed, weights })` at each cycle boundary;
`Metaprogrammer.startScheduler` (browser) and `AggregatorBot` (the aggregator's
own scheduler) each wire the **same** roster (present non-aggregator room-index
tokens) and the **same** seed (the room name, lowercased to match the sidecar's
normalisation). So the ring each client outlines locally and the ring the
aggregator streams are one and the same. If a scheduler is built without a
roster wired, hash mode falls back to the literal `$ participants` until one is.

Distinct from `src/deploy/room-shard.js`, which uses the same hash primitive
(`fnv1a32` / `hashUnitInterval`) at a completely different layer — mapping a
whole *room* onto a Jitsi *shard* at the edge load balancer (`edge/README.md`).
