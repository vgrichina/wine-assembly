#!/usr/bin/env node
// Local development server: serves the repo and, on the same origin, the
// subset of the Berrry backend that the virtual LAN needs for signaling.
//
// Two browsers cannot find each other without something in the middle to pass
// the first message. In production that is Berrry's own key/value API, which
// requires a logged-in account. Requiring a login to run the thing locally
// would make "open two tabs and play" a multi-step setup, so this server
// implements the same routes with no authentication at all and keeps
// everything in memory: restart it and the room list is empty again.
//
// It is deliberately NOT a general-purpose static server. It serves one
// directory tree, refuses anything outside it, and binds to localhost by
// default, because it has no authentication to protect what it exposes.
//
//   node tools/dev-server.js                 # http://127.0.0.1:8080
//   node tools/dev-server.js --port=9000
//   node tools/dev-server.js --host=0.0.0.0  # other devices on your LAN
//
// The API surface mirrors what lives on Berrry, so the browser code that
// talks to it does not change between local development and deployment:
//
//   GET    /api/auth/user            who am I (dev: always someone)
//   GET    /api/data/:key            read one of my own records
//   PUT    /api/data/:key            write it; ?visibility=public to publish
//   DELETE /api/data/:key            remove it
//   GET    /api/public-data/users/:key   who has published under this key
//   GET    /api/public-data/:userId/:key read someone else's published record
//
// A published record is world-readable, exactly as on the real backend. That
// is a property to design around rather than fight: room invitations carry a
// secret in the URL fragment and the payload is encrypted under it, so what
// lands here is opaque. Nothing secret should ever be PUT in the clear.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wat': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.fon': 'application/octet-stream',
  '.exe': 'application/octet-stream',
  '.dll': 'application/octet-stream',
  '.hlp': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// users: userId -> { id, name, data: Map(key -> { value, visibility, updatedAt }) }
class Store {
  constructor() {
    this.users = new Map();
    this.writes = 0;
  }

  user(id) {
    let u = this.users.get(id);
    if (!u) {
      u = { id, name: `dev-${id.slice(0, 6)}`, data: new Map() };
      this.users.set(id, u);
    }
    return u;
  }

  put(userId, key, value, visibility) {
    const rec = { value, visibility, updatedAt: new Date().toISOString() };
    this.user(userId).data.set(key, rec);
    this.writes++;
    return rec;
  }

  get(userId, key) {
    const u = this.users.get(userId);
    return u ? (u.data.get(key) || null) : null;
  }

  del(userId, key) {
    const u = this.users.get(userId);
    return u ? u.data.delete(key) : false;
  }

