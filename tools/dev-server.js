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
const ISOLATE = process.argv.includes('--isolate');

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

// Appended to the emulator page when this server serves it (localhost binds
// only): the page connects itself to the agent hub, so "drive my session" is
// copying the link from the browser — no console paste. A bind beyond
// localhost must NOT inject, because the page would need the agent token and
// serving the token to every page viewer is serving control of every session.
const AGENT_INJECT = '\n<script type="module">\n'
  + '// injected by tools/dev-server.js — agent hub auto-connect\n'
  + '// (docs/design-agent-control.md; --no-agent-inject turns this off)\n'
  + "import('/lib/agent-remote.js').then(m => m.connect()).catch(() => {});\n"
  + '</script>\n';

function serveStatic(req, res, urlPath, agentInject) {
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
    // --isolate serves the two headers that let a shared WebAssembly.Memory
    // reach a Worker. Off by default: it is a change in how the page is
    // isolated, and threads-probe.html needs to be able to see BOTH states —
    // the header path here, and the service-worker path that production would
    // have to use (see docs/design-real-threads.md §3.4-3.5).
    const isolationHeaders = ISOLATE ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    } : null;
    // The build output and the WAT sources change on every rebuild, and a
    // cached copy of either produces a confusing "my fix did nothing".
    // no-store, not no-cache: no-cache still allows a stored copy and asks the
    // browser to revalidate, and this server sends no ETag or Last-Modified to
    // revalidate against. Nothing served here is worth caching.
    // The emulator page gets the auto-connect script appended (a trailing
    // module script is parsed and run like any other), so its body is built
    // in memory first — the Content-Length must describe what is actually
    // sent, not the on-disk size. Everything else streams untouched.
    const inject = agentInject && full === path.join(ROOT, 'index.html');
    const sendHeaders = (length) => {
      res.writeHead(200, Object.assign({
        'Content-Type': type,
        'Content-Length': length,
        'Cache-Control': 'no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        // A cross-origin page (the deployed build, or localhost vs 127.0.0.1 —
        // browsers treat those as different origins) can only import() the
        // agent-remote module if the module response says so; without this the
        // pasted connect line fails with an opaque CORS error.
        'Access-Control-Allow-Origin': '*',
      }, isolationHeaders || {}));
    };
    if (inject) {
      fs.readFile(full, (err2, data) => {
        if (err2) { res.writeHead(500); res.end(); return; }
        const body = Buffer.concat([data, Buffer.from(AGENT_INJECT)]);
        sendHeaders(body.length);
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(body);
      });
      return;
    }
    sendHeaders(st.size);
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
// Perf stream sink  (POST /api/perf, from lib/perf-hud.js)
// ---------------------------------------------------------------------------
//
// Someone playing in their own browser is the only source of the jank they
// actually experience — a scripted run reproduces a different session on a
// different load. So the HUD posts its samples here once a second, and this
// prints one line per batch while it happens.
//
// The line leads with the GUEST frame rate, because a page compositing at a
// steady 60 while the emulated machine presents 9 frames a second is exactly
// what "super laggy but shows 60 fps" means, and only one of those two
// numbers is the complaint.

const MAX_PERF_BYTES = 4 * 1024 * 1024;
const SPARK = '▁▂▃▄▅▆▇█';

function sparkline(values, cap) {
  if (!values.length) return '';
  const top = Math.max(cap || 0, ...values);
  return values.map(v => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.floor((v / top) * (SPARK.length - 1))))]).join('');
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
}

