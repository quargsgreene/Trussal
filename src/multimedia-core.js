// multimedia-core.js — multiArrange() and multiStack(): Strudel's arrange()
// and stack() for every medium a JPattern voice can carry, with an arrangement
// that picks up where it left off on each of its performer's turns.
//
// --- Why arrange() and stack() alone are audio-only here ---------------------
//
// Every silent medium (word(), css(), image(), poll(), reaction(), …) is
// rewritten per STATEMENT, and its renderer is appended to the end of that
// statement. A renderer carries a dominant trigger, which keeps webaudio away
// from every hap it touches — so in
//
//     arrange([4, s("bd*4")], [4, word("hello")])
//
// the text renderer lands on the whole arrangement and the drums go silent
// with it. Hydra was never in reach at all: a Hydra chain is not a pattern.
//
// So, two halves:
//   - every hap a multi pattern produces is tagged `context.multimedia`, and
//     silentRenderer() — what each capability registers its renderer with —
//     only claims a tagged hap of its OWN medium. An untagged hap (every voice
//     written without these functions) is claimed exactly as before.
//   - a Hydra chain member (an unrendered source such as `osc(10).kaleid()`,
//     written without `.out()`) becomes a pattern of its own whose trigger
//     renders it, so the section boundaries that move the sound move the
//     visuals too.
//
// --- The turn clock ----------------------------------------------------------
//
// Strudel's arrange() reads the room's cycle clock, so a performer who is off
// the ring for three turns comes back three turns further into their
// arrangement, having skipped whatever played to nobody. multiArrange() by
// default reads a per-performer TURN clock instead: it advances only while that
// performer holds the turn and stands still in between, so each turn resumes
// the arrangement where the last one stopped. Pass `{ resume: false }` as the
// last argument for arrange()'s room clock.
//
// The clock keeps the room's phase: a turn re-enters at a whole-cycle offset
// from the room clock, never a fractional one, so a bar still starts on the
// room's bar line. The cost is that a turn which ended mid-cycle replays the
// part of that cycle already heard — never more than one cycle — rather than
// skipping the part that wasn't.
//
// No DOM and no Strudel import: the Strudel namespace (`ns`) and the room
// (`env`) are handed to createMultimedia, so this runs under node:test against
// @strudel/core and in the browser against @strudel/web. The browser half
// (whose turn it is, what a peer may reach on this page, drawing a Hydra
// section) is multimedia.js.

import { FILE_PARAMS } from './file-cycles-core.js';

