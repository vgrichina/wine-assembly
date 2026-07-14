#!/usr/bin/env node

// Local static server + event collector for safari-private-probe.html.
// Open the printed URL in an actual Safari Private Window. Probe milestones,
// heartbeats, launch logs, and final runtime snapshots are streamed here.

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.PROBE_HOST || '127.0.0.1';
const PORT = Math.max(1, parseInt(process.env.PROBE_PORT || '8878', 10) || 8878);
const MAX_BODY = 1024 * 1024;
const MAX_EVENTS = 10000;

const events = [];
const streams = new Set();

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.dll': 'application/octet-stream',
  '.exe': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mid': 'audio/midi',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wat': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function broadcast(event) {
  const packet = `data: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) {
    try { stream.write(packet); } catch (_) { streams.delete(stream); }
  }
}

function acceptEvent(req, res) {
  let size = 0;
  const chunks = [];
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > MAX_BODY) return json(res, 413, { ok: false, error: 'event too large' });
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return json(res, 400, { ok: false, error: 'event must be an object' });
    }
    const event = {
      receivedAt: new Date().toISOString(),
      ...value,
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    console.log(`[safari-private-probe] ${JSON.stringify(event)}`);
    broadcast(event);
    json(res, 200, { ok: true });
  });
  req.on('error', () => {
    if (!res.headersSent) json(res, 400, { ok: false, error: 'request aborted' });
  });
}

function serveStatic(url, res) {
  const pathname = url.pathname === '/' ? '/safari-private-probe.html' : url.pathname;
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch (_) { return json(res, 400, { ok: false, error: 'bad path' }); }
  const file = path.resolve(ROOT, '.' + decoded);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) return json(res, 404, { ok: false, error: 'not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      // Private-mode probes must never reuse a prior WAT, JS, or binary response.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    const input = fs.createReadStream(file);
    input.on('error', () => res.destroy());
    input.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/__probe_event') {
    return acceptEvent(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/__probe_events') {
    const run = url.searchParams.get('run');
    return json(res, 200, run ? events.filter(event => event.run === run) : events);
  }
  if (req.method === 'GET' && url.pathname === '/__probe_stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });
    res.write(': safari private probe stream\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.method === 'HEAD') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    return serveStatic(url, res);
  }
  json(res, 405, { ok: false, error: 'method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`[safari-private-probe] collector listening on http://${HOST}:${PORT}/safari-private-probe.html`);
});

function shutdown() {
  for (const stream of streams) {
    try { stream.end(); } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
