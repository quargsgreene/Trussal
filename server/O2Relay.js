// WebSocket relay for O2lite clients.
//
// Thin re-export: the implementation lives in latency-instrument/o2-relay.js
// because the sidecar's Docker build context is ../latency-instrument and the
// relay runs inside that container (second WS server on :8082, proxied at /o2).

module.exports = require('../latency-instrument/o2-relay.js');
