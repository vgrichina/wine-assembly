#!/usr/bin/env node
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = process.cwd();
const PORT = 8765;
const DEBUG_PORT = 9223;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function argValue(name) {
  const flag = `--${name}`;
  const withEquals = `${flag}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith(withEquals)) return arg.slice(withEquals.length);
    if (arg === flag && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return '';
}

function intArgOrEnv(argName, envName, fallback) {
  return Math.max(0, parseInt(argValue(argName) || process.env[envName] || String(fallback), 10) || 0);
}

const ABOUT_WAIT_MS = intArgOrEnv('about-wait-ms', 'ABOUT_WAIT_MS', 1800);
const ABOUT_MANUAL_RUN_STEPS = Math.max(0, parseInt(process.env.ABOUT_MANUAL_RUN_STEPS || '0', 10) || 0);
const VIEWPORT_WIDTH = Math.max(0, parseInt(process.env.VIEWPORT_WIDTH || '0', 10) || 0);
const VIEWPORT_HEIGHT = Math.max(0, parseInt(process.env.VIEWPORT_HEIGHT || '0', 10) || 0);
const SCREENSHOT_PATH = argValue('screenshot') || process.env.SCREENSHOT_PATH || '';
const WINAMP_DOUBLE_SIZE = process.env.WINAMP_DOUBLE_SIZE === '1';
const WINAMP_PLAYLIST_LARGE = process.env.WINAMP_PLAYLIST_LARGE === '1';
const WINAMP_START_WAIT_MS = intArgOrEnv('winamp-start-wait-ms', 'WINAMP_START_WAIT_MS', 1800);
const WINAMP_DISMISS_WAIT_MS = intArgOrEnv('winamp-dismiss-wait-ms', 'WINAMP_DISMISS_WAIT_MS', 900);
const AUDIO_PLAYS = Math.max(1, parseInt(argValue('audio-plays') || process.env.AUDIO_PLAYS || '1', 10) || 1);
const AUDIO_WAIT_MS = intArgOrEnv('audio-wait-ms', 'AUDIO_WAIT_MS', 2500);
const POST_CMD = Math.max(0, parseInt(argValue('post-cmd') || process.env.POST_CMD || '0', 10) || 0);
const POST_WAIT_MS = intArgOrEnv('post-wait-ms', 'POST_WAIT_MS', 1800);
const POST_CLICK_WAIT_MS = intArgOrEnv('post-click-wait-ms', 'POST_CLICK_WAIT_MS', 700);
const POST_CLICKS = (argValue('post-clicks') || process.env.POST_CLICKS || '')
  .split(';')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const waitMatch = s.match(/^wait:(\d+)$/i);
    if (waitMatch) return { wait: parseInt(waitMatch[1], 10) || 0 };
    const dragMatch = s.match(/^drag:(-?\d+),(-?\d+),(-?\d+),(-?\d+)(?:,(\d+))?(?:,(\d+))?$/i);
    if (dragMatch) {
      return {
        drag: true,
        x1: Number(dragMatch[1]),
        y1: Number(dragMatch[2]),
        x2: Number(dragMatch[3]),
        y2: Number(dragMatch[4]),
        steps: Math.max(1, parseInt(dragMatch[5] || '8', 10) || 8),
        delay: Math.max(0, parseInt(dragMatch[6] || '25', 10) || 0),
      };
    }
    const [x, y, button] = s.split(',').map(p => p.trim());
    return { x: Number(x), y: Number(y), button: button || 'left' };
  })
  .filter(p => p.wait !== undefined || p.drag || (Number.isFinite(p.x) && Number.isFinite(p.y)));
const ABOUT_TAB = (argValue('about-tab') || process.env.ABOUT_TAB || '').toLowerCase();
const CREDIT_TAB_WAIT_MS = intArgOrEnv('credit-tab-wait-ms', 'CREDIT_TAB_WAIT_MS', 1500);
const RETURN_TAB_WAIT_MS = intArgOrEnv('return-tab-wait-ms', 'RETURN_TAB_WAIT_MS', 1500);
const TRACE_TREE_GDI = process.env.TRACE_TREE_GDI === '1' || process.argv.includes('--trace-tree-gdi');
const DUMP_CONSOLE = process.env.DUMP_CONSOLE === '1' || process.argv.includes('--dump-console');
const PROGRESS = process.env.PROGRESS === '1' || process.argv.includes('--progress');
const TRACE_HOST_NAMES = (argValue('trace-host') || process.env.TRACE_HOST || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TRACE_API_NAMES = (argValue('trace-api') || process.env.TRACE_API || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ABOUT_TAB_POINTS = {
  winamp: { x: 63, y: 40 },
  credits: { x: 178, y: 40 },
  shortcuts: { x: 293, y: 40 },
  history: { x: 403, y: 40 },
  'version-history': { x: 403, y: 40 },
};

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function progress(msg) {
  if (PROGRESS) console.error(`[profile] ${msg}`);
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
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const hi = buf.readUInt32BE(2);
        if (hi) throw new Error('large websocket frame');
        len = buf.readUInt32BE(6); off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if ((b0 & 0x0f) === 1) {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else {
          events.push(msg);
        }
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
      out.push({
        type: p.type || 'log',
        text: (p.args || []).map(a => {
          if (Object.prototype.hasOwnProperty.call(a, 'value')) return String(a.value);
          return a.description || a.unserializableValue || '';
        }).join(' '),
      });
    } else if (ev.method === 'Runtime.exceptionThrown') {
      const p = ev.params || {};
      const d = p.exceptionDetails || {};
      out.push({
        type: 'exception',
        text: d.text || (d.exception && d.exception.description) || '',
      });
    } else if (ev.method === 'Log.entryAdded') {
      const e = (ev.params && ev.params.entry) || {};
      out.push({ type: e.level || 'log', text: e.text || '' });
    }
  }
  return out.filter(e => e.text).slice(-240);
}

async function main() {
  const headless = process.env.HEADLESS !== '0';
  const mode = argValue('mode') || process.env.MODE ||
    (process.argv.includes('--audio') ? 'audio' :
     process.argv.includes('--about-menu') ? 'about-menu' :
     POST_CMD ? 'post-cmd' : 'credits');
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
  });
  progress('started local HTTP server');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-chrome-profile-'));
  const chromeArgs = [
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userData}`,
    `http://127.0.0.1:${PORT}/index.html?profile=${Date.now()}`,
  ];
  if (VIEWPORT_WIDTH && VIEWPORT_HEIGHT) chromeArgs.splice(3, 0, `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`);
  if (headless) chromeArgs.unshift('--headless=new');
  const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  progress(`${headless ? 'headless' : 'visible'} Chrome spawned`);
  let chromeErr = '';
  let serverErr = '';
  let chromeExit = null;
  let serverExit = null;
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });
  server.stderr.on('data', d => { serverErr += d.toString(); });
  chrome.on('error', e => { chromeErr += `\n[spawn error] ${e.message}`; });
  server.on('error', e => { serverErr += `\n[spawn error] ${e.message}`; });
  chrome.on('exit', (code, signal) => { chromeExit = { code, signal }; });
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });
  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { server.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  let page;
  for (let i = 0; i < 80; i++) {
    try {
      const pages = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      page = pages.find(p =>
        p.type === 'page' &&
        String(p.url || '').startsWith(`http://127.0.0.1:${PORT}/index.html`));
      if (page) break;
    } catch (_) {}
    await wait(100);
  }
  if (!page) {
    throw new Error(
      'Chrome page did not appear\n' +
      'chrome exit: ' + JSON.stringify(chromeExit) + '\n' +
      'server exit: ' + JSON.stringify(serverExit) + '\n' +
      'chrome stderr:\n' + chromeErr.slice(-4000) + '\n' +
      'server stderr:\n' + serverErr.slice(-1000));
  }
  progress(`CDP page found: ${page.url || page.id || ''}`);

  const cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  progress('CDP websocket connected');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  progress('CDP domains enabled');
  if (DUMP_CONSOLE) {
    try { await cdp.send('Log.enable'); } catch (_) {}
  }
  if (VIEWPORT_WIDTH && VIEWPORT_HEIGHT) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async function saveScreenshot() {
    if (!SCREENSHOT_PATH) return;
    try {
      await evalExpr(`(() => {
        const app = runningApps && runningApps[0];
        const wine = app && app.wine;
        const r = window.sharedRenderer || (wine && wine.renderer);
        if (r && r.repaint) r.repaint();
        return 1;
      })()`, 1000);
      await wait(50);
    } catch (_) {}
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (shot && shot.data) fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
  }

  async function evalExpr(expression, timeout = 5000, userGesture = false) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout,
          userGesture,
        });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result && r.result.value;
      } catch (e) {
        if (!/Execution context was destroyed/.test(String(e && e.message)) || attempt === 2) throw e;
        await wait(250);
      }
    }
  }

  async function clickClient(x, y, button = 'left') {
    const buttons = button === 'right' ? 2 : 1;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
    });
  }

  async function clickElement(selector) {
    const p = await evalExpr(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!p) throw new Error('element not found: ' + selector);
    await clickClient(p.x, p.y);
  }

  async function clickCanvasPoint(x, y, button = 'left') {
    const p = await evalExpr(`(() => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      return {
        x: r.left + (${x} / Math.max(1, c.width)) * r.width,
        y: r.top + (${y} / Math.max(1, c.height)) * r.height,
      };
    })()`);
    await clickClient(p.x, p.y, button);
  }

  async function canvasClientPoint(x, y) {
    return await evalExpr(`(() => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      return {
        x: r.left + (${x} / Math.max(1, c.width)) * r.width,
        y: r.top + (${y} / Math.max(1, c.height)) * r.height,
      };
    })()`);
  }

  async function dragCanvasPoint(x1, y1, x2, y2, steps = 8, delay = 25) {
    const a = await canvasClientPoint(x1, y1);
    const b = await canvasClientPoint(x2, y2);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: a.x,
      y: a.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      if (delay) await wait(delay);
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: b.x,
      y: b.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  await evalExpr(`new Promise(r => {
    if (document.readyState === 'complete') r(1);
    else window.addEventListener('load', () => r(1), { once: true });
  })`);
  progress('document loaded');
  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (typeof Win98Renderer !== 'undefined' &&
          typeof ThreadManager !== 'undefined' &&
          typeof launchApp === 'function') resolve(1);
      else if (performance.now() - started > 8000) reject(new Error('app globals not ready'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 9000);
  progress('app globals ready');

  await evalExpr(`(() => {
    window.__waProfile = {
      t0: performance.now(),
      counters: Object.create(null),
      samples: Object.create(null),
      marks: [],
    };
    const p = window.__waProfile;
    const add = (name, dt, data) => {
      const c = p.counters[name] || (p.counters[name] = { count: 0, total: 0, max: 0 });
      c.count++; c.total += dt; if (dt > c.max) c.max = dt;
      if (!p.samples[name]) p.samples[name] = [];
      if (p.samples[name].length < 12 || dt > p.samples[name][0].dt) {
        p.samples[name].push({ dt, at: performance.now() - p.t0, data: data || null });
        p.samples[name].sort((a, b) => b.dt - a.dt);
        p.samples[name].length = Math.min(p.samples[name].length, 12);
      }
    };
    p.add = add;
    const wrap = (proto, key, name) => {
      const orig = proto && proto[key];
      if (!orig || orig.__profiled) return;
      proto[key] = function(...args) {
        const t = performance.now();
        let ret;
        try {
          ret = orig.apply(this, args);
          return ret;
        } finally {
          add(name, performance.now() - t, { arg0: args[0], ret: ret || null });
        }
      };
      proto[key].__profiled = true;
    };
    window.__waInputTrace = [];
    const traceInput = (proto, key) => {
      const orig = proto && proto[key];
      if (!orig || orig.__inputTraced) return;
      proto[key] = function(...args) {
        const r = this;
        const beforeQ = r && r.inputQueue ? r.inputQueue.length : -1;
        const beforeModal = r && r._modalDialogHwnd ? (r._modalDialogHwnd() >>> 0) : 0;
        const hit = (() => {
          if (!r || !r.windows) return null;
          const x = args[0] | 0, y = args[1] | 0;
          const wins = Object.values(r.windows)
            .filter(w => w && w.visible && !w.isChild && x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          const w = wins[0];
          return w ? { hwnd: w.hwnd >>> 0, title: w.title || '', zOrder: w.zOrder || 0 } : null;
        })();
        let ret;
        try {
          ret = orig.apply(this, args);
          return ret;
        } finally {
          const afterQ = r && r.inputQueue ? r.inputQueue.length : -1;
          const last = afterQ > beforeQ && r.inputQueue ? r.inputQueue[r.inputQueue.length - 1] : null;
          window.__waInputTrace.push({
            name: key,
            args: args.slice(0, 4),
            beforeQ,
            afterQ,
            beforeModal,
            afterModal: r && r._modalDialogHwnd ? (r._modalDialogHwnd() >>> 0) : 0,
            hit,
            queued: last ? { hwnd: last.hwnd >>> 0, msg: last.msg >>> 0, wParam: last.wParam >>> 0, lParam: last.lParam >>> 0 } : null,
            at: +(performance.now() - window.__waProfile.t0).toFixed(1),
          });
          if (window.__waInputTrace.length > 120) window.__waInputTrace.shift();
        }
      };
      proto[key].__inputTraced = true;
    };
    wrap(Win98Renderer.prototype, 'repaint', 'renderer.repaint');
    wrap(Win98Renderer.prototype, 'flushRepaint', 'renderer.flushRepaint');
    wrap(Win98Renderer.prototype, 'handleMouseDown', 'input.mouseDown');
    wrap(Win98Renderer.prototype, 'handleMouseUp', 'input.mouseUp');
    traceInput(Win98Renderer.prototype, 'handleMouseDown');
    traceInput(Win98Renderer.prototype, 'handleMouseUp');
    wrap(ThreadManager.prototype, 'checkMainYield', 'thread.checkMainYield');
    wrap(ThreadManager.prototype, 'runSlice', 'thread.runSlice');
  })()`);
  progress('profiling hooks installed');

  await evalExpr(`(() => {
    window.__waAudioProbe = { starts: 0, startTimes: [], peaks: [], resumes: 0, resumeStates: [] };
    const srcProto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
    if (srcProto && srcProto.start && !srcProto.start.__waProfiled) {
      const orig = srcProto.start;
      srcProto.start = function(...args) {
        window.__waAudioProbe.starts++;
        window.__waAudioProbe.startTimes.push(args[0] == null ? null : +args[0]);
        try {
          const buf = this.buffer;
          const data = buf && buf.numberOfChannels ? buf.getChannelData(0) : null;
          let peak = 0;
          if (data) {
            const stride = Math.max(1, Math.floor(data.length / 512));
            for (let i = 0; i < data.length; i += stride) {
              const v = Math.abs(data[i]);
              if (v > peak) peak = v;
            }
          }
          window.__waAudioProbe.peaks.push(+peak.toFixed(5));
        } catch (_) {
          window.__waAudioProbe.peaks.push(null);
        }
        return orig.apply(this, args);
      };
      srcProto.start.__waProfiled = true;
    }
    const acProto = window.AudioContext && window.AudioContext.prototype;
    if (acProto && acProto.resume && !acProto.resume.__waProfiled) {
      const orig = acProto.resume;
      acProto.resume = function(...args) {
        window.__waAudioProbe.resumes++;
        window.__waAudioProbe.resumeStates.push(this.state);
        return orig.apply(this, args);
      };
      acProto.resume.__waProfiled = true;
    }
    return 1;
  })()`);
  progress('audio probe installed');

  if (TRACE_TREE_GDI) {
    await evalExpr(`(() => {
      if (window.__waTraceHostImportsInstalled) return 1;
      const origCreateHostImports = window.createHostImports;
      window.__waTreeGdiCalls = [];
      window.createHostImports = function(ctx) {
        const base = origCreateHostImports(ctx);
        const host = base && base.host;
        const wrap = (name) => {
          const orig = host && host[name];
          if (!orig) return;
          host[name] = function(...args) {
            const hdc = args[0] >>> 0;
            const hwnd = (hdc >= 0x50000 && hdc < 0x200000)
              ? ((hdc >= 0xD0000 ? hdc - 0xC0000 : hdc - 0x40000) >>> 0)
              : 0;
            let parent = 0, top = 0, cx = 0, cy = 0, tx = 0, ty = 0;
            const e = ctx && ctx.exports;
            try { parent = e && e.wnd_get_parent ? (e.wnd_get_parent(hwnd) >>> 0) : 0; } catch (_) {}
            try { top = e && e.wnd_top_level ? (e.wnd_top_level(hwnd) >>> 0) : 0; } catch (_) {}
            try { cx = e && e.wnd_client_screen_x ? (e.wnd_client_screen_x(hwnd) | 0) : 0; } catch (_) {}
            try { cy = e && e.wnd_client_screen_y ? (e.wnd_client_screen_y(hwnd) | 0) : 0; } catch (_) {}
            try { tx = e && e.wnd_window_screen_x ? (e.wnd_window_screen_x(top) | 0) : 0; } catch (_) {}
            try { ty = e && e.wnd_window_screen_y ? (e.wnd_window_screen_y(top) | 0) : 0; } catch (_) {}
            const ret = orig.apply(this, args);
            if (hwnd && (name === 'gdi_fill_rect' || name === 'gdi_text_out' || name === 'gdi_draw_edge')) {
              window.__waTreeGdiCalls.push({
                name,
                hdc,
                hwnd,
                parent,
                top,
                ox: cx - tx,
                oy: cy - ty,
                args: args.slice(1, 6),
                ret,
                at: Math.round(performance.now()),
              });
              if (window.__waTreeGdiCalls.length > 4000) window.__waTreeGdiCalls.splice(0, 1000);
            }
            return ret;
          };
        };
        wrap('gdi_fill_rect');
        wrap('gdi_text_out');
        wrap('gdi_draw_edge');
        return base;
      };
      window.__waTraceHostImportsInstalled = true;
      return 1;
    })()`);
  }

  if (TRACE_HOST_NAMES.length || TRACE_API_NAMES.length) {
    await evalExpr(`(() => {
      window.__waTraceHostNames = new Set(${JSON.stringify(TRACE_HOST_NAMES)});
      window.__waTraceApiNames = new Set(${JSON.stringify(TRACE_API_NAMES)});
      return 1;
    })()`);
    progress('trace filters installed');
  }

  await evalExpr(`(() => {
    if (${WINAMP_DOUBLE_SIZE || WINAMP_PLAYLIST_LARGE ? 'true' : 'false'}) {
      localStorage.setItem('ini:winamp.ini', JSON.stringify({
        sections: {
          Winamp: {
            mb_open: '0',
            check_ft_startup: '0',
            newverchk: '0',
            newverchk2: '0',
            dsize: ${WINAMP_DOUBLE_SIZE ? "'1'" : "'0'"},
            eqdsize: ${WINAMP_DOUBLE_SIZE ? "'1'" : "'0'"},
            pe_width: ${WINAMP_PLAYLIST_LARGE ? "'550'" : "'275'"},
            pe_height: ${WINAMP_PLAYLIST_LARGE ? "'468'" : "'232'"},
          },
          WinampReg: {
            NeedReg: '0',
            RegDataLen: '0',
          },
        },
      }));
    }
    document.getElementById('app-select').value = 'winamp';
    return launchApp();
  })()`, 20000, true);
  progress('launchApp(winamp) requested');
  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (runningApps[0] && runningApps[0].wine && runningApps[0].wine.instance) resolve(1);
      else if (performance.now() - started > 15000) reject(new Error('Winamp did not launch'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 16000);
  progress('Winamp instance ready');
  await wait(WINAMP_START_WAIT_MS);
  await evalExpr(`(() => {
    const app = runningApps[0];
    app.wine.instance.exports.post_message_q(app.wine.instance.exports.get_main_hwnd(), 0x0111, 2, 0);
    return 1;
  })()`);
  progress('dismissed initial Winamp modal if present');
  await wait(WINAMP_DISMISS_WAIT_MS);

  if (mode === 'audio') {
    const playSnapshots = [];
    for (let i = 0; i < AUDIO_PLAYS; i++) {
      await clickCanvasPoint(66, 129);
      await wait(AUDIO_WAIT_MS);
      playSnapshots.push(await evalExpr(`(() => ({
        play: ${i + 1},
        starts: window.__waAudioProbe && window.__waAudioProbe.starts,
        currentTime: (() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const shared = wine && wine._sharedAudio;
          const voices = shared && shared.voices;
          const ac = (voices && voices._ac) || (wine && wine._audioCtx);
          return ac ? +ac.currentTime.toFixed(3) : null;
        })(),
      }))()`));
    }
    const result = await evalExpr(`(() => {
      const app = runningApps[0];
      const wine = app && app.wine;
      const shared = wine && wine._sharedAudio;
      const voices = shared && shared.voices;
      const ac = (voices && voices._ac) || (wine && wine._audioCtx);
      const voiceMap = voices && voices._map ? Object.values(voices._map).map(v => ({
        id: v.id,
        mode: v.mode,
        bytesWritten: v.bytesWritten,
        sources: v.sources ? v.sources.size : 0,
        timers: v.timers ? v.timers.size : 0,
        nextTime: Number.isFinite(v.nextTime) ? +v.nextTime.toFixed(3) : null,
        streamStartTime: Number.isFinite(v.streamStartTime) ? +v.streamStartTime.toFixed(3) : null,
      })) : [];
      return {
        audioProbe: window.__waAudioProbe,
        audioContext: ac ? {
          state: ac.state,
          currentTime: +ac.currentTime.toFixed(3),
          sampleRate: ac.sampleRate,
        } : null,
        sharedAudio: shared ? {
          hotUntilMs: shared.waveOutHotUntilMs || 0,
          pendingWaveDoneCount: shared.pendingWaveDoneCount || 0,
          openHandles: shared.waveOutOpenHandles && shared.waveOutOpenHandles.size,
          scheduledHeaders: shared.waveScheduledHeaders && shared.waveScheduledHeaders.size,
        } : null,
        playSnapshots: ${JSON.stringify(playSnapshots)},
        voices: voiceMap,
        windows: Object.values((window.sharedRenderer || wine.renderer).windows)
          .filter(w => w && w.visible)
          .map(w => ({ hwnd: w.hwnd, title: w.title || '', x: w.x, y: w.y, w: w.w, h: w.h })),
      };
    })()`);
    if (DUMP_CONSOLE) result.consoleEvents = consoleEventSummary(cdp.events);
    console.log(JSON.stringify(result, null, 2));
    await saveScreenshot();
    cdp.close();
    cleanup();
    return;
  }

  if (mode === 'post-cmd') {
    await evalExpr(`(() => {
      const app = runningApps[0];
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      e.post_message_q(e.get_main_hwnd(), 0x0111, ${POST_CMD}, 0);
      return 1;
    })()`);
    progress(`posted WM_COMMAND ${POST_CMD}`);
    await wait(POST_WAIT_MS);
    const postClickSnapshots = [];
    for (const p of POST_CLICKS) {
      if (p.wait !== undefined) {
        progress(`wait ${p.wait}ms`);
        await wait(p.wait);
        postClickSnapshots.push(await evalExpr(`(() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const shared = wine && wine._sharedAudio;
          const voices = shared && shared.voices;
          const ac = (voices && voices._ac) || (wine && wine._audioCtx);
          return {
            action: 'wait',
            wait: ${p.wait},
            starts: window.__waAudioProbe && window.__waAudioProbe.starts,
            currentTime: ac ? +ac.currentTime.toFixed(3) : null,
            openHandles: shared && shared.waveOutOpenHandles && shared.waveOutOpenHandles.size,
            pendingWaveDoneCount: shared && (shared.pendingWaveDoneCount || 0),
            voiceCount: voices && voices._map ? Object.keys(voices._map).length : 0,
          };
        })()`));
        continue;
      }
      if (p.drag) {
        progress(`drag canvas ${p.x1},${p.y1} -> ${p.x2},${p.y2}`);
        await dragCanvasPoint(p.x1, p.y1, p.x2, p.y2, p.steps, p.delay);
        await wait(POST_CLICK_WAIT_MS);
        postClickSnapshots.push(await evalExpr(`(() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const shared = wine && wine._sharedAudio;
          const voices = shared && shared.voices;
          const ac = (voices && voices._ac) || (wine && wine._audioCtx);
          const r = window.sharedRenderer || (wine && wine.renderer);
          const main = r && Object.values(r.windows || {}).find(w => w && w.visible && w.region && (w.w | 0) === 275) ||
            (r && Object.values(r.windows || {}).find(w => w && w.visible && /Winamp/.test(w.title || '') && (w.w | 0) === 275));
          return {
            action: 'drag',
            x1: ${p.x1},
            y1: ${p.y1},
            x2: ${p.x2},
            y2: ${p.y2},
            starts: window.__waAudioProbe && window.__waAudioProbe.starts,
            currentTime: ac ? +ac.currentTime.toFixed(3) : null,
            mainWindow: main ? { hwnd: main.hwnd >>> 0, x: main.x | 0, y: main.y | 0, client: main.clientRect || null, region: !!main.region } : null,
            openHandles: shared && shared.waveOutOpenHandles && shared.waveOutOpenHandles.size,
            pendingWaveDoneCount: shared && (shared.pendingWaveDoneCount || 0),
            voiceCount: voices && voices._map ? Object.keys(voices._map).length : 0,
          };
        })()`));
        continue;
      }
      progress(`click canvas ${p.x},${p.y}`);
      await clickCanvasPoint(p.x, p.y, p.button);
      await wait(POST_CLICK_WAIT_MS);
      postClickSnapshots.push(await evalExpr(`(() => {
        const app = runningApps[0];
        const wine = app && app.wine;
        const shared = wine && wine._sharedAudio;
        const voices = shared && shared.voices;
        const ac = (voices && voices._ac) || (wine && wine._audioCtx);
        return {
          action: 'click',
          x: ${p.x},
          y: ${p.y},
          button: ${JSON.stringify(p.button)},
          starts: window.__waAudioProbe && window.__waAudioProbe.starts,
          currentTime: ac ? +ac.currentTime.toFixed(3) : null,
          openHandles: shared && shared.waveOutOpenHandles && shared.waveOutOpenHandles.size,
          pendingWaveDoneCount: shared && (shared.pendingWaveDoneCount || 0),
          voiceCount: voices && voices._map ? Object.keys(voices._map).length : 0,
        };
      })()`));
    }
    progress('collecting post-cmd result');
    const result = await evalExpr(`(() => {
      const app = runningApps[0];
      const wine = app && app.wine;
      const e = wine && wine.instance && wine.instance.exports;
	      const r = window.sharedRenderer || (wine && wine.renderer);
	      const sampleCanvas = (canvas) => {
	        if (!canvas || !canvas.getContext) return null;
	        const w = canvas.width | 0;
	        const h = canvas.height | 0;
	        if (!w || !h) return null;
	        const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
	        const colors = new Set();
	        let ink = 0;
	        for (let i = 0; i < data.length; i += 16) {
	          const a = data[i + 3];
	          if (!a) continue;
          const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
	          colors.add(rgb);
	          if (rgb !== 0xc0c0c0 && rgb !== 0x000000 && rgb !== 0xffffff) ink++;
	        }
	        return { w, h, sampledColors: colors.size, sampledInk: ink };
	      };
      const childrenOf = (hwnd) => {
        if (!e || !e.wnd_next_child_slot || !e.wnd_slot_hwnd) return [];
        const dv = wine && wine.memory ? new DataView(wine.memory.buffer) : null;
        const imageBase = e && e.get_image_base ? (e.get_image_base() >>> 0) : 0;
        const guestBase = e && e.get_guest_base ? (e.get_guest_base() >>> 0) : 0x12000;
        const g2w = (p) => ((p >>> 0) - imageBase + guestBase) >>> 0;
        const readStr = (guestPtr, max = 80) => {
          if (!dv || !guestPtr || guestPtr === 0xffffffff || !imageBase) return '';
          const wa = g2w(guestPtr);
          if (wa >= dv.byteLength) return '';
          let s = '';
          for (let i = 0; i < max && wa + i < dv.byteLength; i++) {
            const c = dv.getUint8(wa + i);
            if (!c) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const readControlText = (fn, hwnd, idx) => {
          if (!e || !e.guest_alloc || !e[fn]) return '';
          const buf = e.guest_alloc(256) >>> 0;
          const len = fn === 'listbox_get_item_text'
            ? (e[fn](hwnd, idx, buf, 256) | 0)
            : (e[fn](hwnd, buf, 256) | 0);
          return len > 0 ? readStr(buf, Math.min(255, len + 1)) : '';
        };
        const listboxInfo = (hwnd) => {
          if (!e || !e.listbox_get_count) return null;
          const count = e.listbox_get_count(hwnd) | 0;
          const curSel = e.listbox_get_cur_sel ? (e.listbox_get_cur_sel(hwnd) | 0) : -1;
          const items = [];
          for (let i = 0; i < Math.min(8, count); i++) {
            items.push(readControlText('listbox_get_item_text', hwnd, i));
          }
          return { count, curSel, items };
        };
        const comboboxInfo = (hwnd) => {
          if (!e || !e.combobox_get_cur_sel) return null;
          return {
            curSel: e.combobox_get_cur_sel(hwnd) | 0,
            text: readControlText('combobox_get_text', hwnd, 0),
            listHwnd: e.combobox_get_lb_hwnd ? (e.combobox_get_lb_hwnd(hwnd) >>> 0) : 0,
          };
        };
        const treeItems = () => {
          if (!dv) return [];
          const out = [];
          for (let i = 0; i < 32; i++) {
            const base = 0x9000 + i * 32;
            const handle = dv.getUint32(base, true) >>> 0;
            if (!handle) continue;
            const textPtr = dv.getUint32(base + 28, true) >>> 0;
            out.push({
              slot: i,
              handle,
              parent: dv.getUint32(base + 4, true) >>> 0,
              firstChild: dv.getUint32(base + 8, true) >>> 0,
              next: dv.getUint32(base + 12, true) >>> 0,
              state: dv.getUint32(base + 20, true) >>> 0,
              lParam: dv.getUint32(base + 24, true) >>> 0,
              textPtr,
              text: readStr(textPtr),
            });
          }
          return out;
        };
        const out = [];
        let s = 0;
        while ((s = e.wnd_next_child_slot(hwnd, s)) !== -1) {
          const ch = e.wnd_slot_hwnd(s) >>> 0;
          const xy = e.ctrl_get_xy ? (e.ctrl_get_xy(ch) >>> 0) : 0;
          const wh = e.ctrl_get_wh ? (e.ctrl_get_wh(ch) >>> 0) : 0;
          const cls = e.ctrl_get_class ? (e.ctrl_get_class(ch) | 0) : -1;
          out.push({
            hwnd: ch,
            id: e.ctrl_get_id ? (e.ctrl_get_id(ch) | 0) : -1,
            cls,
            style: e.wnd_get_style_export ? (e.wnd_get_style_export(ch) >>> 0) : 0,
            x: xy & 0xffff,
            y: xy >>> 16,
            w: wh & 0xffff,
            h: wh >>> 16,
            treeItems: cls === 8 ? treeItems() : undefined,
            listbox: cls === 4 ? listboxInfo(ch) : undefined,
            combobox: cls === 5 ? comboboxInfo(ch) : undefined,
          });
          s++;
        }
        return out;
      };
	      return {
	        postCmd: ${POST_CMD},
            audioProbe: window.__waAudioProbe,
            audioContext: (() => {
              const shared = wine && wine._sharedAudio;
              const voices = shared && shared.voices;
              const ac = (voices && voices._ac) || (wine && wine._audioCtx);
              return ac ? {
                state: ac.state,
                currentTime: +ac.currentTime.toFixed(3),
                sampleRate: ac.sampleRate,
              } : null;
            })(),
            sharedAudio: (() => {
              const shared = wine && wine._sharedAudio;
              return shared ? {
                hotUntilMs: shared.waveOutHotUntilMs || 0,
                pendingWaveDoneCount: shared.pendingWaveDoneCount || 0,
                openHandles: shared.waveOutOpenHandles && shared.waveOutOpenHandles.size,
                scheduledHeaders: shared.waveScheduledHeaders && shared.waveScheduledHeaders.size,
              } : null;
            })(),
            postClickSnapshots: ${JSON.stringify(postClickSnapshots)},
            voices: (() => {
              const shared = wine && wine._sharedAudio;
              const voices = shared && shared.voices;
              return voices && voices._map ? Object.values(voices._map).map(v => ({
                id: v.id,
                mode: v.mode,
                bytesWritten: v.bytesWritten,
                sources: v.sources ? v.sources.size : 0,
                timers: v.timers ? v.timers.size : 0,
                nextTime: Number.isFinite(v.nextTime) ? +v.nextTime.toFixed(3) : null,
                streamStartTime: Number.isFinite(v.streamStartTime) ? +v.streamStartTime.toFixed(3) : null,
              })) : [];
            })(),
            winampVisGlobals: {
              pluginPath: readStr(0x4595b8, 260),
              pluginDir: readStr(0x45c880, 260),
              pluginFile: readStr(0x45cd00, 260),
            },
	        visibleWindows: Object.values((r && r.windows) || {})
	          .filter(w => w && w.visible)
	          .map(w => ({
	            hwnd: w.hwnd >>> 0,
	            title: w.title || '',
	            x: w.x, y: w.y, w: w.w, h: w.h,
                client: w.clientRect || null,
                region: !!w.region,
	            isDialog: !!w.isDialog,
            dlgKey: e && e.dlg_get_key && w.isDialog ? (e.dlg_get_key(w.hwnd >>> 0) >>> 0) : 0,
            back: sampleCanvas(w._backCanvas),
            children: w.isDialog ? childrenOf(w.hwnd >>> 0) : [],
          })),
          inputQueue: ((r && r.inputQueue) || []).slice(0, 20).map(ev => ({
            hwnd: ev.hwnd >>> 0,
            msg: ev.msg >>> 0,
            wParam: ev.wParam >>> 0,
            lParam: ev.lParam >>> 0,
          })),
          threads: wine && wine.threadManager ? Array.from(wine.threadManager.threads.entries()).map(([handle, t]) => ({
            handle: handle >>> 0,
            tid: t.tid,
            state: t.state,
            eip: t.instance && t.instance.exports && t.instance.exports.get_eip ? (t.instance.exports.get_eip() >>> 0) : 0,
            yieldReason: t.instance && t.instance.exports && t.instance.exports.get_yield_reason ? (t.instance.exports.get_yield_reason() >>> 0) : 0,
            hwndBase: t.instance && t.instance.exports && t.instance.exports.get_hwnd_base ? (t.instance.exports.get_hwnd_base() >>> 0) : 0,
          })) : [],
          menuStates: (() => {
            const states = [];
            const seen = new Set();
            const wins = Object.values((r && r.windows) || {});
            const readText = (memory, ptr, len) => {
              if (!memory || !memory.buffer || !ptr || len <= 0) return '';
              const bytes = new Uint8Array(memory.buffer);
              let s = '';
              ptr = ptr >>> 0;
              if (ptr >= bytes.length) return '';
              len = Math.min(256, len | 0);
              const end = Math.min(bytes.length, ptr + len);
              for (let p = ptr >>> 0; p < end; p++) s += String.fromCharCode(bytes[p]);
              return s;
            };
            for (const w of Object.values((r && r.windows) || {})) {
              const inst = w && w.wasm;
              if (!inst || seen.has(inst)) continue;
              seen.add(inst);
              const ex = inst.exports || {};
              const hwnd = ex.menu_open_hwnd ? (ex.menu_open_hwnd() >>> 0) : 0;
              const top = ex.menu_open_top ? (ex.menu_open_top() | 0) : -99;
              const hover = ex.menu_open_hover ? (ex.menu_open_hover() | 0) : -99;
              const owner = wins.find(ww => ww && ww.wasm === inst);
              const memory = (owner && owner.wasmMemory) || ex.memory || (wine && wine.memory);
              const labels = [];
              const subLabels = [];
              const count = hwnd && top >= 0 && ex.menu_child_count ? (ex.menu_child_count(hwnd, top) | 0) : 0;
              for (let i = 0; i < Math.min(count, 12); i++) {
                const ptr = ex.menu_child_label_ptr ? (ex.menu_child_label_ptr(hwnd, top, i) >>> 0) : 0;
                const len = ex.menu_child_label_len ? (ex.menu_child_label_len(hwnd, top, i) | 0) : 0;
                labels.push(readText(memory, ptr, len));
              }
              const subCount = hwnd && top >= 0 && hover >= 0 && ex.menu_child_sub_count
                ? (ex.menu_child_sub_count(hwnd, top, hover) | 0)
                : 0;
              for (let i = 0; i < Math.min(subCount, 12); i++) {
                const ptr = ex.menu_subchild_label_ptr ? (ex.menu_subchild_label_ptr(hwnd, top, hover, i) >>> 0) : 0;
                const len = ex.menu_subchild_label_len ? (ex.menu_subchild_label_len(hwnd, top, hover, i) | 0) : 0;
                subLabels.push(readText(memory, ptr, len));
              }
              states.push({
                openHwnd: hwnd,
                top,
                hover,
                x: ex.menu_open_x ? (ex.menu_open_x() | 0) : -99,
                y: ex.menu_open_y ? (ex.menu_open_y() | 0) : -99,
                labels,
                subLabels,
                windows: wins.filter(ww => ww && ww.wasm === inst).map(ww => ww.hwnd >>> 0),
              });
            }
            return states;
          })(),
          treeGdiCalls: (window.__waTreeGdiCalls || []).slice(-400),
          inputTrace: (window.__waInputTrace || []).slice(-40),
        };
      })()`);
    if (DUMP_CONSOLE) result.consoleEvents = consoleEventSummary(cdp.events);
    console.log(JSON.stringify(result, null, 2));
    await saveScreenshot();
    cdp.close();
    cleanup();
    return;
  }

  if (mode === 'about-menu') {
    await clickCanvasPoint(35, 36, 'right');
    await wait(600);
    const menuState = await evalExpr(`(() => {
      const app = runningApps[0];
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      const hwnd = e && e.menu_open_hwnd ? (e.menu_open_hwnd() >>> 0) : 0;
      const top = e && e.menu_open_top ? (e.menu_open_top() | 0) : -1;
      const count = hwnd && e.menu_child_count ? (e.menu_child_count(hwnd, top) | 0) : 0;
      const labels = [];
      for (let i = 0; i < Math.min(count, 6); i++) {
        const ptr = e.menu_child_label_ptr ? (e.menu_child_label_ptr(hwnd, top, i) >>> 0) : 0;
        const len = e.menu_child_label_len ? (e.menu_child_label_len(hwnd, top, i) | 0) : 0;
        if (ptr && len > 0) {
          const bytes = new Uint8Array(app.wine.memory.buffer, ptr, len);
          labels.push(String.fromCharCode(...bytes));
        } else {
          labels.push('');
        }
      }
      return { hwnd, top, count, labels };
    })()`);
    await clickCanvasPoint(50, 46);
    await wait(ABOUT_TAB && ABOUT_TAB !== 'winamp' ? 300 : ABOUT_WAIT_MS);
    const tabPoint = ABOUT_TAB_POINTS[ABOUT_TAB];
    if (tabPoint && ABOUT_TAB !== 'winamp') {
      const about = await evalExpr(`(() => {
        const r = window.sharedRenderer || runningApps[0].wine.renderer;
        const w = Object.values(r.windows).find(w => w && w.visible && w.title === 'About Winamp');
        return w ? { x: w.x | 0, y: w.y | 0 } : null;
      })()`);
      if (about) await clickCanvasPoint(about.x + tabPoint.x, about.y + tabPoint.y);
      await wait(ABOUT_WAIT_MS);
    }
    const result = await evalExpr(`(() => {
      const r = window.sharedRenderer || runningApps[0].wine.renderer;
      const sampleCanvas = (canvas) => {
        if (!canvas || !canvas.getContext) return null;
        const w = canvas.width | 0;
        const h = canvas.height | 0;
        if (!w || !h) return null;
        const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
        const colors = new Set();
        let ink = 0;
        for (let i = 0; i < data.length; i += 16) {
          const a = data[i + 3];
          if (!a) continue;
          const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          colors.add(rgb);
          if (rgb !== 0xc0c0c0 && rgb !== 0x000000 && rgb !== 0xffffff) ink++;
        }
        return { w, h, sampledColors: colors.size, sampledInk: ink };
      };
      const sampleRect = (canvas, x, y, w, h) => {
        if (!canvas || !canvas.getContext) return null;
        x = Math.max(0, x | 0);
        y = Math.max(0, y | 0);
        w = Math.max(0, Math.min(w | 0, (canvas.width | 0) - x));
        h = Math.max(0, Math.min(h | 0, (canvas.height | 0) - y));
        if (!w || !h) return null;
        const data = canvas.getContext('2d').getImageData(x, y, w, h).data;
        const colors = new Set();
        let nonBlack = 0, nonGray = 0, nonWhite = 0;
        for (let i = 0; i < data.length; i += 16) {
          const a = data[i + 3];
          if (!a) continue;
          const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          colors.add(rgb);
          if (rgb !== 0x000000) nonBlack++;
          if (rgb !== 0xc0c0c0) nonGray++;
          if (rgb !== 0xffffff) nonWhite++;
        }
        return { x, y, w, h, sampledColors: colors.size, nonBlack, nonGray, nonWhite };
      };
      const visibleWindows = Object.values(r.windows)
        .filter(w => w && w.visible)
        .map(w => ({
          hwnd: w.hwnd,
          title: w.title || '',
          x: w.x, y: w.y, w: w.w, h: w.h,
          isDialog: !!w.isDialog,
          back: sampleCanvas(w._backCanvas),
          aboutContent: w.title === 'About Winamp'
            ? sampleRect(w._backCanvas, 10, 56, 451, 311)
            : null,
        }));
      const app = runningApps[0];
      const tm = app && app.wine && app.wine.threadManager;
      let manualRun = null;
      if (${ABOUT_MANUAL_RUN_STEPS} && tm && tm.threads) {
        const first = Array.from(tm.threads.values())[0];
        const e = first && first.instance && first.instance.exports;
        const before = e && e.get_eip ? (e.get_eip() >>> 0) : 0;
        const stats = tm.runSlice(${ABOUT_MANUAL_RUN_STEPS}, { quantumSteps: ${ABOUT_MANUAL_RUN_STEPS} });
        const after = e && e.get_eip ? (e.get_eip() >>> 0) : 0;
        manualRun = { before, after, stats };
      }
      const threads = tm && tm.threads ? Array.from(tm.threads.entries()).map(([handle, t]) => {
        const e = t.instance && t.instance.exports;
        return {
          handle: handle >>> 0,
          tid: t.tid,
          state: t.state,
          eip: e && e.get_eip ? (e.get_eip() >>> 0) : 0,
          yieldReason: e && e.get_yield_reason ? (e.get_yield_reason() >>> 0) : 0,
          sleepCount: t.sleepCount || 0,
        };
      }) : [];
      const counters = {};
      for (const [k, v] of Object.entries(window.__waProfile.counters || {})) {
        counters[k] = {
          count: v.count,
          total: +v.total.toFixed(3),
          max: +v.max.toFixed(3),
        };
      }
      return {
        menuState: ${JSON.stringify(menuState)},
        aboutOpen: visibleWindows.some(w => w.title === 'About Winamp'),
        visibleWindows,
        threads,
        manualRun,
        counters,
        samples: window.__waProfile.samples || {},
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    await saveScreenshot();
    cdp.close();
    cleanup();
    return;
  }

  await evalExpr(`(() => {
    const app = runningApps[0];
    app.wine.instance.exports.post_message_q(app.wine.instance.exports.get_main_hwnd(), 0x0111, 40041, 0);
    return 1;
  })()`);
  await wait(1200);

  await evalExpr(`(() => {
    window.__waProfile.marks.push({ name: 'click-credits', t: performance.now() - window.__waProfile.t0 });
    return 1;
  })()`);
  await clickCanvasPoint(170, 42);
  await wait(CREDIT_TAB_WAIT_MS);
  await evalExpr(`(() => {
    const r = window.sharedRenderer || runningApps[0].wine.renderer;
    const sampleCanvas = (canvas) => {
      if (!canvas || !canvas.getContext) return null;
      const w = canvas.width | 0;
      const h = canvas.height | 0;
      if (!w || !h) return null;
      const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      const colors = new Set();
      let ink = 0;
      for (let i = 0; i < data.length; i += 16) {
        const a = data[i + 3];
        if (!a) continue;
        const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        colors.add(rgb);
        if (rgb !== 0xc0c0c0 && rgb !== 0x000000 && rgb !== 0xffffff) ink++;
      }
      return { w, h, sampledColors: colors.size, sampledInk: ink };
    };
    window.__waProfile.creditsSnapshot = Object.values(r.windows)
      .filter(w => w && w.visible)
      .map(w => ({
        hwnd: w.hwnd,
        title: w.title || '',
        x: w.x, y: w.y, w: w.w, h: w.h,
        isDialog: !!w.isDialog,
        back: sampleCanvas(w._backCanvas),
      }));
    return 1;
  })()`);
  await evalExpr(`(() => {
    window.__waProfile.marks.push({ name: 'click-winamp', t: performance.now() - window.__waProfile.t0 });
    return 1;
  })()`);
  await clickCanvasPoint(60, 42);
  await wait(RETURN_TAB_WAIT_MS);

  const result = await evalExpr(`(() => {
    const p = window.__waProfile;
    const r = window.sharedRenderer || runningApps[0].wine.renderer;
    const sampleCanvas = (canvas) => {
      if (!canvas || !canvas.getContext) return null;
      const w = canvas.width | 0;
      const h = canvas.height | 0;
      if (!w || !h) return null;
      const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      const colors = new Set();
      let ink = 0;
      for (let i = 0; i < data.length; i += 16) {
        const a = data[i + 3];
        if (!a) continue;
        const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        colors.add(rgb);
        if (rgb !== 0xc0c0c0 && rgb !== 0x000000 && rgb !== 0xffffff) ink++;
      }
      return { w, h, sampledColors: colors.size, sampledInk: ink };
    };
    const out = { marks: p.marks, counters: {}, samples: p.samples, creditsSnapshot: p.creditsSnapshot || null };
    for (const [k, v] of Object.entries(p.counters)) {
      out.counters[k] = {
        count: v.count,
        total: +v.total.toFixed(3),
        avg: +(v.total / Math.max(1, v.count)).toFixed(3),
        max: +v.max.toFixed(3),
      };
    }
    out.state = {
      apps: runningApps.length,
      windows: Object.keys(r.windows).length,
      inputQueue: r.inputQueue.length,
      mainYield: runningApps[0].wine.instance.exports.get_yield_reason(),
      visibleWindows: Object.values(r.windows).filter(w => w && w.visible).map(w => ({
        hwnd: w.hwnd,
        title: w.title || '',
        x: w.x, y: w.y, w: w.w, h: w.h,
        isDialog: !!w.isDialog,
        isAboutDialog: !!w.isAboutDialog,
        back: sampleCanvas(w._backCanvas),
      })),
    };
    return out;
  })()`, 5000);

  console.log(JSON.stringify(result, null, 2));
  await saveScreenshot();
  cdp.close();
  cleanup();
}

main().catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});
