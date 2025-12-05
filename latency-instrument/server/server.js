// REALLY TINY TEST SERVER
const { WebSocketServer } = require('ws');

console.log('[latency] BOOT: tiny WS server starting');

const wss = new WebSocketServer({ port: 8081 });

wss.on('connection', (ws, req) => {
  console.log('[latency] connection from', req.url);

  // Immediately send something
  try {
    const welcome = { type: 'welcome', message: 'hi from tiny WS server' };
    ws.send(JSON.stringify(welcome));
    console.log('[latency] sent welcome:', welcome);
  } catch (e) {
    console.error('[latency] send welcome error:', e);
  }

  ws.on('message', (data) => {
    const text = data.toString();
    console.log('[latency] message:', text);

    // Echo it back so wscat / browser see something
    try {
      const echo = { type: 'echo', data: text };
      ws.send(JSON.stringify(echo));
      console.log('[latency] sent echo:', echo);
    } catch (e) {
      console.error('[latency] send echo error:', e);
    }
  });

  ws.on('close', () => {
    console.log('[latency] socket closed for', req.url);
  });

  ws.on('error', (err) => {
    console.error('[latency] socket error:', err.message);
  });
});

console.log('[latency] listening directly on ws://0.0.0.0:8081');
