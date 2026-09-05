// Meeting-poll patterns — Strudel patterns that post an interactive poll into
// Jitsi's chat, rendered identically for every viewer:
//
//   $: poll('{"question":"Is water wet?","options":["yes","no","maybe"]}')
//        .close(100000).vote('{"yes":3}').fast(4)
//
// Every browser evaluates every peer's program (see strudel.js), so the poll
// itself needs no network trip to appear for everyone — the SAME mechanism
// that lets Text Cycles paint identical words everywhere. Only a viewer's
// own VOTE needs one: peer-state.js's sendPollVote broadcasts it, and every
// other browser applies the same delta to its own tally (subscribePeerState
// below), so all viewers converge on the same count without a server-side
// tally being kept anywhere — see the doc comment on the incoming
// subscription for the one limitation that trades away (a late joiner starts
// from the poll's own seeded votes, not the room's current live count).
//
// A poll's identity across repeated triggers is its question text — see
// polls-core.js's header for why, and why poll() mints its whole JSON
// argument as ONE opaque atom rather than word-by-word like word()/image().
//
// SILENT BY CONSTRUCTION, same mechanism as every other capability here — the
// renderer carries a dominant onTrigger.

import { getPeerByJitsiId, getLocalPeer, isPeerJPatternTurn, sendPollVote, subscribePeerState } from './peer-state.js';
import {
  DEFAULT_POLL_TEXT_COLOR, parsePollLiteral, canVote, applyVoteDelta, switchVote,
} from './polls-core.js';
import { ensureChatEntry } from './chat-entry.js';

const CONTAINER_ID = 'trussal-polls';
const STYLE_ID = 'trussal-polls-style';

let atoms = {};   // token -> { text, peer }
let active = false;
let container = null;
let styleEl = null;

// question -> { spec, tally, voterChoice: Map<voterToken, option>, createdAt,
//               closesAt, closeTimer, peerId, bubbleEl }
const polls = new Map();

export function setPollAtoms(table) { atoms = table || {}; }

function resolve(value) {
  if (value == null) return null;
  const atom = atoms[String(value)];
  return atom ? atom.text : String(value);
}
function peerOf(value) {
  const atom = atoms[String(value)];
  return atom ? atom.peer : null;
}

function ensureStyle() {
  if (styleEl && document.contains(styleEl)) return styleEl;
  styleEl = document.getElementById(STYLE_ID) || document.createElement('style');
  styleEl.id = STYLE_ID;
  if (!styleEl.textContent) {
    styleEl.textContent = `
#${CONTAINER_ID} .pl-bubble { margin: 4px 0; padding: 6px 16px; color: ${DEFAULT_POLL_TEXT_COLOR}; background: #eeeeee; border-radius: 6px; }
#${CONTAINER_ID} .pl-name { font-size: 12px; opacity: .6; }
#${CONTAINER_ID} .pl-question { font-weight: 600; margin: 2px 0 4px; }
#${CONTAINER_ID} .pl-option { display: flex; justify-content: space-between; gap: 8px; padding: 3px 6px; margin: 2px 0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; background: #fff; }
#${CONTAINER_ID} .pl-option.pl-mine { border-color: #111111; font-weight: 600; }
#${CONTAINER_ID} .pl-option.pl-closed { cursor: default; opacity: .8; }
#${CONTAINER_ID} .pl-status { font-size: 11px; opacity: .7; margin-top: 2px; }
`;
  }
  if (!document.contains(styleEl)) document.head.appendChild(styleEl);
  return styleEl;
}

function ensureContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
  }
  ensureStyle();
  return container;
}

function localToken() {
  const index = getLocalPeer()?.roomIndex;
  return index == null || index === '' ? null : String(index);
}

function isClosed(entry) {
  return entry.closesAt != null && Date.now() >= entry.closesAt;
}

function scoreboard(entry) {
  const total = Object.values(entry.tally).reduce((a, b) => a + b, 0);
  return total;
}

