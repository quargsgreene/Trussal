// server.js
const { WebSocketServer } = require('ws');

console.log('[latency] BOOT: latency WS server starting');

const wss = new WebSocketServer({ port: 8081 });

wss.on('connection', (ws, req) => {
  console.log('[latency] connection from', req.url);

  // Welcome message
  try {
    const welcome = { type: 'welcome', message: 'connected to latency server' };
    ws.send(JSON.stringify(welcome));
    console.log('[latency] sent welcome:', welcome);
  } catch (e) {
    console.error('[latency] send welcome error:', e);
  }

  ws.on('message', (data) => {
    const text = data.toString();
    console.log('[latency] raw message:', text);

    let msg;
    try {
      msg = JSON.parse(text);
      const ping = {type:'ping', data:text};
      ws.send(JSON.stringify(ping));
      console.log('[latency] parsed message:', msg, 'sentAt typeof:', typeof msg.sentAt);
    } catch (e) {
      console.error('[latency] JSON parse error:', e);
      return;
    }

    if (msg.type === 'ping' && typeof msg.sentAt === 'number') {
      const now = Date.now();
      const rtt = now - msg.sentAt;
      const pongMsg = {
        type: 'pong',
        rtt,
        clientSentAt: msg.sentAt
      };

      console.log('[latency] sending pong:', pongMsg);

      try {
        ws.send(JSON.stringify(pongMsg));
        console.log('[latency] pong sent');
      } catch (e) {
        console.error('[latency] error sending pong:', e);
      }
    } else {
      console.log('[latency] non-ping message, ignoring');
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
