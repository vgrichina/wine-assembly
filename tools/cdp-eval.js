#!/usr/bin/env node
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const expr = process.argv.slice(2).join(' ');
if (!expr) {
  console.error('usage: node tools/cdp-eval.js <js-expression>');
  process.exit(2);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect(Number(u.port), u.hostname);
  let buf = Buffer.alloc(0);
  let ready = false;
  let nextId = 1;
  const pending = new Map();

  function parseFrames() {
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2)) throw new Error('large websocket frame');
        len = buf.readUInt32BE(6); off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if ((b0 & 0x0f) !== 1) continue;
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    }
  }

  socket.on('data', data => {
    buf = Buffer.concat([buf, data]);
    if (!ready) {
      const s = buf.toString('latin1');
      const idx = s.indexOf('\r\n\r\n');
      if (idx < 0) return;
      ready = true;
      buf = buf.subarray(idx + 4);
    }
    parseFrames();
  });

  const opened = new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.write([
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
      const started = Date.now();
      const tick = () => ready ? resolve() :
        (Date.now() - started > 5000 ? reject(new Error('websocket timeout')) : setTimeout(tick, 25));
      tick();
    });
    socket.once('error', reject);
  });

  function send(method, params = {}) {
    const id = nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
    header[0] = 0x81;
    if (payload.length < 126) {
      header[1] = 0x80 | payload.length;
      crypto.randomBytes(4).copy(header, 2);
      for (let i = 0; i < payload.length; i++) payload[i] ^= header[2 + (i & 3)];
    } else {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      crypto.randomBytes(4).copy(header, 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= header[4 + (i & 3)];
    }
    socket.write(Buffer.concat([header, payload]));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  return { opened, send, close: () => socket.destroy() };
}

(async () => {
  const pages = await getJson('http://127.0.0.1:9223/json/list');
  const page = pages.find(p => p.type === 'page');
  if (!page) throw new Error('no page');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.opened;
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  cdp.close();
  if (r.exceptionDetails) {
    console.error(JSON.stringify(r.exceptionDetails, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(r.result.value, null, 2));
})().catch(e => {
  console.error(e.stack || e);
  process.exit(1);
});
