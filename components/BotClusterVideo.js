// Bot cluster video treatment: shrink each cluster bot's filmstrip tile and
// visually attach it to its owner (owner-hued outline). Jitsi owns the
// filmstrip DOM, so this is a periodic best-effort restyle keyed off the
// peer-state roster — tiles Jitsi re-renders get re-styled on the next tick.

import { getAllPeers } from '../src/peer-state.js';

const STYLE_ID = 'trussal-bot-cluster-style';
let timer = null;

function ownerHue(ownerIndex) {
  let h = 0;
  const s = `owner-${ownerIndex}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .trussal-cluster-tile {
      transform: scale(0.62);
      transform-origin: top left;
      border-radius: 8px;
      outline: 2px solid hsl(var(--trussal-owner-hue, 140), 70%, 55%);
      outline-offset: -2px;
    }
    .trussal-cluster-tile::after {
      content: attr(data-cluster-index);
      position: absolute; top: 2px; right: 4px;
      font: 700 10px monospace;
      color: hsl(var(--trussal-owner-hue, 140), 70%, 65%);
      z-index: 5;
    }
  `;
  document.head.appendChild(style);
}

function findTile(jitsiId) {
  return document.getElementById(`participant_${jitsiId}`) ||
    document.querySelector(`[data-participant-id="${jitsiId}"]`) || null;
}

function restyle() {
  const peers = getAllPeers();
  for (const peer of peers) {
    if (!peer.isBot || !peer.jitsiId || typeof peer.roomIndex !== 'string') continue;
    const m = peer.roomIndex.match(/^(\d+)([a-z]+)$/);
    if (!m) continue;
    const tile = findTile(peer.jitsiId);
    if (!tile) continue;
    tile.classList.add('trussal-cluster-tile');
    tile.style.setProperty('--trussal-owner-hue', String(ownerHue(m[1])));
    tile.dataset.clusterIndex = peer.roomIndex;
    // Nudge the tile toward its owner: order it right after the owner's tile
    // in the filmstrip when both share a parent.
    const owner = peers.find(p => String(p.roomIndex) === m[1]);
    const ownerTile = owner && owner.jitsiId ? findTile(owner.jitsiId) : null;
    if (ownerTile && ownerTile.parentElement && ownerTile.parentElement === tile.parentElement &&
        ownerTile.nextSibling !== tile) {
      try { ownerTile.parentElement.insertBefore(tile, ownerTile.nextSibling); } catch (e) {}
    }
  }
}

export function startBotClusterVideo() {
  if (timer) return;
  injectStyles();
  timer = setInterval(restyle, 1500);
}

export function stopBotClusterVideo() {
  if (timer) { clearInterval(timer); timer = null; }
  document.querySelectorAll('.trussal-cluster-tile').forEach(t => t.classList.remove('trussal-cluster-tile'));
}
