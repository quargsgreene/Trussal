// simple-ws.js
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('connected');
  ws.send(JSON.stringify({ type: 'welcome', message: 'hi' }));
  ws.on('message', (m) => {
    console.log('msg', m.toString());
    ws.send(JSON.stringify({ type: 'echo', data: m.toString() }));
  });
});

server.listen(8081, '0.0.0.0', () => console.log('listening on 8081'));