function renderPoll(question) {
  const entry = polls.get(question);
  if (!entry) return;
  ensureChatEntry(ensureContainer(), localToken(), () => active);

  if (!entry.bubbleEl || !entry.bubbleEl.isConnected) {
    entry.bubbleEl = document.createElement('div');
    entry.bubbleEl.className = 'pl-bubble';
    container.appendChild(entry.bubbleEl);
  }
  const bubble = entry.bubbleEl;
  bubble.innerHTML = '';

  const peer = entry.peerId ? getPeerByJitsiId(entry.peerId) : null;
  const name = document.createElement('div');
  name.className = 'pl-name';
  name.textContent = peer?.displayName || 'poll';
  bubble.appendChild(name);

  const q = document.createElement('div');
  q.className = 'pl-question';
  q.textContent = entry.spec.question;
  bubble.appendChild(q);

  const closed = isClosed(entry);
  const myToken = localToken();
  const myChoice = myToken ? entry.voterChoice.get(myToken) : null;
  const eligible = myToken != null && canVote(entry.spec, myToken);
  const total = scoreboard(entry);

  for (const option of entry.spec.options) {
    const row = document.createElement('div');
    row.className = `pl-option${option === myChoice ? ' pl-mine' : ''}${closed ? ' pl-closed' : ''}`;
    const label = document.createElement('span');
    label.textContent = option;
    const count = document.createElement('span');
    const votes = entry.tally[option] || 0;
    const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
    count.textContent = `${votes} (${pct}%)`;
    row.appendChild(label);
    row.appendChild(count);
    if (!closed && eligible) {
      row.addEventListener('click', () => castVote(question, option));
    }
    bubble.appendChild(row);
  }

  const status = document.createElement('div');
  status.className = 'pl-status';
  status.textContent = closed
    ? 'Poll closed'
    : !eligible
      ? "You're not eligible to vote in this poll"
      : myChoice
        ? `You voted "${myChoice}" — click another option to change your vote`
        : 'Click an option to vote';
  bubble.appendChild(status);

  const log = container.parentNode;
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 80) {
    log.scrollTop = log.scrollHeight;
  }
}

function castVote(question, option) {
  const entry = polls.get(question);
  if (!entry || isClosed(entry)) return;
  const voterToken = localToken();
  if (voterToken == null || !canVote(entry.spec, voterToken)) return;
  const previous = entry.voterChoice.get(voterToken) || null;
  if (previous === option) return;
  entry.tally = switchVote(entry.tally, previous, option);
  entry.voterChoice.set(voterToken, option);
  sendPollVote({ pollId: question, option, previousOption: previous, voterToken });
  renderPoll(question);
}

// A remote viewer's own vote, applied to OUR copy of the same poll's tally.
// If we have never seen this poll ourselves yet (it fired in the sender's
// browser before it fired in ours, or we joined after it started), the vote
// is dropped rather than queued — the poll shows up with whatever it was
// seeded with once our own trigger does fire, not a full replay of every
// vote cast before we arrived. No server-side tally exists to catch up from;
// see this module's header for that accepted tradeoff.
subscribePeerState((event, payload) => {
  if (event !== 'poll-vote') return;
  const entry = polls.get(payload.pollId);
  if (!entry) return;
  entry.tally = switchVote(entry.tally, payload.previousOption, payload.option);
  entry.voterChoice.set(payload.voterToken, payload.option);
  renderPoll(payload.pollId);
});

function handleTrigger(hap, currentTime, cps, targetTime) {
  if (!active) return;
  const value = hap?.value;
  if (!value || value.poll == null) return;
  const pollJson = resolve(value.poll);
  const peerId = peerOf(value.poll);
  const voteJson = value.vote != null ? resolve(value.vote) : null;
  const closeMs = value.close != null ? Number(value.close) : null;

  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    if (!isPeerJPatternTurn(peerId)) return;
    let spec;
    try {
      spec = parsePollLiteral(pollJson);
    } catch (e) {
      console.error('[polls]', e.message);
      return;
    }

    let entry = polls.get(spec.question);
    if (!entry) {
      entry = {
        spec, tally: spec.tally, voterChoice: new Map(),
        createdAt: Date.now(), closesAt: null, closeTimer: null, peerId, bubbleEl: null,
      };
      polls.set(spec.question, entry);
    }

    if (Number.isFinite(closeMs) && closeMs > 0) {
      entry.closesAt = entry.createdAt + closeMs;
      clearTimeout(entry.closeTimer);
      const remaining = entry.closesAt - Date.now();
      if (remaining > 0) entry.closeTimer = setTimeout(() => renderPoll(spec.question), remaining);
    }

    if (voteJson) {
      try {
        entry.tally = applyVoteDelta(entry.tally, JSON.parse(voteJson));
      } catch (e) {
        console.warn('[polls] .vote() argument is not valid JSON', e);
      }
    }

    renderPoll(spec.question);
  }, delayMs);
}

// Called once from ensureStrudel after initStrudel. Registers poll()/close()/
// vote() plus initPolls(), and returns the names to merge into evalScope.
export function installPolls(mod) {
  const { registerControl, register } = mod;
  const scope = {
    ...registerControl('poll'),
    ...registerControl('close'),
    ...registerControl('vote'),
  };
  register('_pollRender', (pat) => pat.onTrigger(handleTrigger, true));

  scope.initPolls = async () => {
    const wasActive = active;
    active = true;
    if (!wasActive) ensureChatEntry(ensureContainer(), localToken(), () => active);
    return true;
  };
  return scope;
}

// Polls already posted stay in the chat as history, exactly as Text Cycles'
// bubbles do — only new ones stop, and no close timer keeps firing for a set
// that has already ended.
export function stopPolls() {
  active = false;
  for (const entry of polls.values()) clearTimeout(entry.closeTimer);
}
