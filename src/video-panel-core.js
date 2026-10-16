// video-panel-core.js — pure helpers for Trussal's in-call video panel.
//
// The Jitsi web app used to render the in-call video layout: a large video plus
// a filmstrip of participant tiles. Replacing the shell (public/index.html)
// removed it, so video-panel.js rebuilds that layout as Trussal's own. This
// module holds the decisions that need no DOM, so they can be unit-tested
// directly: the element ids downstream Trussal features already query, the
// stable participant ordering, which participant occupies the large video, and
// the JVB receiver-constraints payload that makes the bridge actually forward
// remote video.

// The tile id the rest of the bundle already looks up: Grid.js marks
// `#participant_<jitsiId>`, and remote-tracks.js / live-capture.js read
// `#participant_<jitsiId> video`. Keeping this exact shape is what lets those
// features work against the Trussal panel unchanged.
export function tileIdFor(jitsiId) {
  return jitsiId ? `participant_${jitsiId}` : '';
}

// The <video> id inside a tile. remote-tracks.js's findRemoteVideoElement()
// falls back to `remoteVideo_<jitsiId>` for layouts whose tile ids do not embed
// the participant id; this panel's ids do, but keeping the inner id too makes
// that fallback resolve as well.
export function remoteVideoIdFor(jitsiId) {
  return jitsiId ? `remoteVideo_${jitsiId}` : '';
}

// Stable panel order: the local participant first, then everyone else sorted by
// jitsi id. Deterministic so a reconcile never churns the DOM (and so a test can
// assert an exact order).
export function orderPanelParticipants(list) {
  const clean = (Array.isArray(list) ? list : []).filter((p) => p && p.id);
  const local = clean.filter((p) => p.isLocal);
  const remotes = clean.filter((p) => !p.isLocal);
  remotes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return [...local, ...remotes];
}

// Which participant the large video shows. An explicit pin (a click on a tile)
// wins; otherwise the Aggregator — the room's global feed (see docs-about.js);
// otherwise the first remote; otherwise the local participant, so a lone
// participant still sees their own output once they turn the camera on. Null
// when there is nobody at all.
export function chooseLargeVideoId(list, { pinnedId = null } = {}) {
  const ordered = (Array.isArray(list) ? list : []).filter((p) => p && p.id);
  if (!ordered.length) return null;
  if (pinnedId && ordered.some((p) => p.id === pinnedId)) return pinnedId;
  const aggregator = ordered.find((p) => p.isAggregator);
  if (aggregator) return aggregator.id;
  const remote = ordered.find((p) => !p.isLocal);
  if (remote) return remote.id;
  return ordered[0].id;
}

// The receiver constraints are asserted on every participant-video sync. The
// human UI modules (video-panel.js, in-call-toolbar.js) share this predicate:
// bots and the aggregator load the same bundle but run headless and composite
// their own video, so they must not grow a second copy of the layout.
export function humanUiWanted(w = (typeof globalThis !== 'undefined' ? globalThis : {})) {
  return !(w && (w.__trussalIsBot || w.__trussalIsAggregator));
}

// The JVB only forwards a remote participant's video to a receiver that has
// asked for it. The Jitsi web app asked implicitly, driven by which tiles were
// visible; nothing does now, so the panel asserts it explicitly. lastN: -1 asks
// for every participant (the filmstrip shows them all); maxHeight 360 matches
// the aggregator bot's own ask (bots/src/bot/page-scripts.js
// ensureReceiverConstraints), so the two never disagree about quality.
export function receiverConstraintsPayload() {
  return { defaultConstraints: { maxHeight: 360 }, lastN: -1 };
}