  // Everyone who has published a record under this key. This is the discovery
  // primitive: a room's members find each other by publishing under a key
  // derived from the room, then reading each other's records back.
  publishers(key) {
    const out = [];
    for (const u of this.users.values()) {
      const rec = u.data.get(key);
      if (rec && rec.visibility === 'public') {
        out.push({ userId: u.id, name: u.name, updatedAt: rec.updatedAt });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // Signaling records change constantly and are polled; a cached 200 here
    // would show a peer an answer that has already been superseded.
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(text);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// A browser with no login still needs a stable identity, or two tabs could not
// tell each other apart. The cookie is that identity and nothing more: it
// grants no rights, because in this server nothing is protected.
const USER_COOKIE = 'wa_dev_user';

function identify(req, res) {
  const existing = parseCookies(req.headers.cookie)[USER_COOKIE];
  if (existing && /^[a-f0-9]{16,64}$/.test(existing)) return existing;
  const id = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie',
    `${USER_COOKIE}=${id}; Path=/; SameSite=Lax; Max-Age=86400`);
  return id;
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// Resolve a URL path inside ROOT, or null if it escapes. Checking the resolved
// path rather than the raw one is what makes ".." and encoded variants safe.
function resolveStatic(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch (_) {
    return null;
  }
  if (rel.indexOf('\0') !== -1) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(ROOT, '.' + path.posix.normalize(rel));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  const full = resolveStatic(urlPath);
  if (!full) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden\n');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    // The build output and the WAT sources change on every rebuild, and a
    // cached copy of either produces a confusing "my fix did nothing".
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res)
      .on('error', () => res.destroy());
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const MAX_RECORD_BYTES = 256 * 1024;

async function handleApi(req, res, url, store) {
  const seg = url.pathname.split('/').filter(Boolean);   // ['api', ...]
  const userId = identify(req, res);

  // GET /api/auth/user
  if (seg[1] === 'auth' && seg[2] === 'user' && seg.length === 3) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const u = store.user(userId);
    return sendJson(res, 200, { id: u.id, name: u.name, dev: true });
  }

  // /api/public-data/users/:key  and  /api/public-data/:userId/:key
  if (seg[1] === 'public-data') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (seg[2] === 'users' && seg.length === 4) {
      return sendJson(res, 200, { key: seg[3], users: store.publishers(seg[3]) });
    }
    if (seg.length === 4) {
      const rec = store.get(seg[2], seg[3]);
      if (!rec || rec.visibility !== 'public') {
        return sendJson(res, 404, { error: 'not found' });
      }
      return sendJson(res, 200, {
        key: seg[3], userId: seg[2], value: rec.value, updatedAt: rec.updatedAt,
      });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // /api/data/:key
  if (seg[1] === 'data' && seg.length === 3) {
    const key = seg[2];
    if (req.method === 'GET') {
      const rec = store.get(userId, key);
      if (!rec) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, {
        key, value: rec.value, visibility: rec.visibility, updatedAt: rec.updatedAt,
      });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      let raw;
      try {
        raw = await readBody(req, MAX_RECORD_BYTES);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
      let value;
      try {
        value = raw ? JSON.parse(raw) : null;
      } catch (_) {
        return sendJson(res, 400, { error: 'body must be JSON' });
      }
      const visibility = url.searchParams.get('visibility') === 'public'
        ? 'public' : 'private';
      const rec = store.put(userId, key, value, visibility);
      return sendJson(res, 200, { key, visibility, updatedAt: rec.updatedAt });
    }
    if (req.method === 'DELETE') {
      // Deleting something that was already gone is the state the caller
      // wanted, so report it the same way rather than as a failure.
      store.del(userId, key);
      return sendJson(res, 200, { key, deleted: true });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  return sendJson(res, 404, { error: 'no such route' });
}

// ---------------------------------------------------------------------------

function createServer(opts) {
  const store = (opts && opts.store) || new Store();
  const quiet = !!(opts && opts.quiet);
  // Static requests are hundreds of lines of noise next to a handful of
  // signaling calls, so they are off unless asked for.
  const verbose = !!(opts && opts.verbose);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      // Log who is asking, not just what. Two browsers failing to see each
      // other is nearly always one of two things — they are the same user, or
      // one of them never got here at all — and both are invisible unless the
      // identity is on the line.
      if (!quiet) {
        const who = parseCookies(req.headers.cookie)[USER_COOKIE];
        console.log(`${new Date().toISOString().slice(11, 23)} `
          + `${(who || 'anon').slice(0, 8)} ${req.method} ${url.pathname}`
          + `${url.search || ''}`);
      }
      handleApi(req, res, url, store).catch(err => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err && err.message || err) });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (!quiet && verbose) console.log(`${req.method} ${url.pathname}`);
    serveStatic(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
  });
  server.store = store;
  return server;
}

function main() {
  const arg = (name, dflt) => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const port = parseInt(arg('port', '8080'), 10);
  const host = arg('host', '127.0.0.1');
  const server = createServer({
    quiet: process.argv.includes('--quiet'),
    verbose: process.argv.includes('--verbose'),
  });
  server.listen(port, host, () => {
    console.log(`wine-assembly dev server: http://${host}:${port}`);
    console.log(`  serving ${ROOT}`);
    console.log('  signaling API at /api/data, /api/public-data (no login, in memory)');
    if (host === '0.0.0.0') {
      console.log('  NOTE: bound to all interfaces and unauthenticated — trusted networks only');
    }
  });
}

if (require.main === module) main();

module.exports = { createServer, Store, resolveStatic, ROOT };
