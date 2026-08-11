#!/usr/bin/env node
// Browser smoke coverage for promoted desktop candidate apps.
//
// This exercises index.html under 127.0.0.1, launches each candidate from the
// desktop/select control, and checks more than HWND creation: rendered content
// plus a small app-specific action where the app has a stable command or input
// path.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT_HINT = process.env.CANDIDATE_WEB_DEBUG_PORT
  ? Number(process.env.CANDIDATE_WEB_DEBUG_PORT)
  : 0;
const TRACE_API_NAMES = String(process.env.CANDIDATE_TRACE_API || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const TRACE_HOST_NAMES = String(process.env.CANDIDATE_TRACE_HOST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const SCREENSHOT_DIR = process.env.CANDIDATE_SCREENSHOT_DIR || '';
const DEBUG_EVAL = process.env.CANDIDATE_DEBUG_EVAL === '1';
const BASE_URL = String(process.env.CANDIDATE_BASE_URL || '').trim();

const ALL_CANDIDATES = [
  {
    id: 'peaks',
    label: 'Peaks',
    titlePattern: 'Peaks',
    commands: [40005],
    minColors: 60,
    minDiff: 80,
    waitMs: 1000,
    forbidDialogs: ['Get Started', 'Hall of Fame'],
  },
  {
    id: 'fourstones',
    label: 'FourStones',
    titlePattern: 'Four Stones|FourStones',
    bootCommands: [40005],
    commands: [40002],
    minColors: 60,
    waitMs: 1000,
    forbidDialogs: ['Get Started'],
  },
  {
    id: 'qblackjack',
    label: 'Blackjack',
    titlePattern: 'Blackjack',
    dismissDialogControl: 1,
    commands: [311],
    forbidDialogs: ["You can't afford", 'Congratulations'],
    minColors: 80,
    minDiff: 40,
    waitMs: 1000,
    commandWaitMs: 2500,
  },
  {
    id: 'cwordzap',
    label: 'CWordZap',
    titlePattern: 'Addictionary|W O R D Z A P|WORD ZAP|WordZap|CWordZap',
    commands: [40003],
    clicks: [
      { guestX: 285, guestY: 455, waitMs: 500, snapshotAfter: 'after-ready-click' },
    ],
    minCanvasHeight: 480,
    minMainHeight: 440,
    minColors: 12,
    minDiff: 80,
    waitMs: 1500,
    commandWaitMs: 1800,
  },
  {
    id: 'marbles',
    label: 'Marbles',
    titlePattern: 'Marbles|Lose Your Marbles',
    clicks: [
      {
        guestX: 320,
        guestY: 240,
        holdMs: 220,
        waitMs: 200,
        snapshotAfter: 'after-intro-click',
        maxSaturatedShare: 0.03,
        maxDarkShare: 0.50,
        waitForGuestPixelBefore: {
          x: 300, y: 170,
          rMax: 70, gMax: 80, bMin: 60, bMax: 150,
          timeoutMs: 20000,
          label: 'select mode panel',
        },
      },
      {
        guestX: 130,
        guestY: 130,
        holdMs: 250,
        waitMs: 500,
        snapshotAfter: 'after-skill-click',
        waitForGuestPixelBefore: {
          x: 100, y: 300,
          rMax: 70, gMax: 80, bMin: 60, bMax: 130,
          timeoutMs: 15000,
          label: 'skill panel',
        },
      },
    ],
    waitForGuestPixelAfterClicks: {
      x: 100, y: 300,
      rMin: 200, gMin: 200, bMin: 200,
      timeoutMs: 10000,
      label: 'level selection',
    },
    preGameKeys: [
      { vk: 13, holdMs: 500, waitMs: 1200, snapshotAfter: 'after-start-key' },
    ],
    keys: [
      { vk: 39, label: 'select column right', holdMs: 180, waitMs: 500, minDiff: 100, snapshotAfter: 'after-key-right' },
      { vk: 38, label: 'move column up', holdMs: 180, waitMs: 650, minDiff: 400, snapshotAfter: 'after-key-up' },
      { vk: 32, label: 'rotate center row', holdMs: 180, waitMs: 650, minDiff: 700, snapshotAfter: 'after-key-space' },
      { vk: 40, label: 'move column down', holdMs: 180, waitMs: 650, minDiff: 400, snapshotAfter: 'after-key-down' },
    ],
    minColors: 80,
    minDiff: 2500,
    minKeyDiff: 2500,
    waitMs: 2500,
    actionWaitMs: 1600,
  },
];
const CANDIDATE_FILTER = new Set(String(process.env.CANDIDATE_IDS || process.argv.slice(2).join(',') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean));
const CANDIDATES = CANDIDATE_FILTER.size
  ? ALL_CANDIDATES.filter(app => CANDIDATE_FILTER.has(app.id))
  : ALL_CANDIDATES;
if (CANDIDATE_FILTER.size && CANDIDATES.length !== CANDIDATE_FILTER.size) {
  const known = new Set(ALL_CANDIDATES.map(app => app.id));
  const unknown = [...CANDIDATE_FILTER].filter(id => !known.has(id));
  console.error(`Unknown local candidate id(s): ${unknown.join(', ')}`);
  console.error(`Known local candidates: ${ALL_CANDIDATES.map(app => app.id).join(', ')}`);
  process.exit(1);
}

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for local candidate browser test');
  process.exit(0);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mid' || ext === '.midi') return 'audio/midi';
  return 'application/octet-stream';
}

function startStaticServer() {
  const rootReal = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (_) {
      res.writeHead(400);
      res.end('bad url');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const candidate = path.normalize(path.join(rootReal, pathname));
    if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(candidate, (err, data) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500);
        res.end(err.code || 'read error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': mimeType(candidate),
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function reserveTcpPort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', err => {
      if (preferred) reserveTcpPort(0).then(resolve, reject);
      else reject(err);
    });
    server.listen(preferred, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
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

function wsConnect(wsUrl) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect(Number(u.port), u.hostname);
  let buf = Buffer.alloc(0);
  let ready = false;
  let nextId = 1;
  const pending = new Map();
  const events = [];

  function parseFrames() {
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2)) throw new Error('large websocket frame');
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if ((b0 & 0x0f) !== 1) continue;
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        events.push(msg);
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
      const tick = () => {
        if (ready) resolve();
        else if (Date.now() - started > 5000) reject(new Error('websocket timeout'));
        else setTimeout(tick, 25);
      };
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

  return { opened, send, close: () => socket.destroy(), events };
}

function consoleEventSummary(events) {
  const out = [];
  for (const ev of events) {
    if (ev.method === 'Runtime.consoleAPICalled') {
      const p = ev.params || {};
      out.push((p.args || []).map(a => {
        if (Object.prototype.hasOwnProperty.call(a, 'value')) return String(a.value);
        return a.description || a.unserializableValue || '';
      }).join(' '));
    } else if (ev.method === 'Runtime.exceptionThrown') {
      const d = (ev.params && ev.params.exceptionDetails) || {};
      out.push(d.text || (d.exception && d.exception.description) || '');
    } else if (ev.method === 'Log.entryAdded') {
      const e = (ev.params && ev.params.entry) || {};
      out.push(e.text || '');
    }
  }
  return out.filter(Boolean).slice(-120);
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function jsArray(values) {
  return JSON.stringify(values);
}

async function main() {
  const server = BASE_URL ? null : await startStaticServer();
  const port = server ? server.address().port : 0;
  const debugPort = await reserveTcpPort(DEBUG_PORT_HINT);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-candidates-profile-'));
  const launchUrl = (() => {
    const raw = BASE_URL || `http://127.0.0.1:${port}/index.html`;
    const url = new URL(raw);
    url.searchParams.set('candidate-web', String(Date.now()));
    return url.href;
  })();
  const launchHost = new URL(launchUrl).host;
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userData}`,
    launchUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });

  let cdp = null;
  const cleanup = () => {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  let page;
  for (let i = 0; i < 100; i++) {
    try {
      const pages = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      page = pages.find(p => p.type === 'page' && String(p.url || '').includes(launchHost));
      if (page) break;
    } catch (_) {}
    await wait(100);
  }
  assert(page, 'Chrome page did not appear\nchrome:\n' + chromeErr.slice(-4000));

  cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  try { await cdp.send('Log.enable'); } catch (_) {}

  async function evalExpr(expression, timeoutMs = 10000) {
    const preview = expression.replace(/\s+/g, ' ').slice(0, 180);
    if (DEBUG_EVAL) console.error('[eval]', preview);
    const started = Date.now();
    for (;;) {
      const remaining = Math.max(1, timeoutMs - (Date.now() - started));
      const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime.evaluate timeout')), remaining));
      let result;
      try {
        result = await Promise.race([cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }), timer]);
      } catch (e) {
        const retryable = /Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(e.message);
        if (retryable && Date.now() - started < timeoutMs) {
          await wait(150);
          continue;
        }
        e.message += '\nwhile evaluating: ' + preview;
        throw e;
      }
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      }
      return result.result && result.result.value;
    }
  }

  await evalExpr(`new Promise(resolve => {
    if (document.readyState === 'complete') resolve(1);
    else window.addEventListener('load', () => resolve(1), { once: true });
  })`);
  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (typeof WineAssembly !== 'undefined' &&
          typeof Win98Renderer !== 'undefined' &&
          typeof StorageImports !== 'undefined' &&
          typeof launchApp === 'function' &&
          typeof stopAllApps === 'function') resolve(1);
      else if (performance.now() - started > 10000) reject(new Error('page globals not ready'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 12000);
  if (TRACE_API_NAMES.length || TRACE_HOST_NAMES.length) {
    await evalExpr(`(() => {
      window.__waTraceApiNames = new Set(${jsArray(TRACE_API_NAMES)});
      window.__waTraceHostNames = new Set(${jsArray(TRACE_HOST_NAMES)});
      return 1;
    })()`);
  }

  const ids = CANDIDATES.map(c => c.id);
  const localState = await evalExpr(`(() => ({
    localDesktop: LOCAL_DESKTOP,
    options: [...document.querySelectorAll('#app-select option')].map(o => o.value),
    icons: [...document.querySelectorAll('.desktop-icon')].map(e => e.dataset.app),
  }))()`);
  if (!BASE_URL) {
    assert.strictEqual(localState.localDesktop, true, 'test page should be recognized as a local desktop host');
  }
  for (const id of ids) {
    assert(localState.options.includes(id), `local app select should include ${id}`);
    assert(localState.icons.includes(id), `local desktop should include ${id}`);
  }

  async function snapshot(app) {
    return evalExpr(`(() => {
      const titleRe = new RegExp(${jsString(app.titlePattern)}, 'i');
      if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
      const canvas = document.getElementById('screen');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const visible = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .filter(w => w && w.visible)
        .map(w => ({
          hwnd: w.hwnd >>> 0,
          title: w.title || '',
          x: w.x | 0,
          y: w.y | 0,
          w: w.w | 0,
          h: w.h | 0,
          zOrder: w.zOrder | 0,
          isChild: !!w.isChild,
          isDialog: !!w.isDialog,
        }));
      const main = visible
        .filter(w => !w.isDialog && titleRe.test(w.title || ''))
        .sort((a, b) => b.zOrder - a.zOrder)[0] ||
        visible.filter(w => !w.isDialog).sort((a, b) => b.zOrder - a.zOrder)[0] ||
        visible.sort((a, b) => b.zOrder - a.zOrder)[0] || null;
      const rect = main ? {
        x0: Math.max(0, Math.min(canvas.width, main.x + 4)),
        y0: Math.max(0, Math.min(canvas.height, main.y + 28)),
        x1: Math.max(0, Math.min(canvas.width, main.x + main.w - 4)),
        y1: Math.max(0, Math.min(canvas.height, main.y + main.h - 4)),
      } : { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
      if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) {
        rect.x0 = 0; rect.y0 = 0; rect.x1 = canvas.width; rect.y1 = canvas.height;
      }
      const hist = new Map();
      let total = 0, white = 0, dark = 0, saturated = 0, nonBackground = 0;
      for (let y = rect.y0; y < rect.y1; y++) {
        for (let x = rect.x0; x < rect.x1; x++) {
          const i = (y * canvas.width + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const key = (r << 16) | (g << 8) | b;
          hist.set(key, (hist.get(key) || 0) + 1);
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (r > 235 && g > 235 && b > 235) white++;
          if (r < 32 && g < 32 && b < 32) dark++;
          if (max > 140 && max - min > 80) saturated++;
          if (!((r === 0 && g === 128 && b === 128) ||
                (r === 192 && g === 192 && b === 192))) nonBackground++;
          total++;
        }
      }
      let top = 0;
      for (const n of hist.values()) if (n > top) top = n;
      return {
        status: document.getElementById('status').textContent,
        log: document.getElementById('log').textContent.slice(-4000),
        runningApps: runningApps.length,
        selected: document.getElementById('app-select').value,
        canvas: { width: canvas.width | 0, height: canvas.height | 0 },
        windows: visible,
        main,
        rect,
        metrics: {
          colors: hist.size,
          topShare: total ? top / total : 1,
          total,
          white,
          dark,
          saturated,
          nonBackground,
        },
      };
    })()`);
  }

  async function diffSince(before, app) {
    const baselineName = (before && before.baselineName) || '__candidateBaseline';
    return evalExpr(`(() => {
      const before = window[${jsString(baselineName)}];
      if (!before || !before.pixels) throw new Error('missing candidate diff baseline');
      const titleRe = new RegExp(${jsString(app.titlePattern)}, 'i');
      if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
      const canvas = document.getElementById('screen');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const visible = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .filter(w => w && w.visible)
        .map(w => ({
          hwnd: w.hwnd >>> 0,
          title: w.title || '',
          x: w.x | 0,
          y: w.y | 0,
          w: w.w | 0,
          h: w.h | 0,
          zOrder: w.zOrder | 0,
          isDialog: !!w.isDialog,
        }));
      const main = visible
        .filter(w => !w.isDialog && titleRe.test(w.title || ''))
        .sort((a, b) => b.zOrder - a.zOrder)[0] ||
        visible.filter(w => !w.isDialog).sort((a, b) => b.zOrder - a.zOrder)[0] ||
        visible.sort((a, b) => b.zOrder - a.zOrder)[0] || null;
      const rect = main ? {
        x0: Math.max(0, Math.min(canvas.width, main.x + 4)),
        y0: Math.max(0, Math.min(canvas.height, main.y + 28)),
        x1: Math.max(0, Math.min(canvas.width, main.x + main.w - 4)),
        y1: Math.max(0, Math.min(canvas.height, main.y + main.h - 4)),
      } : before.rect;
      let diff = 0;
      for (let y = rect.y0; y < rect.y1; y++) {
        for (let x = rect.x0; x < rect.x1; x++) {
          const p = before.pixels[String(y) + ',' + String(x)];
          if (!p) continue;
          const i = (y * canvas.width + x) * 4;
          if (Math.abs(data[i] - p[0]) + Math.abs(data[i + 1] - p[1]) + Math.abs(data[i + 2] - p[2]) > 40) diff++;
        }
      }
      return { diff, windows: visible };
    })()`);
  }

  async function captureDiffBaseline(app, baselineName = '__candidateBaseline') {
    return evalExpr(`(() => {
      const titleRe = new RegExp(${jsString(app.titlePattern)}, 'i');
      if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
      const canvas = document.getElementById('screen');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const visible = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .filter(w => w && w.visible)
        .map(w => ({
          hwnd: w.hwnd >>> 0,
          title: w.title || '',
          x: w.x | 0,
          y: w.y | 0,
          w: w.w | 0,
          h: w.h | 0,
          zOrder: w.zOrder | 0,
          isDialog: !!w.isDialog,
        }));
      const main = visible
        .filter(w => !w.isDialog && titleRe.test(w.title || ''))
        .sort((a, b) => b.zOrder - a.zOrder)[0] ||
        visible.filter(w => !w.isDialog).sort((a, b) => b.zOrder - a.zOrder)[0] ||
        visible.sort((a, b) => b.zOrder - a.zOrder)[0] || null;
      const rect = main ? {
        x0: Math.max(0, Math.min(canvas.width, main.x + 4)),
        y0: Math.max(0, Math.min(canvas.height, main.y + 28)),
        x1: Math.max(0, Math.min(canvas.width, main.x + main.w - 4)),
        y1: Math.max(0, Math.min(canvas.height, main.y + main.h - 4)),
      } : { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
      const pixels = {};
      const step = Math.max(1, Math.floor(Math.sqrt(((rect.x1 - rect.x0) * (rect.y1 - rect.y0)) / 50000)));
      for (let y = rect.y0; y < rect.y1; y += step) {
        for (let x = rect.x0; x < rect.x1; x += step) {
          const i = (y * canvas.width + x) * 4;
          pixels[String(y) + ',' + String(x)] = [data[i], data[i + 1], data[i + 2]];
        }
      }
      window[${jsString(baselineName)}] = { rect, pixels, step };
      return { baselineName: ${jsString(baselineName)}, rect, sampleCount: Object.keys(pixels).length, step };
    })()`);
  }

  async function saveCanvasSnapshot(app, label) {
    if (!SCREENSHOT_DIR) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const dataUrl = await evalExpr(`(() => {
      const canvas = document.getElementById('screen');
      return canvas.toDataURL('image/png');
    })()`);
    const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `${app.id}-${label}.png`), Buffer.from(b64, 'base64'));
  }

  async function waitForLaunch(app) {
    try {
      await evalExpr(`new Promise((resolve, reject) => {
      const titleRe = new RegExp(${jsString(app.titlePattern)}, 'i');
      const started = performance.now();
      const tick = () => {
        const visible = Object.values((sharedRenderer && sharedRenderer.windows) || {})
          .filter(w => w && w.visible);
        const hasExpected = visible.some(w => !w.isDialog && titleRe.test(w.title || ''));
        const hasAnyMain = visible.some(w => !w.isDialog);
        const log = document.getElementById('log').textContent;
        if (runningApps.length === 1 && hasExpected) resolve(1);
        else if (/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED/i.test(log)) reject(new Error('launch log contains error'));
        else if (performance.now() - started > 25000) {
          const app = runningApps[0];
          const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
          let mainHwnd = 0;
          try { mainHwnd = e && e.get_main_hwnd ? (e.get_main_hwnd() >>> 0) : 0; } catch (_) {}
          reject(new Error(${jsString(app.id + ' visible window did not appear')} + ': ' + JSON.stringify({
            runningApps: runningApps.length,
            mainHwnd,
            status: document.getElementById('status').textContent,
            windows: visible.map(w => ({ hwnd: w.hwnd >>> 0, title: w.title || '', visible: !!w.visible, isDialog: !!w.isDialog, x: w.x | 0, y: w.y | 0, w: w.w | 0, h: w.h | 0 })),
            log: log.slice(-1000),
          })));
        }
        else setTimeout(tick, 100);
      };
      tick();
    })`, 28000);
    } catch (e) {
      const consoleText = consoleEventSummary(cdp.events).join('\n');
      if (consoleText) e.message += '\nconsole:\n' + consoleText.slice(-4000);
      throw e;
    }
  }

  async function waitForInstance(app) {
    await evalExpr(`new Promise((resolve, reject) => {
      const started = performance.now();
      const tick = () => {
        const app = runningApps[0];
        const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
        const log = document.getElementById('log').textContent;
        if (runningApps.length === 1 && e && e.post_message_q && e.get_main_hwnd) resolve(1);
        else if (/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED/i.test(log)) reject(new Error('launch log contains error'));
        else if (performance.now() - started > 25000) reject(new Error(${jsString(app.id + ' wasm instance did not start')}));
        else setTimeout(tick, 100);
      };
      tick();
    })`, 28000);
  }

  async function waitForDialogControl(ctrlId, timeoutMs = 10000) {
    await evalExpr(`new Promise((resolve, reject) => {
      const started = performance.now();
      const wanted = ${ctrlId >>> 0};
      const tick = () => {
        const app = runningApps[0];
        const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
        const visibleDialogs = Object.values((sharedRenderer && sharedRenderer.windows) || {})
          .filter(w => w && w.visible && w.isDialog)
          .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
        const seen = new Set();
        const findChildById = (parent) => {
          if (!e || !parent || seen.has(parent) || !e.wnd_next_child_slot || !e.wnd_slot_hwnd || !e.ctrl_get_id) return 0;
          seen.add(parent);
          let s = 0;
          while ((s = e.wnd_next_child_slot(parent, s)) !== -1) {
            const ch = e.wnd_slot_hwnd(s);
            if (ch && e.ctrl_get_id(ch) === wanted) return ch;
            const nested = findChildById(ch);
            if (nested) return nested;
            s++;
          }
          return 0;
        };
        for (const dlg of visibleDialogs) {
          const child = findChildById(dlg.hwnd | 0);
          if (child) { resolve(1); return; }
        }
        const log = document.getElementById('log').textContent;
        if (/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED/i.test(log)) reject(new Error('launch log contains error'));
        else if (performance.now() - started > ${timeoutMs | 0}) reject(new Error('dialog control ' + wanted + ' did not appear'));
        else setTimeout(tick, 100);
      };
      tick();
    })`, Math.max(2000, timeoutMs + 3000));
  }

  async function waitForLogText(text, timeoutMs = 10000) {
    try {
      await evalExpr(`new Promise((resolve, reject) => {
      const wanted = ${jsString(text)};
      const started = performance.now();
      const tick = () => {
        const log = document.getElementById('log').textContent;
        if (log.includes(wanted)) { resolve(1); return; }
        if (/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED/i.test(log)) {
          reject(new Error('log contains error while waiting for ' + wanted + ': ' + log.slice(-1200)));
          return;
        }
        if (performance.now() - started > ${timeoutMs | 0}) {
          const status = document.getElementById('status').textContent;
          const windows = Object.values((sharedRenderer && sharedRenderer.windows) || {})
            .filter(w => w && w.visible)
            .map(w => ({ hwnd: w.hwnd >>> 0, title: w.title || '', isDialog: !!w.isDialog }));
          reject(new Error('timed out waiting for log text ' + wanted + ': ' + JSON.stringify({
            status,
            windows,
            log: log.slice(-1200),
            inputs: log.split('\\n').filter(line => line.includes('[input]')).slice(-40),
          })));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    })`, Math.max(2000, timeoutMs + 3000));
    } catch (e) {
      const consoleLines = consoleEventSummary(cdp.events);
      const apiText = consoleLines.filter(line => line.includes('[API]')).slice(-120).join('\n');
      const inputText = consoleLines.filter(line => line.includes('[input]')).slice(-120).join('\n');
      const consoleText = consoleLines.join('\n').slice(-1200);
      if (apiText) e.message += '\napi:\n' + apiText;
      if (inputText) e.message += '\ninput:\n' + inputText;
      if (consoleText) e.message += '\nconsole:\n' + consoleText;
      throw e;
    }
  }

  async function waitForGuestPixel(spec) {
    const timeoutMs = spec.timeoutMs || 10000;
    await evalExpr(`new Promise((resolve, reject) => {
      const spec = ${JSON.stringify(spec)};
      const started = performance.now();
      const mapGuestToCanvas = (x, y) => {
        const t = sharedRenderer && sharedRenderer._exclusiveTransform;
        if (t && t.srcW && t.srcH && t.dstW && t.dstH) {
          return {
            x: Math.round((t.dstX || 0) + ((x - (t.srcX || 0)) * t.dstW / t.srcW)),
            y: Math.round((t.dstY || 0) + ((y - (t.srcY || 0)) * t.dstH / t.srcH)),
            transform: Object.assign({}, t),
          };
        }
        return { x: x | 0, y: y | 0, transform: t ? Object.assign({}, t) : null };
      };
      const matches = (r, g, b, a) => {
        if (spec.rMin != null && r < spec.rMin) return false;
        if (spec.rMax != null && r > spec.rMax) return false;
        if (spec.gMin != null && g < spec.gMin) return false;
        if (spec.gMax != null && g > spec.gMax) return false;
        if (spec.bMin != null && b < spec.bMin) return false;
        if (spec.bMax != null && b > spec.bMax) return false;
        if (spec.aMin != null && a < spec.aMin) return false;
        if (spec.aMax != null && a > spec.aMax) return false;
        return true;
      };
      const tick = () => {
        if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
        const canvas = document.getElementById('screen');
        if (!canvas) { reject(new Error('canvas unavailable')); return; }
        const p = mapGuestToCanvas(spec.x | 0, spec.y | 0);
        if (p.x >= 0 && p.y >= 0 && p.x < canvas.width && p.y < canvas.height) {
          const d = canvas.getContext('2d').getImageData(p.x, p.y, 1, 1).data;
          if (matches(d[0], d[1], d[2], d[3])) {
            resolve({ guest: { x: spec.x | 0, y: spec.y | 0 }, canvas: p, rgba: [d[0], d[1], d[2], d[3]] });
            return;
          }
        }
        const log = document.getElementById('log').textContent;
        if (/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED/i.test(log)) {
          reject(new Error('log contains error while waiting for pixel: ' + log.slice(-1200)));
          return;
        }
        if (performance.now() - started > ${timeoutMs | 0}) {
          const last = (() => {
            if (p.x < 0 || p.y < 0 || p.x >= canvas.width || p.y >= canvas.height) return null;
            const d = canvas.getContext('2d').getImageData(p.x, p.y, 1, 1).data;
            return [d[0], d[1], d[2], d[3]];
          })();
          reject(new Error('timed out waiting for guest pixel ' + (spec.label || '') + ': ' + JSON.stringify({
            spec,
            canvas: p,
            last,
            size: { w: canvas.width, h: canvas.height },
            log: log.slice(-1200),
          })));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    })`, Math.max(2000, timeoutMs + 3000));
  }

  async function clickDialogControl(ctrlId) {
    await evalExpr(`(() => {
      const app = runningApps[0];
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      if (!e || !e.send_message || !e.wnd_next_child_slot || !e.wnd_slot_hwnd || !e.ctrl_get_id) {
        throw new Error('dialog control helpers unavailable');
      }
      const wanted = ${ctrlId >>> 0};
      const visibleDialogs = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .filter(w => w && w.visible && w.isDialog)
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
      const seen = new Set();
      const findChildById = (parent) => {
        if (!parent || seen.has(parent)) return 0;
        seen.add(parent);
        let s = 0;
        while ((s = e.wnd_next_child_slot(parent, s)) !== -1) {
          const ch = e.wnd_slot_hwnd(s);
          if (ch && e.ctrl_get_id(ch) === wanted) return ch;
          const nested = findChildById(ch);
          if (nested) return nested;
          s++;
        }
        return 0;
      };
      for (const dlg of visibleDialogs) {
        const child = findChildById(dlg.hwnd | 0);
        if (child) {
          e.send_message(child, 0x0201, 0, 0);
          e.send_message(child, 0x0202, 0, 0);
          return 1;
        }
      }
      throw new Error('dialog control ' + wanted + ' not found');
    })()`);
  }

  async function postCommand(command) {
    return evalExpr(`(() => {
      const app = runningApps[0];
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      if (!e || !e.post_message_q || !e.get_main_hwnd) throw new Error('post_message_q unavailable');
      const hwnd = e.get_main_hwnd() >>> 0;
      e.post_message_q(hwnd, 0x0111, ${command >>> 0}, 0);
      return { kind: 'command', command: ${command >>> 0}, hwnd };
    })()`);
  }

  async function rendererMouseDown(x, y) {
    return evalExpr(`(() => {
      if (!sharedRenderer) throw new Error('renderer unavailable');
      const formatEvent = (evt) => evt ? ({
        type: evt.type || '',
        hwnd: evt.hwnd >>> 0,
        msg: evt.msg >>> 0,
        wParam: evt.wParam >>> 0,
        lParam: evt.lParam >>> 0,
        x: evt.lParam & 0xFFFF,
        y: (evt.lParam >>> 16) & 0xFFFF,
        mouseX: evt.mouseX | 0,
        mouseY: evt.mouseY | 0,
        mouseButtons: evt.mouseButtons >>> 0,
      }) : null;
      const q = sharedRenderer.inputQueue || [];
      const beforeLen = q.length;
      const transform = sharedRenderer._exclusiveTransform
        ? Object.assign({}, sharedRenderer._exclusiveTransform)
        : null;
      const mapped = sharedRenderer._mapExclusiveInputPoint
        ? sharedRenderer._mapExclusiveInputPoint(${x | 0}, ${y | 0})
        : { x: ${x | 0}, y: ${y | 0} };
      sharedRenderer.handleMouseDown(${x | 0}, ${y | 0}, 0);
      return {
        kind: 'mousedown',
        x: ${x | 0},
        y: ${y | 0},
        mapped,
        transform,
        beforeLen,
        afterLen: q.length,
        events: q.slice(beforeLen).map(formatEvent),
      };
    })()`);
  }

  async function rendererMouseUp(x, y) {
    return evalExpr(`(() => {
      if (!sharedRenderer) throw new Error('renderer unavailable');
      const formatEvent = (evt) => evt ? ({
        type: evt.type || '',
        hwnd: evt.hwnd >>> 0,
        msg: evt.msg >>> 0,
        wParam: evt.wParam >>> 0,
        lParam: evt.lParam >>> 0,
        x: evt.lParam & 0xFFFF,
        y: (evt.lParam >>> 16) & 0xFFFF,
        mouseX: evt.mouseX | 0,
        mouseY: evt.mouseY | 0,
        mouseButtons: evt.mouseButtons >>> 0,
      }) : null;
      const q = sharedRenderer.inputQueue || [];
      const beforeLen = q.length;
      const transform = sharedRenderer._exclusiveTransform
        ? Object.assign({}, sharedRenderer._exclusiveTransform)
        : null;
      const mapped = sharedRenderer._mapExclusiveInputPoint
        ? sharedRenderer._mapExclusiveInputPoint(${x | 0}, ${y | 0})
        : { x: ${x | 0}, y: ${y | 0} };
      sharedRenderer.handleMouseUp(${x | 0}, ${y | 0}, 0);
      return {
        kind: 'mouseup',
        x: ${x | 0},
        y: ${y | 0},
        mapped,
        transform,
        beforeLen,
        afterLen: q.length,
        events: q.slice(beforeLen).map(formatEvent),
      };
    })()`);
  }

  async function rendererClick(x, y, holdMs = 0) {
    const down = await rendererMouseDown(x, y);
    if (holdMs > 0) await wait(holdMs);
    const up = await rendererMouseUp(x, y);
    return {
      kind: 'click',
      x: x | 0,
      y: y | 0,
      holdMs: holdMs | 0,
      mapped: down.mapped,
      transform: down.transform,
      down: down.events,
      up: up.events,
    };
  }

  async function rendererGuestClick(x, y, holdMs = 0) {
    const point = await evalExpr(`(() => {
      if (!sharedRenderer) throw new Error('renderer unavailable');
      const t = sharedRenderer._exclusiveTransform;
      if (t && t.srcW && t.srcH && t.dstW && t.dstH) {
        return {
          x: Math.round((t.dstX || 0) + ((${x | 0} - (t.srcX || 0)) * t.dstW / t.srcW)),
          y: Math.round((t.dstY || 0) + ((${y | 0} - (t.srcY || 0)) * t.dstH / t.srcH)),
          transform: Object.assign({}, t),
        };
      }
      return { x: ${x | 0}, y: ${y | 0}, transform: t ? Object.assign({}, t) : null };
    })()`);
    const action = await rendererClick(point.x, point.y, holdMs);
    action.guest = { x: x | 0, y: y | 0 };
    action.canvas = { x: point.x | 0, y: point.y | 0 };
    return action;
  }

  async function rendererDrag(points) {
    const p = points.map(([x, y]) => [x | 0, y | 0]);
    await evalExpr(`(() => {
      const points = ${JSON.stringify(p)};
      if (!sharedRenderer) throw new Error('renderer unavailable');
      sharedRenderer.handleMouseDown(points[0][0], points[0][1], 0);
      for (let i = 1; i < points.length - 1; i++) {
        sharedRenderer.handleMouseMove(points[i][0], points[i][1]);
      }
      const last = points[points.length - 1];
      sharedRenderer.handleMouseUp(last[0], last[1], 0);
      return 1;
    })()`);
  }

  async function rendererType(text) {
    await evalExpr(`(() => {
      if (!sharedRenderer) throw new Error('renderer unavailable');
      for (const ch of ${jsString(text)}) {
        sharedRenderer.handleKeyPress(ch.charCodeAt(0));
      }
      return 1;
    })()`);
  }

  async function rendererKeyTap(vk, holdMs = 80) {
    const down = await evalExpr(`(() => {
      if (!sharedRenderer || !sharedRenderer.handleKeyDown) throw new Error('renderer keydown unavailable');
      const q = sharedRenderer.inputQueue || [];
      const beforeLen = q.length;
      sharedRenderer.handleKeyDown(${vk | 0});
      const asyncDown = !!(sharedRenderer._asyncKeys && sharedRenderer._asyncKeys[${vk & 0xFF}]);
      return {
        kind: 'keydown',
        vk: ${vk | 0},
        asyncDown,
        beforeLen,
        afterLen: q.length,
        events: q.slice(beforeLen).map(evt => evt ? ({
          type: evt.type || '',
          hwnd: evt.hwnd >>> 0,
          msg: evt.msg >>> 0,
          wParam: evt.wParam >>> 0,
          lParam: evt.lParam >>> 0,
        }) : null),
      };
    })()`);
    if (holdMs > 0) await wait(holdMs);
    const up = await evalExpr(`(() => {
      if (!sharedRenderer || !sharedRenderer.handleKeyUp) throw new Error('renderer keyup unavailable');
      const q = sharedRenderer.inputQueue || [];
      const beforeLen = q.length;
      sharedRenderer.handleKeyUp(${vk | 0});
      const asyncDown = !!(sharedRenderer._asyncKeys && sharedRenderer._asyncKeys[${vk & 0xFF}]);
      return {
        kind: 'keyup',
        vk: ${vk | 0},
        asyncDown,
        beforeLen,
        afterLen: q.length,
        events: q.slice(beforeLen).map(evt => evt ? ({
          type: evt.type || '',
          hwnd: evt.hwnd >>> 0,
          msg: evt.msg >>> 0,
          wParam: evt.wParam >>> 0,
          lParam: evt.lParam >>> 0,
        }) : null),
      };
    })()`);
    return { kind: 'keytap', vk: vk | 0, holdMs: holdMs | 0, down, up };
  }

  const reports = [];
  for (const app of CANDIDATES) {
    await evalExpr(`(() => {
      stopAllApps();
      localStorage.clear();
      document.getElementById('log').textContent = '';
      document.getElementById('app-select').value = ${jsString(app.id)};
      return launchApp();
    })()`, 45000);
    await waitForInstance(app);
    if (app.dismissDialogControl) {
      await waitForDialogControl(app.dismissDialogControl);
      await clickDialogControl(app.dismissDialogControl);
      await wait(500);
    }
    if (app.bootCommands) {
      for (const command of app.bootCommands) {
        await postCommand(command);
        await wait(350);
      }
    }
    await waitForLaunch(app);
    await wait(app.waitMs || 500);

    const actions = [];
    const stageMetrics = [];
    const before = await captureDiffBaseline(app);
    await saveCanvasSnapshot(app, 'before');
    if (app.commands) {
      for (const command of app.commands) {
        actions.push(await postCommand(command));
        await wait(app.commandWaitMs || 350);
      }
    }
    const clicks = app.clicks || (app.click ? [app.click] : null);
    if (clicks) {
      for (const click of clicks) {
        if (click.waitForGuestPixelBefore) {
          await waitForGuestPixel(click.waitForGuestPixelBefore);
          if (click.waitAfterGuestPixelBeforeMs) await wait(click.waitAfterGuestPixelBeforeMs);
        }
        actions.push(click.guestX !== undefined || click.guestY !== undefined
          ? await rendererGuestClick(click.guestX || 0, click.guestY || 0, click.holdMs || 0)
          : await rendererClick(click.x, click.y, click.holdMs || 0));
        if (click.snapshotAfter) await saveCanvasSnapshot(app, click.snapshotAfter);
        if (click.maxSaturatedShare != null || click.maxDarkShare != null || click.minStageColors != null) {
          const stage = await snapshot(app);
          stageMetrics.push({
            label: click.snapshotAfter || `click-${stageMetrics.length}`,
            metrics: stage.metrics,
            maxSaturatedShare: click.maxSaturatedShare,
            maxDarkShare: click.maxDarkShare,
            minStageColors: click.minStageColors,
          });
        }
        await wait(click.waitMs || app.actionWaitMs || 350);
      }
    }
    if (app.waitForGuestPixelAfterClicks) {
      await waitForGuestPixel(app.waitForGuestPixelAfterClicks);
    }
    if (app.preGameKeys) {
      for (const key of app.preGameKeys) {
        actions.push(await rendererKeyTap(key.vk, key.holdMs || 80));
        if (key.snapshotAfter) await saveCanvasSnapshot(app, key.snapshotAfter);
        await wait(key.waitMs || app.keyWaitMs || 150);
      }
    }
    if (app.preGameText) {
      await rendererType(app.preGameText);
      actions.push({ kind: 'type', text: app.preGameText });
      if (app.preGameTextSnapshotAfter) await saveCanvasSnapshot(app, app.preGameTextSnapshotAfter);
      await wait(app.preGameTextWaitMs || 500);
    }
    if (app.waitForLogAfterClicks) {
      await waitForLogText(app.waitForLogAfterClicks, app.waitForLogTimeoutMs || 10000);
    }
    let keyBaseline = null;
    if (app.keys && app.minKeyDiff) {
      await wait(app.keyBaselineWaitMs || 250);
      keyBaseline = await captureDiffBaseline(app);
      await saveCanvasSnapshot(app, 'before-keys');
    }
    if (app.draw) {
      await rendererClick(39, 146);
      await rendererDrag([[140, 170], [160, 188], [180, 206], [200, 224], [220, 242], [240, 260]]);
      await wait(350);
    }
    if (app.typeText) {
      await rendererClick(120, 160);
      await rendererType(app.typeText);
      await wait(350);
    }
    const keyDiffs = [];
    if (app.keys) {
      for (let i = 0; i < app.keys.length; i++) {
        const key = app.keys[i];
        let singleKeyBaseline = null;
        if (key.minDiff) {
          if (key.baselineWaitMs) await wait(key.baselineWaitMs);
          singleKeyBaseline = await captureDiffBaseline(app, `__candidateKeyBaseline${i}`);
        }
        actions.push(await rendererKeyTap(key.vk, key.holdMs || 80));
        await wait(key.waitMs || app.keyWaitMs || 150);
        if (key.snapshotAfter) await saveCanvasSnapshot(app, key.snapshotAfter);
        if (singleKeyBaseline) {
          const singleKeyDiff = await diffSince(singleKeyBaseline, app);
          keyDiffs.push({
            index: i,
            vk: key.vk | 0,
            label: key.label || '',
            diff: singleKeyDiff.diff,
            minDiff: key.minDiff | 0,
          });
        }
      }
    }

    const after = await snapshot(app);
    await saveCanvasSnapshot(app, 'after');
    const diff = await diffSince(before, app);
    const keyDiff = keyBaseline ? await diffSince(keyBaseline, app) : null;
    const windowsText = after.windows.map(w => w.title).join(', ');
    const consoleText = consoleEventSummary(cdp.events).join('\n');
    const summary = JSON.stringify({
      windows: after.windows,
      canvas: after.canvas,
      metrics: after.metrics,
      diff: diff.diff,
      keyDiff: keyDiff && keyDiff.diff,
      keyDiffs,
      stageMetrics,
      actions,
      status: after.status,
      log: after.log.slice(-1000),
      console: consoleText.slice(-1000),
    });

    assert.strictEqual(after.selected, app.id, `${app.label}: select should stay on candidate`);
    assert.strictEqual(after.runningApps, 1, `${app.label}: should be the only running app: ${summary}`);
    assert(after.main && new RegExp(app.titlePattern, 'i').test(after.main.title || ''),
      `${app.label}: expected main window title ${app.titlePattern}: ${summary}`);
    if (app.minCanvasHeight) {
      assert(after.canvas && after.canvas.height >= app.minCanvasHeight,
        `${app.label}: browser canvas should be at least ${app.minCanvasHeight}px tall: ${summary}`);
    }
    if (app.minMainHeight) {
      assert(after.main && after.main.h >= app.minMainHeight,
        `${app.label}: main window should be at least ${app.minMainHeight}px tall: ${summary}`);
    }
    assert(after.metrics.colors >= app.minColors,
      `${app.label}: rendered content should have at least ${app.minColors} colors: ${summary}`);
    assert(after.metrics.topShare < 0.985,
      `${app.label}: rendered content should not be a near-solid window: ${summary}`);
    if (app.minSaturated) {
      assert(after.metrics.saturated >= app.minSaturated,
        `${app.label}: rendered content should include at least ${app.minSaturated} saturated pixels: ${summary}`);
    }
    assert(!/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED|CRASH/i.test(after.log + '\n' + consoleText),
      `${app.label}: browser log should not contain launch/runtime errors: ${summary}`);
    for (const forbidden of app.forbidDialogs || []) {
      assert(!new RegExp(forbidden, 'i').test(windowsText),
        `${app.label}: forbidden startup dialog remained visible: ${summary}`);
    }
    for (const expected of app.expectDialogs || []) {
      assert(new RegExp(expected, 'i').test(windowsText),
        `${app.label}: expected dialog did not appear: ${summary}`);
    }
    if ((app.commands || app.click || app.clicks || app.draw || app.typeText) && !app.expectDialogs) {
      assert(actions.length > 0,
        `${app.label}: expected at least one app-specific action: ${summary}`);
    }
    for (const action of actions) {
      if (action.kind === 'command') {
        assert(action.hwnd,
          `${app.label}: command ${action.command} should target a main window: ${summary}`);
      } else if (action.kind === 'click') {
        assert(!action.mapped || !action.mapped.outside,
          `${app.label}: click should land inside the rendered app surface: ${summary}`);
        assert((action.down || []).some(ev => ev.msg === 0x0201) && (action.up || []).some(ev => ev.msg === 0x0202),
          `${app.label}: click should enqueue WM_LBUTTONDOWN/UP: ${summary}`);
      } else if (action.kind === 'keytap') {
        assert(action.down && action.down.afterLen > action.down.beforeLen,
          `${app.label}: keydown ${action.vk} should enqueue input: ${summary}`);
        assert(action.up && action.up.afterLen > action.up.beforeLen,
          `${app.label}: keyup ${action.vk} should enqueue input: ${summary}`);
        assert(action.down.asyncDown === true && action.up.asyncDown === false,
          `${app.label}: key ${action.vk} should update async key state: ${summary}`);
      }
    }
    if (app.minDiff) {
      assert(diff.diff >= app.minDiff,
        `${app.label}: action should visibly change app content by >=${app.minDiff} sampled pixels: ${summary}`);
    }
    if (app.minKeyDiff) {
      assert(keyDiff && keyDiff.diff >= app.minKeyDiff,
        `${app.label}: gameplay keys should visibly change app content by >=${app.minKeyDiff} sampled pixels: ${summary}`);
    }
    for (const stage of stageMetrics) {
      const metrics = stage.metrics || {};
      const total = metrics.total || 1;
      if (stage.minStageColors != null) {
        assert(metrics.colors >= stage.minStageColors,
          `${app.label}: ${stage.label} should render at least ${stage.minStageColors} colors: ${summary}`);
      }
      if (stage.maxSaturatedShare != null) {
        assert((metrics.saturated || 0) / total <= stage.maxSaturatedShare,
          `${app.label}: ${stage.label} should not expose a saturated offscreen surface: ${summary}`);
      }
      if (stage.maxDarkShare != null) {
        assert((metrics.dark || 0) / total <= stage.maxDarkShare,
          `${app.label}: ${stage.label} should not expose a mostly dark offscreen surface: ${summary}`);
      }
    }
    for (const keyDiff of keyDiffs) {
      assert(keyDiff.diff >= keyDiff.minDiff,
        `${app.label}: gameplay key ${keyDiff.label || keyDiff.vk} should visibly change app content by >=${keyDiff.minDiff} sampled pixels: ${summary}`);
    }
    reports.push(`${app.id}: colors=${after.metrics.colors} top=${after.metrics.topShare.toFixed(3)} diff=${diff.diff} windows=${JSON.stringify(after.windows.map(w => w.title))}`);
    console.log('PASS ', reports[reports.length - 1]);
  }

  await evalExpr('stopAllApps(); 1');
  console.log('PASS  local candidate desktop browser smoke exercises rendered content and app actions');
  cleanup();
  process.exit(0);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