// A call to either function, as written. hydra-code.js asks it to tell a
// Strudel-driven Hydra performer from one whose preamble draws everything.
export const MULTI_CALL_RE = /(?:^|[^\w$.])(?:multiArrange|multiStack)\s*\(/;
const MULTI_CALL_GLOBAL_RE = /(^|[^\w$.])(multiArrange|multiStack)\s*\(/g;

// The value key a Hydra section's haps carry. The source itself never rides
// the value — it is held by the section's trigger — so nothing that prints or
// serialises a hap can reach a Hydra object graph.
export const HYDRA_VALUE_KEY = '_mmHydra';

// Each medium, by the value keys its renderer reads. A hap carrying none of
// them is audio.
const MEDIUM_KEYS = {
  text: ['word'],
  css: ['css'],
  file: FILE_PARAMS,
  poll: ['poll'],
  reaction: ['reaction'],
  panel: ['panel'],
  breakout: ['breakout', 'assign'],
  meeting: ['meeting'],
  hydra: [HYDRA_VALUE_KEY],
};

// Media only their author's browser may act on (see buildPeerBlock): every
// other browser evaluating the same program must not fire them a second time.
export const LOCAL_ONLY_MEDIA = ['reaction', 'panel', 'breakout', 'meeting'];
// Media painted into each viewer's own page and never published — the ones
// that survive the aggregator's exclusion of a remote performer's audio.
export const PER_PAGE_MEDIA = ['text', 'css', 'file', 'poll'];

// Every medium a hap value belongs to; empty means audio. A value can belong
// to two (a word() voice that also chains css()), and then both renderers
// claim it, as they always have.
export function mediaOf(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(MEDIUM_KEYS).filter((medium) => ownsMedium(value, medium));
}

export function ownsMedium(value, medium) {
  const keys = MEDIUM_KEYS[medium];
  return !!keys && !!value && typeof value === 'object' && keys.some((k) => value[k] != null);
}

// The renderer every silent capability registers: Pattern.onTrigger(handler,
// true), except that a hap produced by multiArrange()/multiStack() is claimed
// only when it belongs to `medium`. That is what lets one statement hold audio
// and words side by side — the text renderer appended to the statement no
// longer silences the drums sharing it.
export function silentRenderer(handler, medium) {
  return (pat) => pat.withHap((hap) => {
    if (hap.context?.multimedia && !ownsMedium(hap.value, medium)) return hap;
    return hap.setContext({
      ...hap.context,
      onTrigger: (...args) => {
        hap.context.onTrigger?.(...args);
        handler(...args);
      },
      // What keeps webaudio away from this hap — see Pattern.onTrigger.
      dominantTrigger: true,
    });
  });
}

// Give each multiArrange(/multiStack( call in one peer's code that peer's id,
// so its arrangement follows THEIR turns. Every browser evaluates every peer's
// program, so the call alone cannot know whose it is. Single-quoted: the
// transpiler mini-parses double-quoted strings.
export function injectMultiPeer(code, peerId) {
  const id = String(peerId ?? '').replace(/[\\']/g, '\\$&');
  return String(code ?? '').replace(MULTI_CALL_GLOBAL_RE, (match, before, name) =>
    `${before}${name === 'multiArrange' ? '_mmArrange' : '_mmStack'}('${id}', `);
}

// --- Turn clock ----------------------------------------------------------------

// Breakpoints sit on a 1/1024-cycle grid, so every one is an exact Fraction and
// shifting a hap never grows a denominator.
const GRID = 1024;
// The scheduler's cycle going backwards by more than this means it restarted
// (stop/play, or a cycle reset), and the history no longer describes it.
const RESTART_SLACK = GRID;

// One performer's turn history, as the room clock → turn clock mapping it
// implies. Each point is a change of state at room cycle `at` (grid units):
// on — turn time is room time minus a whole number of cycles (`offset`);
// off — turn time stands still at `frozen` (grid units). Before the first
// point the performer is taken to be on with no offset, which is the room
// clock: with no turn signal at all, multiArrange() IS arrange().
export class TurnLedger {
  constructor({ limit = 64 } = {}) {
    this.points = [];
    this.limit = limit;
  }

  // Record the turn state seen at room cycle `now`. Only a change of state
  // adds a point, so this is cheap to call on every query.
  observe(now, onTurn) {
    if (!Number.isFinite(now)) return;
    const at = Math.round(now * GRID);
    let last = this.points[this.points.length - 1];
    if (last && at < last.at - RESTART_SLACK) {
      this.points = [];
      last = undefined;
    }
    const wasOn = last ? last.on : true;
    if (!!onTurn === wasOn) return;
    // Monotonic even if `now` wobbles back a hair between two reads.
    const when = last ? Math.max(at, last.at) : at;
    if (onTurn) {
      // Re-enter at the latest whole-cycle offset that does not skip ahead of
      // where the last turn stopped.
      const offset = Math.ceil((when - last.frozen) / GRID);
      this.points.push({ at: when, on: true, offset });
    } else {
      const offset = last ? last.offset : 0;
      this.points.push({ at: when, on: false, frozen: when - offset * GRID });
    }
    if (this.points.length > this.limit) this.points.splice(0, this.points.length - this.limit);
  }

  // The mapping as consecutive segments of room time (grid units, `null` for
  // an open end), each either on with an offset in whole cycles, or off.
  segments() {
    const out = [];
    let from = null;
    let on = true;
    let offset = 0;
    for (const p of this.points) {
      out.push({ from, to: p.at, on, offset });
      from = p.at;
      on = p.on;
      offset = p.on ? p.offset : 0;
    }
    out.push({ from, to: null, on, offset });
    return out;
  }

  // Turn time at room cycle `cycle`, as a number — for inspection and tests;
  // the pattern itself works on segments().
  turnTime(cycle) {
    const at = cycle * GRID;
    let state = { on: true, offset: 0 };
    for (const p of this.points) {
      if (p.at > at) break;
      state = p;
    }
    return state.on ? cycle - state.offset : state.frozen / GRID;
  }
}

// --- Patterns -----------------------------------------------------------------

function isHydraSource(x) {
  return !!x && typeof x === 'object' && x.type === 'GlslSource'
    && typeof x.out === 'function' && Array.isArray(x.transforms);
}

// `ns` — the Strudel namespace (Pattern, TimeSpan, Fraction, pure, reify,
// sequence, stack, arrange, silence). `env` — the room, all optional:
//   now()                  the scheduler's current cycle, or null
//   isOnTurn(peer)         whether `peer` holds the turn right now
//   allows(peer, medium)   whether `peer`'s haps of `medium` may play on this page
//   renderHydra(request)   draw a Hydra section: { source, output, peer,
//                          hap, currentTime, cps, targetTime }
// Returns { multiArrange, multiStack, ledgerFor }, each function taking the
// owning peer's id first.
export function createMultimedia(ns, env = {}) {
  const ledgers = new Map();
  const ledgerFor = (peer) => {
    const key = String(peer ?? '');
    let ledger = ledgers.get(key);
    if (!ledger) { ledger = new TurnLedger(); ledgers.set(key, ledger); }
    return ledger;
  };

  const gridTime = (units) => ns.Fraction(`${units}/${GRID}`);

  const now = () => {
    try {
      const n = Number(env.now ? env.now() : NaN);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };

  // A trailing plain object is options, never a member: members are
  // patterns, arrays, plain values or Hydra chains.
  const takeOptions = (args) => {
    const last = args[args.length - 1];
    const isOptions = !!last && typeof last === 'object' && !Array.isArray(last)
      && !(last instanceof ns.Pattern) && !isHydraSource(last);
    return isOptions ? [args.slice(0, -1), last] : [args, {}];
  };

  const allows = (peer, value) => {
    if (!env.allows) return true;
    const media = mediaOf(value);
    return media.length
      ? media.every((medium) => env.allows(peer, medium))
      : env.allows(peer, 'audio');
  };

  // One hap per cycle, rendered by its trigger. Dominant like every silent
  // renderer, so a Hydra section can never reach webaudio.
  const hydraPattern = (source, ctx) => ns.pure({ [HYDRA_VALUE_KEY]: true })
    .onTrigger((hap, currentTime, cps, targetTime) => {
      env.renderHydra?.({ source, output: ctx.output, peer: ctx.peer, hap, currentTime, cps, targetTime });
    }, true);

  // Several Hydra chains stacked together: an equal-weight mix, the visual
  // counterpart of stacking sounds. Built on a fresh solid() where the synth
  // offers one, because Hydra's chain methods mutate the source they are
  // called on and the performer's own chains must stay as written.
  const blendHydra = (sources) => {
    const [first, ...others] = sources;
    if (!others.length) return first;
    const solid = first.synth?.generators?.solid;
    let mix = typeof solid === 'function' ? solid(0, 0, 0, 0).blend(first, 1) : first;
    others.forEach((source, i) => { mix = mix.blend(source, 1 / (i + 2)); });
    return mix;
  };

  const memberPattern = (member, ctx) => {
    if (isHydraSource(member)) return hydraPattern(member, ctx);
    // Strudel's own rule for stack(): an array is a sequence.
    if (Array.isArray(member)) return ns.sequence(...member.map((m) => memberPattern(m, ctx)));
    if (member == null) {
      throw new Error(`${ctx.fn}: a member is ${member} — Hydra chains go in without .out(), e.g. osc(10).kaleid()`);
    }
    return ns.reify(member);
  };

  const stackMembers = (members, ctx) => {
    const hydra = members.filter(isHydraSource);
    const pats = members.filter((m) => !isHydraSource(m)).map((m) => memberPattern(m, ctx));
    if (hydra.length) pats.push(hydraPattern(blendHydra(hydra), ctx));
    return pats.length === 1 ? pats[0] : ns.stack(...pats);
  };

  // Tag every hap so the silent renderers only take their own medium, and drop
  // the media this page may not play for this peer.
  const finalize = (pat, peer) => pat.withHaps((haps) => haps
    .filter((hap) => allows(peer, hap.value))
    .map((hap) => (hap.context?.multimedia
      ? hap
      : hap.setContext({ ...hap.context, multimedia: true }))));

  // `pat` on the peer's turn clock. Queried in room time; each on-segment of
  // the query is queried from `pat` in turn time and shifted back, and an
  // off-segment yields nothing.
  const resumeOnTurns = (pat, peer) => {
    const ledger = ledgerFor(peer);
    const result = new ns.Pattern((state) => {
      // A multiArrange nested in another one is already being queried in turn
      // time; mapping again would count the same turns twice.
      if (state.controls?._mmTurnTime) return pat.query(state);
      const cycle = now();
      if (cycle != null) ledger.observe(cycle, env.isOnTurn ? !!env.isOnTurn(peer) : true);
      const { begin, end } = state.span;
      const haps = [];
      for (const seg of ledger.segments()) {
        if (!seg.on) continue;
        const from = seg.from == null ? begin : begin.max(gridTime(seg.from));
        const to = seg.to == null ? end : end.min(gridTime(seg.to));
        if (!from.lt(to)) continue;
        const span = new ns.TimeSpan(from.sub(seg.offset), to.sub(seg.offset));
        const inner = pat.query(state.setSpan(span).setControls({ _mmTurnTime: true }));
        for (const hap of inner) {
          haps.push(seg.offset ? hap.withSpan((s) => s.withTime((t) => t.add(seg.offset))) : hap);
        }
      }
      return haps;
    });
    result._steps = pat._steps;
    return result;
  };

  // multiArrange(peer, [cycles, member, …], …, options?)
  // A section's members are stacked, so `[4, s("bd*4"), osc(10), word("hi")]`
  // is four cycles of drums, visuals and words together.
  const multiArrange = (peer, ...args) => {
    const [sections, opts] = takeOptions(args);
    const ctx = { fn: 'multiArrange', peer, output: opts.output };
    if (!sections.length) return ns.silence;
    const arranged = ns.arrange(...sections.map((section, i) => {
      if (!Array.isArray(section) || section.length < 2) {
        throw new Error(`multiArrange: section ${i + 1} should be [cycles, pattern, …]`);
      }
      const [cycles, ...members] = section;
      const n = Number(cycles);
      if (!(n > 0)) throw new Error(`multiArrange: section ${i + 1} needs a positive number of cycles, not ${cycles}`);
      return [n, stackMembers(members, ctx)];
    }));
    return finalize(opts.resume === false ? arranged : resumeOnTurns(arranged, peer), peer);
  };

  // multiStack(peer, member, …, options?)
  const multiStack = (peer, ...args) => {
    const [members, opts] = takeOptions(args);
    if (!members.length) return ns.silence;
    return finalize(stackMembers(members, { fn: 'multiStack', peer, output: opts.output }), peer);
  };

  return { multiArrange, multiStack, ledgerFor };
}
