#!/usr/bin/env node
// A local stand-in for berrry's per-user data API — the server half
// lib/save-sync.js talks to.
//
// In production there is nothing to run: a deployed page calls berrry's own
// `/api/data/:key` same-origin as the signed-in user. This exists so the sync
// path can be tested without an account and a network, and so the *same client
// code* that will hit berrry is the code the tests exercise. It implements the
// subset lib/save-sync.js uses, with the same status codes:
//
//   GET    /api/auth/user           -> {id, username, …}  | 401 with --no-auth
//   POST   /api/data/:key           <- raw body, stored with its Content-Type
//   PUT    /api/data/:key           <- same, update
//   GET    /api/data/:key           -> the bytes, original Content-Type | 404
//   DELETE /api/data/:key           -> {success:true} | 404
//   GET    /api/data/:key/metadata  -> {key, visibility, dataType, createdAt,
//                                       updatedAt} | 404
//
//   node tools/save-sync-server.js --dir=/tmp/saves --port=8090
//   node tools/save-sync-server.js --no-auth     # every /api/data call 401s
//
// It is a *stand-in*, not berrry: there is one implicit user, no sharing, no
// public-data routes, and no real session. Where it deliberately matches is the
// URL shape, the content-type round trip, and the 401/404 codes — those are
// what the client branches on. It binds to localhost by default because it has
// no authentication to protect what it holds.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getArg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PORT = parseInt(getArg('port', '8090'), 10);
const HOST = getArg('host', '127.0.0.1');
const ROOT = path.resolve(getArg('dir', path.join(os.tmpdir(), 'wine-assembly-saves')));
// Saves are KB..1MB by design; this is the same order as lib/save-bundle.js's
// own cap, so a bundle that fits in the client fits here.
const MAX_BYTES = parseInt(getArg('max-bytes', String(16 * 1024 * 1024)), 10);
const SIGNED_IN = !process.argv.includes('--no-auth');
const QUIET = process.argv.includes('--quiet');

// berrry keys are opaque strings; this allow-list is what makes a key safe to
// use as a filename. Validating before touching the path means traversal has no
// alphabet to work with, rather than being sanitized after the fact.
const KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;

const USER = { id: 1, email: 'local@example.invalid', username: 'local', display_name: 'Local' };

function log(...args) {
  if (!QUIET) console.log(...args);
}

function send(res, status, body, type) {
  const payload = body === undefined ? Buffer.alloc(0)
    : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  res.writeHead(status, {
    'content-type': type || 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj) + '\n');

function recordPaths(key) {
  return {
    data: path.join(ROOT, key + '.bin'),
    meta: path.join(ROOT, key + '.json'),
  };
}

// /api/data/:key and /api/data/:key/metadata
function parseDataPath(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'data') return null;
  const key = decodeURIComponent(parts[2] || '');
  if (!KEY_RE.test(key)) return null;
  if (parts.length === 3) return { key, metadata: false };
  if (parts.length === 4 && parts[3] === 'metadata') return { key, metadata: true };
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') return send(res, 200, 'ok\n', 'text/plain');

  if (urlPath === '/api/auth/user') {
    if (!SIGNED_IN) return sendJson(res, 401, { error: 'not authenticated' });
    return sendJson(res, 200, USER);
  }
  if (urlPath === '/api/auth/login') {
    // The real one is an OAuth bounce; here it is enough that the URL exists
    // and says what it would do, so a client redirecting to it is testable.
    return send(res, 200, 'sign-in page (stand-in)\n', 'text/plain');
  }
  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    return sendJson(res, 200, { success: true });
  }

  const target = parseDataPath(urlPath);
  if (!target) return sendJson(res, 404, { error: 'not found' });
  if (!SIGNED_IN) return sendJson(res, 401, { error: 'not authenticated' });
  const files = recordPaths(target.key);

  if (target.metadata) {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
    if (!fs.existsSync(files.meta)) return sendJson(res, 404, { error: 'no such key' });
    return sendJson(res, 200, JSON.parse(fs.readFileSync(files.meta, 'utf8')));
  }

  if (req.method === 'GET') {
    if (!fs.existsSync(files.data)) return sendJson(res, 404, { error: 'no such key' });
    const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
    const data = fs.readFileSync(files.data);
    log(`GET  ${target.key} ${data.length}B ${meta.dataType}`);
    return send(res, 200, data, meta.dataType);
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const body = await readBody(req, MAX_BYTES);
      if (!body.length) return sendJson(res, 400, { error: 'empty body' });
      const type = req.headers['content-type'] || 'application/octet-stream';
      const now = new Date().toISOString();
      const previous = fs.existsSync(files.meta)
        ? JSON.parse(fs.readFileSync(files.meta, 'utf8')) : null;
      fs.mkdirSync(ROOT, { recursive: true });
      // Write-then-rename: a client that dies mid-upload must not leave a
      // half-written record where the next GET will find it and trust it.
      const tmp = files.data + `.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, files.data);
      fs.writeFileSync(files.meta, JSON.stringify({
        key: target.key,
        visibility: 'private',
        dataType: type,
        createdAt: previous ? previous.createdAt : now,
        updatedAt: now,
      }, null, 2));
      log(`${req.method} ${target.key} ${body.length}B ${type}`);
      return sendJson(res, 200, { key: target.key, updatedAt: now, size: body.length });
    } catch (e) {
      if (e && e.status === 413) return sendJson(res, 413, { error: `over ${MAX_BYTES} bytes` });
      return sendJson(res, 500, { error: `write failed: ${e.message}` });
    }
  }

  if (req.method === 'DELETE') {
    if (!fs.existsSync(files.data)) return sendJson(res, 404, { error: 'no such key' });
    fs.rmSync(files.data, { force: true });
    fs.rmSync(files.meta, { force: true });
    log(`DELETE ${target.key}`);
    return sendJson(res, 200, { success: true });
  }

  res.writeHead(405, { allow: 'GET, POST, PUT, DELETE' });
  res.end();
});

if (require.main === module) {
  fs.mkdirSync(ROOT, { recursive: true });
  server.listen(PORT, HOST, () => {
    // Report the port the OS actually bound, not the one asked for: --port=0
    // is how a test gets a free port, and it needs to be told which one.
    const bound = server.address().port;
    console.log(`save-sync server on http://${HOST}:${bound}  store=${ROOT}  ` +
      `max=${MAX_BYTES}B  auth=${SIGNED_IN ? 'signed-in' : 'always 401'}`);
  });
}

module.exports = { server, parseDataPath, ROOT };
