// grid — approximate physical distances between room participants from
// network metrics and mark each video panel with a grayscale circle
// (top-left; longest distance = black, self = white). With landmarks=true a
// vector in the panel's bottom-right shows the direction of greatest
// average landmark displacement (hidden for bots and peers without
// MediaPipe). Returns the distance matrix.
//
// Distance model: we only measure each peer's RTT to the bridge, not
// pairwise paths, so peer↔peer distance is approximated by the relayed
// path: (rtt_i + rtt_j)/2 one-way ms × ~100 km/ms (light in fiber ≈
// 200 000 km/s). Self-distance is 0.

export const KM_PER_ONE_WAY_MS = 100;

function peerRttMs(peer) {
  if (typeof peer.rtcRtt === 'number' && isFinite(peer.rtcRtt)) return peer.rtcRtt;
  if (typeof peer.rtt === 'number' && isFinite(peer.rtt)) return peer.rtt;
  return 0;
}

// peers: [{ jitsiId, rtt, rtcRtt }] → { matrix, order } where matrix[i][j]
// is the approximate distance in km, symmetric with a zero diagonal.
export function distanceMatrix(peers) {
  const list = Array.isArray(peers) ? peers : [];
  const order = list.map(p => p.jitsiId);
  const oneWay = list.map(p => peerRttMs(p) / 2);
  const matrix = list.map((_, i) => list.map((_, j) => {
    if (i === j) return 0;
    return (oneWay[i] + oneWay[j]) * KM_PER_ONE_WAY_MS;
  }));
  return { matrix, order };
}

// Grayscale for a distance: white (1) at zero, black (0) at the room's
// maximum. Everything from *this* browser's perspective: the viewer's own
// panel uses distance 0 → white.
export function shadeForDistance(distKm, maxKm) {
  if (!(maxKm > 0)) return 1;
  return Math.min(1, Math.max(0, 1 - distKm / maxKm));
}

export function gridView(peers, localJitsiId) {
  const { matrix, order } = distanceMatrix(peers);
  const li = order.indexOf(localJitsiId);
  const row = li === -1 ? order.map(() => 0) : matrix[li];
  const maxKm = Math.max(...row, 0);
  return {
    matrix,
    order,
    shades: order.map((jid, j) => ({
      jitsiId: jid,
      distanceKm: row[j],
      shade: jid === localJitsiId ? 1 : shadeForDistance(row[j], maxKm)
    }))
  };
}

// --- DOM overlay (browser) ------------------------------------------------------

const OVERLAY_CLASS = 'jp-grid-mark';

function findVideoPanel(jitsiId) {
  // Jitsi filmstrip tiles carry participant ids in a few historical shapes.
  return document.getElementById(`participant_${jitsiId}`) ||
    document.querySelector(`[id="participant_${jitsiId}"], [data-participant-id="${jitsiId}"]`) ||
    null;
}

export function renderGridOverlays(peers, localJitsiId, { landmarks = false, displacement = null } = {}) {
  const view = gridView(peers, localJitsiId);
  for (const entry of view.shades) {
    const panel = findVideoPanel(entry.jitsiId);
    if (!panel) continue;
    let mark = panel.querySelector(`.${OVERLAY_CLASS}`);
    if (!mark) {
      mark = document.createElement('div');
      mark.className = OVERLAY_CLASS;
      mark.style.cssText = 'position:absolute;top:4px;left:4px;width:14px;height:14px;border-radius:50%;z-index:20;pointer-events:none;border:1px solid rgba(0,0,0,0.4);';
      if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
      panel.appendChild(mark);
    }
    const v = Math.round(entry.shade * 255);
    mark.style.background = `rgb(${v},${v},${v})`;
    mark.title = `≈${entry.distanceKm.toFixed(0)} km`;

    // Landmark displacement vector, bottom-right. Hidden for bots and peers
    // without MediaPipe data (displacement map has no entry).
    const peer = peers.find(p => p.jitsiId === entry.jitsiId);
    const vec = displacement && displacement[entry.jitsiId];
    let arrow = panel.querySelector('.jp-grid-vec');
    if (landmarks && vec && peer && !peer.isBot) {
      if (!arrow) {
        arrow = document.createElement('div');
        arrow.className = 'jp-grid-vec';
        arrow.style.cssText = 'position:absolute;bottom:4px;right:4px;width:18px;height:18px;z-index:20;pointer-events:none;font-size:14px;line-height:18px;text-align:center;';
        panel.appendChild(arrow);
      }
      const angle = Math.atan2(vec.dy || 0, vec.dx || 0);
      arrow.textContent = '→';
      arrow.style.color = mark.style.background;
      arrow.style.transform = `rotate(${angle}rad)`;
    } else if (arrow) {
      arrow.remove();
    }
  }
  return view.matrix;
}

export function clearGridOverlays() {
  document.querySelectorAll(`.${OVERLAY_CLASS}, .jp-grid-vec`).forEach(el => el.remove());
}