async function handlePerf(req, res, opts) {
  // The page under test is often served from a different port (the headless
  // profiler runs its own server), so the sink accepts cross-origin posts.
  // It only ever appends timing numbers to a local file, and the server is
  // bound to localhost unless someone asks otherwise.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let raw;
  try {
    raw = await readBody(req, MAX_PERF_BYTES);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }
  let batch;
  try { batch = JSON.parse(raw); } catch (_) { return sendJson(res, 400, { error: 'body must be JSON' }); }
  sendJson(res, 200, { ok: true });

  if (opts.perfLog) {
    // NDJSON so a session can be tailed live and re-cut later without
    // having to have decided the aggregation up front.
    try { fs.appendFileSync(opts.perfLog, JSON.stringify(batch) + '\n'); } catch (_) {}
  }
  if (opts.quiet) return;

  const steps = Array.isArray(batch.steps) ? batch.steps : [];
  if (batch.idle) {
    // Say why it is quiet. A hidden tab is not idle in the same sense: the
    // browser clamps its timers, so the emulator crawls whether or not the
    // app is running, and any measurement taken there is meaningless.
    console.log(`${new Date().toISOString().slice(11, 19)} ${String(batch.session || '?').slice(0, 6)} `
      + (batch.hidden ? 'tab hidden (timers clamped — nothing measurable)' : 'idle — no app launched'));
    return;
  }
  const totals = steps.map(s => s[0]).sort((a, b) => a - b);
  const snap = batch.snapshot || {};
  const throttled = steps.filter(s => s[5]).length;
  const guestFps = Number(batch.guestFrames || 0);
  const share = k => {
    const sum = steps.reduce((a, s) => a + s[k], 0);
    const all = steps.reduce((a, s) => a + s[0], 0) || 1;
    return Math.round((sum / all) * 100);
  };
  const t = new Date().toISOString().slice(11, 19);
  const warn = guestFps > 0 && guestFps < 20 ? ' LOW PRESENT RATE' : '';
  // Only while the pointer is actually moving. A mouse-driven game can feel
  // laggy with a spotless step histogram: what the hand notices is how often
  // the guest samples the pointer and how stale each sample is by then.
  const inp = snap.input && snap.input.movesPerSec > 0
    ? `  mouse ${snap.input.movesPerSec.toFixed(0)}/s in ${snap.input.takenPerSec.toFixed(0)}/s taken`
      + ` age p50 ${snap.input.ageMs.p50.toFixed(1)} p99 ${snap.input.ageMs.p99.toFixed(1)}ms`
    : '';
  console.log(
    `${t} ${String(batch.session || '?').slice(0, 6)} `
    + `present ${String(guestFps).padStart(3)}/s  page ${String(Math.round(snap.fps || 0)).padStart(2)}  `
    + `steps ${((snap.stepsPerSec || 0) / 1e6).toFixed(1)}M/s  `
    + `step p50 ${pct(totals, 50).toFixed(1)} p99 ${pct(totals, 99).toFixed(1)}ms  `
    + `guest ${share(1)}% thr ${share(2)}% paint ${share(3)}%  `
    + `throttled ${Math.round((throttled / Math.max(1, steps.length)) * 100)}%  `
    + `${sparkline(steps.map(s => s[0]), 16.7)}${inp}${warn}`,
  );
}

// ---------------------------------------------------------------------------
// Agent control hub  (/api/agent/*, docs/design-agent-control.md)
// ---------------------------------------------------------------------------
//
// A browser page cannot accept connections, so it polls for work — the shape
// tools/ios-selftest-server.js proved for the ios lab, made session-aware:
// lib/agent-remote.js registers with hello, long-polls /poll, executes each
// command in the page and posts /result; tools/ctl.js (or curl) posts into
// /ctl and its response is HELD OPEN until the page's result comes back, so
// the shell command prints the answer itself.
//
// The command set includes eval, so when the server is bound beyond
// localhost every agent route requires the token printed at startup
// (?token=...); on a pure-localhost bind the exposure is nil and the token
// is not asked for, to keep the connect snippet short.

const AGENT_POLL_HOLD_MS = 25000;   // how long /poll parks before answering []
const AGENT_CTL_TIMEOUT_MS = 20000; // how long /ctl waits for the page
const AGENT_SESSION_TTL_MS = 60000; // no poll for this long = session gone
const MAX_AGENT_BYTES = 8 * 1024 * 1024; // a PNG data URL rides /result

const agentSessions = new Map(); // id -> session
let agentCommandId = 1;

function agentPrune() {
  const now = Date.now();
  for (const [id, s] of agentSessions) {
    if (now - s.lastSeen > AGENT_SESSION_TTL_MS) {
      for (const group of new Set(s.waiting.values())) {
        clearTimeout(group.timer);
        sendJson(group.res, 502, { ok: false, error: 'session went away' });
      }
      agentSessions.delete(id);
    }
  }
}

function agentFlushPoll(session) {
  if (!session.pollRes || !session.queue.length) return;
  const res = session.pollRes;
  clearTimeout(session.pollTimer);
  session.pollRes = null;
  session.pollTimer = null;
  const batch = session.queue.splice(0, session.queue.length);
  sendJson(res, 200, batch);
}

