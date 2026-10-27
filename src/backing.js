// backing.js — the author's half of backing voices (see backing-core.js for
// the whole design): ship each file this browser's program declares as a
// backing to the aggregator, once per connection.
//
// Nothing here plays anything. The aggregator mixes the file into its master
// after the turn gate, which is what lets it sound on other participants'
// turns; playing it here too would only bake a second copy into this
// browser's own published track.

import { sendBackingFile, subscribePeerState } from './peer-state.js';
import { getUploadedFile, blobToBase64 } from './file-cycles.js';
import { mimeOfFilename } from './file-cycles-core.js';

const sent = new Set();      // filenames shipped on this connection
const inFlight = new Set();  // filenames being read/encoded right now
let declared = [];           // the latest declarations, re-sent on reconnect

async function ship(name, kind) {
  if (sent.has(name) || inFlight.has(name)) return;
  inFlight.add(name);
  try {
    const stored = await getUploadedFile(name);
    if (!stored) {
      console.warn(`[backing] "${name}" — no file by that name in your uploads (Studio → Files)`);
      return;
    }
    const data = await blobToBase64(stored.blob);
    sendBackingFile({ kind, name, mime: stored.mime || mimeOfFilename(name), data });
    sent.add(name);
  } catch (e) {
    console.error(`[backing] could not send "${name}"`, e);
  } finally {
    inFlight.delete(name);
  }
}

// Called by strudel.js with the local peer's declarations each time its
// program is rebuilt. Cheap when nothing is new: every file already shipped
// on this connection is skipped.
export function syncLocalBackings(backings) {
  declared = Array.isArray(backings) ? backings : [];
  for (const { name, kind } of declared) ship(name, kind);
}

// A fresh connection may be to a sidecar that restarted without the room's
// stored files, so ship the current declarations again.
subscribePeerState((event) => {
  if (event !== 'roster') return;
  sent.clear();
  for (const { name, kind } of declared) ship(name, kind);
});