async function handleAgent(req, res, url, opts) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const token = opts && opts.agentToken;
  if (token && url.searchParams.get('token') !== token) {
    return sendJson(res, 403, { ok: false, error: 'this hub is bound beyond localhost; pass ?token= (printed at server startup)' });
  }
  agentPrune();
  const route = url.pathname.slice('/api/agent/'.length);

  if (route === 'hello' && req.method === 'POST') {
    let info = {};
    try { info = JSON.parse(await readBody(req, 64 * 1024)) || {}; } catch (_) {}
    const id = crypto.randomBytes(4).toString('hex');
    agentSessions.set(id, {
      id, kind: 'browser', app: info.app || null, href: info.href || '', ua: info.ua || '',
      created: Date.now(), lastSeen: Date.now(),
      queue: [], pollRes: null, pollTimer: null,
      waiting: new Map(), // command id -> {res, timer, expect, results, single}
    });
    console.log(`${new Date().toISOString().slice(11, 19)}  AGENT session ${id} connected`
      + ` app=${info.app || '?'} ${String(info.href || '').slice(0, 80)}`);
    return sendJson(res, 200, { sessionId: id });
  }

  if (route === 'sessions' && req.method === 'GET') {
    const now = Date.now();
    return sendJson(res, 200, {
      sessions: [...agentSessions.values()].map(s => ({
        id: s.id, kind: s.kind, app: s.app, href: s.href,
        ageSec: Math.round((now - s.created) / 1000),
        lastSeenSec: Math.round((now - s.lastSeen) / 1000),
      })),
    });
  }

  const session = agentSessions.get(url.searchParams.get('s') || '');

  if (route === 'poll' && req.method === 'GET') {
    if (!session) return sendJson(res, 410, { error: 'no such session — say hello again' });
    session.lastSeen = Date.now();
    // One poll per session: a second one (a reloaded tab, a duplicated
    // request) replaces the first rather than splitting the queue.
    if (session.pollRes) {
      clearTimeout(session.pollTimer);
      sendJson(session.pollRes, 200, []);
    }
    session.pollRes = res;
    session.pollTimer = setTimeout(() => {
      if (session.pollRes !== res) return;
      session.pollRes = null;
      session.pollTimer = null;
      sendJson(res, 200, []);
    }, AGENT_POLL_HOLD_MS);
    req.on('close', () => { if (session.pollRes === res) { session.pollRes = null; clearTimeout(session.pollTimer); } });
    agentFlushPoll(session);
    return;
  }

  if (route === 'result' && req.method === 'POST') {
    if (!session) return sendJson(res, 410, { error: 'no such session' });
    session.lastSeen = Date.now();
    let body;
    try { body = JSON.parse(await readBody(req, MAX_AGENT_BYTES)); }
    catch (error) { return sendJson(res, 400, { error: String(error.message || error) }); }
    const results = Array.isArray(body.results) ? body.results : [body];
    for (const result of results) {
      const group = session.waiting.get(result.id);
      if (!group) continue;
      session.waiting.delete(result.id);
      group.results[group.slots.get(result.id)] = { ok: !!result.ok, value: result.value, error: result.error };
      if (--group.expect === 0) {
        clearTimeout(group.timer);
        sendJson(group.res, 200, group.single ? group.results[0] : group.results);
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'ctl' && req.method === 'POST') {
    if (!session) return sendJson(res, 410, { ok: false, error: 'no such session — check ctl.js sessions' });
    let parsed;
    try { parsed = JSON.parse(await readBody(req, 1024 * 1024)); }
    catch (error) { return sendJson(res, 400, { ok: false, error: String(error.message || error) }); }
    const commands = Array.isArray(parsed) ? parsed : [parsed];
    const group = {
      res, expect: commands.length, results: new Array(commands.length),
      single: !Array.isArray(parsed), slots: new Map(),
      timer: setTimeout(() => {
        for (const [cid] of group.slots) session.waiting.delete(cid);
        sendJson(res, 504, { ok: false, error: 'no answer from the page in 20s — is the tab still open?' });
      }, AGENT_CTL_TIMEOUT_MS),
    };
    commands.forEach((cmd, slot) => {
      const cid = agentCommandId++;
      group.slots.set(cid, slot);
      session.waiting.set(cid, group);
      session.queue.push(Object.assign({}, typeof cmd === 'string' ? { cmd } : cmd, { id: cid }));
    });
    agentFlushPoll(session);
    return;
  }

  return sendJson(res, 404, { error: 'agent routes: hello, poll, result, ctl, sessions' });
}

// ---------------------------------------------------------------------------

function createServer(opts) {
  const store = (opts && opts.store) || new Store();
  const quiet = !!(opts && opts.quiet);
  // Static requests are hundreds of lines of noise next to a handful of
  // signaling calls, so they are off unless asked for.
  const verbose = !!(opts && opts.verbose);
  const server = http.createServer((req, res) => {
    // Treat every request target as an origin-form path. A browser can retain
    // a doubled leading slash while resolving `//?debug`; passing that string
    // straight to URL interprets it as a protocol-relative URL with an empty
    // host and throws, taking down the entire development server. Collapse
    // only the leading slash run, then reject any other malformed target on
    // this request instead of crashing every open emulator tab.
    const target = String(req.url || '/').replace(/^\/{2,}/, '/');
    let url;
    try {
      url = new URL(target, 'http://localhost');
    } catch (_) {
      return sendJson(res, 400, { error: 'malformed request target' });
    }

    // Perf batches arrive ~1/sec and would bury the signaling log, so they
    // are routed before it and print their own one-line summary instead.
    if (url.pathname === '/api/perf') {
      handlePerf(req, res, { quiet, perfLog: opts && opts.perfLog }).catch(err => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err && err.message || err) });
      });
      return;
    }

    // Agent hub traffic is long-polls and held responses; route it before
    // the generic API logging, which would print one line per idle poll.
    if (url.pathname.startsWith('/api/agent/')) {
      handleAgent(req, res, url, { agentToken: opts && opts.agentToken }).catch(err => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err && err.message || err) });
      });
      return;
    }
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
    // Auto-connect injection only on a localhost bind: with a wider bind the
    // page would need the agent token, and serving the token to every viewer
    // is serving control of every session.
    const agentInject = !(opts && opts.agentToken) && !(opts && opts.noAgentInject);
    serveStatic(req, res, url.pathname === '/' ? '/index.html' : url.pathname, agentInject);
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
  const perfLog = arg('perf-log', '');
  // The agent hub carries eval into any connected page, so a bind beyond
  // localhost requires the token on every agent route.
  const agentToken = host === '127.0.0.1' ? null : crypto.randomBytes(8).toString('hex');
  const server = createServer({
    quiet: process.argv.includes('--quiet'),
    verbose: process.argv.includes('--verbose'),
    perfLog,
    agentToken,
    noAgentInject: process.argv.includes('--no-agent-inject'),
  });
  server.listen(port, host, () => {
    console.log(`wine-assembly dev server: http://${host}:${port}`);
    console.log(`  serving ${ROOT}`);
    console.log('  signaling API at /api/data, /api/public-data (no login, in memory)');
    console.log(`  perf stream sink at /api/perf — open http://${host}:${port}/?debug&perf&perf-stream`);
    console.log(`  threads probe: http://${host}:${port}/threads-probe.html`
      + (ISOLATE ? '  (COOP/COEP served: isolated)' : '  (no COOP/COEP; use --isolate or the page\'s service-worker button)'));
    if (perfLog) console.log(`  perf batches appended as NDJSON to ${perfLog}`);
    const tokenQuery = agentToken ? `?token=${agentToken}` : '';
    const injecting = !agentToken && !process.argv.includes('--no-agent-inject');
    if (injecting) {
      console.log('  agent hub at /api/agent — the emulator page auto-connects when served');
      console.log('  from here: copy the tab URL and drive it, e.g.');
      console.log(`    node tools/ctl.js -s 'http://${host}:${port}/?debug' png out.png`);
      console.log('  pages served elsewhere connect by console paste:');
    } else {
      console.log('  agent hub at /api/agent — connect a page by pasting into its console:');
    }
    console.log(`    import('http://${host === '0.0.0.0' ? '<lan-ip>' : host}:${port}/lib/agent-remote.js${tokenQuery}')`
      + `.then(m => m.connect())`);
    console.log(`  then drive it: node tools/ctl.js sessions | node tools/ctl.js -s <ID> png out.png`);
    if (agentToken) console.log(`  agent token (bound beyond localhost): ${agentToken}`);
    if (host === '0.0.0.0') {
      console.log('  NOTE: bound to all interfaces and unauthenticated — trusted networks only');
    }
  });
}

if (require.main === module) main();

module.exports = { createServer, Store, resolveStatic, ROOT };
