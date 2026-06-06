#!/usr/bin/env node
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Math.max(1, parseInt(process.env.PORT || '8765', 10) || 8765);
const DEBUG_PORT = Math.max(1, parseInt(process.env.DEBUG_PORT || '9225', 10) || 9225);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = process.env.HEADLESS !== '0';
const VIEWPORT_WIDTH = Math.max(640, parseInt(process.env.VIEWPORT_WIDTH || '960', 10) || 960);
const VIEWPORT_HEIGHT = Math.max(480, parseInt(process.env.VIEWPORT_HEIGHT || '720', 10) || 720);
const OUTPUT = process.env.OUTPUT || '/private/tmp/aoe-web-profile.json';
const SCREENSHOT = process.env.SCREENSHOT || '/private/tmp/aoe-web-profile.png';
const RUN_SLICE = Math.max(1000, parseInt(process.env.RUN_SLICE || '100000', 10) || 100000);
const GAMEPLAY_MS = Math.max(1000, parseInt(process.env.GAMEPLAY_MS || '8000', 10) || 8000);
const MENU_WAIT_MS = Math.max(0, parseInt(process.env.MENU_WAIT_MS || '8500', 10) || 0);
const SINGLE_PLAYER_WAIT_MS = Math.max(0, parseInt(process.env.SINGLE_PLAYER_WAIT_MS || '2500', 10) || 0);
const RANDOM_MAP_WAIT_MS = Math.max(0, parseInt(process.env.RANDOM_MAP_WAIT_MS || '9000', 10) || 0);
const CAMPAIGN_WAIT_MS = Math.max(0, parseInt(process.env.CAMPAIGN_WAIT_MS || '9000', 10) || 0);
const GAME_LOAD_WAIT_MS = Math.max(0, parseInt(process.env.GAME_LOAD_WAIT_MS || '18000', 10) || 0);
const PROGRESS = process.env.PROGRESS === '1';
const PROFILE_PREFIX = '__AOE_PROFILE_JSON__';
const STAGE_SCREENSHOTS = process.env.STAGE_SCREENSHOTS === '1';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function progress(msg) {
  if (PROGRESS) console.error(`[aoe-profile] ${msg}`);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
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

function getText(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
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
      const b0 = buf[0];
      const b1 = buf[1];
      let len = b1 & 0x7f;
      let off = 2;
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
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
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

async function main() {
  let server = null;
  let serverErr = '';
  try {
    await getText(`http://127.0.0.1:${PORT}/index.html`);
    progress(`using existing server on ${PORT}`);
  } catch (_) {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr.on('data', d => { serverErr += d.toString(); });
    progress(`started server on ${PORT}`);
    await wait(500);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-aoe-profile-'));
  const chromeArgs = [
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userData}`,
    `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
    `http://127.0.0.1:${PORT}/index.html?profile=${Date.now()}`,
  ];
  if (HEADLESS) chromeArgs.unshift('--headless=new');
  const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { if (server) server.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  let page = null;
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
    throw new Error('Chrome page did not appear\nchrome stderr:\n' +
      chromeErr.slice(-4000) + '\nserver stderr:\n' + serverErr.slice(-1000));
  }

  const cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  async function evalExpr(expression, timeout = 5000, userGesture = false) {
    const r = await withTimeout(cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout,
      userGesture,
    }), timeout + 3000, 'Runtime.evaluate');
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result && r.result.value;
  }

  let stageShotIndex = 0;
  async function stageShot(label) {
    if (!STAGE_SCREENSHOTS) return;
    const safe = String(label || 'stage').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '');
    const file = `/private/tmp/aoe-stage-${String(stageShotIndex++).padStart(2, '0')}-${safe}.png`;
    const shot = await withTimeout(
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      5000,
      'Page.captureScreenshot'
    );
    if (shot && shot.data) {
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      progress(`stage ${label}: ${file}`);
    }
  }

  let canvasMetrics = null;
  async function refreshCanvasMetrics() {
    canvasMetrics = await evalExpr(`(() => {
      const canvas = document.getElementById('screen');
      const r = canvas.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
      };
    })()`);
    return canvasMetrics;
  }

  function canvasClientPoint(x, y) {
    if (!canvasMetrics) throw new Error('canvas metrics not initialized');
    return {
      x: canvasMetrics.left + (x / canvasMetrics.backingWidth) * canvasMetrics.width,
      y: canvasMetrics.top + (y / canvasMetrics.backingHeight) * canvasMetrics.height,
    };
  }

  let gameScale = { x: 1, y: 1 };
  async function refreshGameScale() {
    const size = await evalExpr(`(() => {
      const app = runningApps && runningApps[0];
      const wine = app && app.wine;
      const renderer = window.sharedRenderer || (wine && wine.renderer);
      const wins = renderer ? Object.values(renderer.windows || {}) : [];
      const win = wins.find(w => w && w.visible && !w.isChild && /Age of Empires/i.test(w.title || '')) ||
        wins.find(w => w && w.visible && !w.isChild);
      return win ? { w: win.w | 0, h: win.h | 0 } : { w: 640, h: 480 };
    })()`);
    gameScale = {
      x: size && size.w ? size.w / 640 : 1,
      y: size && size.h ? size.h / 480 : 1,
    };
    return gameScale;
  }

  function gamePoint(x, y) {
    return {
      x: Math.round(x * gameScale.x),
      y: Math.round(y * gameScale.y),
    };
  }

  async function clickCanvas(x, y) {
    const p = canvasClientPoint(x, y);
    await withTimeout(cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: p.x,
      y: p.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    }), 3000, 'mousePressed');
    await wait(40);
    await withTimeout(cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: p.x,
      y: p.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    }), 3000, 'mouseReleased');
  }

  async function moveCanvas(x, y) {
    const p = canvasClientPoint(x, y);
    await withTimeout(cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      button: 'none',
      buttons: 0,
    }), 3000, 'mouseMoved');
  }

  function sendMouseNoWait(type, x, y, button, buttons, clickCount) {
    const p = canvasClientPoint(x, y);
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x: p.x,
      y: p.y,
      button: button || 'none',
      buttons: buttons || 0,
      clickCount: clickCount || 0,
    }).catch(() => {});
  }

  async function clickCanvasNoWait(x, y) {
    sendMouseNoWait('mousePressed', x, y, 'left', 1, 1);
    await wait(40);
    sendMouseNoWait('mouseReleased', x, y, 'left', 0, 1);
  }

  async function keyPress(code) {
    const key = String.fromCharCode(code);
    await withTimeout(cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      key,
      text: key,
      unmodifiedText: key,
    }), 3000, 'keyDown');
    await withTimeout(cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      key,
    }), 3000, 'keyUp');
  }

  await evalExpr(`new Promise(r => {
    if (document.readyState === 'complete') r(1);
    else window.addEventListener('load', () => r(1), { once: true });
  })`);
  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (typeof Win98Renderer !== 'undefined' &&
          typeof ThreadManager !== 'undefined' &&
          typeof launchApp === 'function') resolve(1);
      else if (performance.now() - started > 10000) reject(new Error('app globals not ready'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 11000);

  await evalExpr(`(() => {
    const round = v => +((Number(v) || 0).toFixed(3));
    const valueStats = values => {
      const nums = (values || []).map(Number).filter(Number.isFinite);
      if (!nums.length) return { count: 0 };
      const sorted = nums.slice().sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const avg = sum / nums.length;
      const pct = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
      return {
        count: nums.length,
        minMs: round(sorted[0]),
        avgMs: round(avg),
        p50Ms: round(pct(0.50)),
        p95Ms: round(pct(0.95)),
        p99Ms: round(pct(0.99)),
        maxMs: round(sorted[sorted.length - 1]),
      };
    };
    const intervalStats = (events, targetMs) => {
      const times = (events || [])
        .map(e => typeof e === 'number' ? e : e && e.t)
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const intervals = [];
      for (let i = 1; i < times.length; i++) {
        const dt = times[i] - times[i - 1];
        if (dt >= 0) intervals.push(dt);
      }
      const stats = valueStats(intervals);
      const target = Number(targetMs) || 16.667;
      stats.events = times.length;
      stats.durationMs = times.length > 1 ? round(times[times.length - 1] - times[0]) : 0;
      stats.fps = stats.durationMs ? round(((times.length - 1) * 1000) / stats.durationMs) : 0;
      stats.over20ms = intervals.filter(v => v > 20).length;
      stats.over33ms = intervals.filter(v => v > 33.334).length;
      stats.over50ms = intervals.filter(v => v > 50).length;
      stats.droppedAtTarget = intervals.reduce((n, v) => n + Math.max(0, Math.round(v / target) - 1), 0);
      return stats;
    };
      const p = window.__aoeProfile = {
        t0: performance.now(),
        label: 'startup',
        counters: Object.create(null),
        frames: Object.create(null),
        samples: Object.create(null),
        inputs: [],
        surfaceDc: null,
        reset(label) {
          this.t0 = performance.now();
          this.label = label || 'profile';
          this.counters = Object.create(null);
          this.frames = Object.create(null);
          this.samples = Object.create(null);
          this.inputs = [];
          this.surfaceDc = {
            syncIn: 0,
            syncOut: 0,
            cleanOut: 0,
            dirtyOut: 0,
            writes: 0,
            cleanMs: 0,
            dirtyMs: 0,
            bySlot: Object.create(null),
          };
        },
      add(name, dt, data) {
        const c = this.counters[name] || (this.counters[name] = { count: 0, total: 0, max: 0 });
        c.count++;
        c.total += dt;
        if (dt > c.max) c.max = dt;
        const arr = this.samples[name] || (this.samples[name] = []);
        arr.push({ dt: round(dt), at: round(performance.now() - this.t0), data: data || null });
        arr.sort((a, b) => b.dt - a.dt);
        if (arr.length > 12) arr.length = 12;
      },
      frame(name, data) {
        const arr = this.frames[name] || (this.frames[name] = []);
        arr.push({ t: round(performance.now() - this.t0), data: data || null });
        if (arr.length > 5000) arr.splice(0, arr.length - 5000);
      },
      snapshot() {
        const counters = {};
        for (const [name, c] of Object.entries(this.counters)) {
          counters[name] = {
            count: c.count | 0,
            totalMs: round(c.total),
            avgMs: c.count ? round(c.total / c.count) : 0,
            maxMs: round(c.max),
          };
        }
        const inputLatencies = this.inputs
          .filter(i => Number.isFinite(i.repaintDelayMs))
          .map(i => i.repaintDelayMs);
        const surfaceDc = this.surfaceDc ? {
          syncIn: this.surfaceDc.syncIn | 0,
          syncOut: this.surfaceDc.syncOut | 0,
          cleanOut: this.surfaceDc.cleanOut | 0,
          dirtyOut: this.surfaceDc.dirtyOut | 0,
          writes: this.surfaceDc.writes | 0,
          cleanMs: round(this.surfaceDc.cleanMs),
          dirtyMs: round(this.surfaceDc.dirtyMs),
          bySlot: Object.fromEntries(Object.entries(this.surfaceDc.bySlot).map(([slot, s]) => [slot, {
            syncIn: s.syncIn | 0,
            syncOut: s.syncOut | 0,
            cleanOut: s.cleanOut | 0,
            dirtyOut: s.dirtyOut | 0,
            writes: s.writes | 0,
            cleanMs: round(s.cleanMs),
            dirtyMs: round(s.dirtyMs),
            lastWrite: s.lastWrite || null,
          }])),
        } : null;
        return {
          label: this.label,
          elapsedMs: round(performance.now() - this.t0),
          counters,
          jitter: {
            raf: intervalStats(this.frames.raf, 16.667),
            repaint: intervalStats(this.frames.repaint, 16.667),
            present: intervalStats(this.frames.present, 16.667),
            dxPresent: intervalStats(this.frames.dxPresent, 16.667),
            inputLatency: valueStats(inputLatencies),
          },
          surfaceDc,
          inputs: this.inputs.slice(-40),
          samples: this.samples,
        };
      },
    };
    const wrap = (proto, key, name, frameName) => {
      const orig = proto && proto[key];
      if (!orig || orig.__aoeProfiled) return;
      proto[key] = function(...args) {
        const t = performance.now();
        let ret;
        try {
          ret = orig.apply(this, args);
          return ret;
        } finally {
          const dt = performance.now() - t;
          const prof = window.__aoeProfile;
          if (prof) {
            prof.add(name, dt, { args: args.slice(0, 5), ret: ret || null });
            if (frameName) prof.frame(frameName, { dtMs: round(dt) });
            if (name === 'renderer.repaint' && prof.inputs.length) {
              for (let i = prof.inputs.length - 1; i >= 0; i--) {
                const ev = prof.inputs[i];
                if (ev.repaintDelayMs == null) {
                  ev.repaintDelayMs = round(performance.now() - prof.t0 - ev.atMs);
                  ev.repaintDtMs = round(dt);
                  break;
                }
              }
            }
          }
        }
      };
      proto[key].__aoeProfiled = true;
    };
    const wrapInput = (proto, key) => {
      const orig = proto && proto[key];
      if (!orig || orig.__aoeInputProfiled) return;
      proto[key] = function(...args) {
        const prof = window.__aoeProfile;
        if (prof) {
          prof.inputs.push({
            name: key,
            args: args.slice(0, 4),
            atMs: round(performance.now() - prof.t0),
            queueBefore: this.inputQueue ? this.inputQueue.length : 0,
          });
          if (prof.inputs.length > 100) prof.inputs.shift();
        }
        return orig.apply(this, args);
      };
      proto[key].__aoeInputProfiled = true;
    };
    wrap(Win98Renderer.prototype, 'repaint', 'renderer.repaint', 'repaint');
    wrap(Win98Renderer.prototype, 'flushRepaint', 'renderer.flushRepaint', null);
    wrap(ThreadManager.prototype, 'runSlice', 'thread.runSlice', null);
    wrapInput(Win98Renderer.prototype, 'handleMouseMove');
    wrapInput(Win98Renderer.prototype, 'handleMouseDown');
    wrapInput(Win98Renderer.prototype, 'handleMouseUp');
    if (!window.__aoeRafInstalled) {
      window.__aoeRafInstalled = true;
      requestAnimationFrame(function tick() {
        if (window.__aoeProfile) window.__aoeProfile.frame('raf', null);
        requestAnimationFrame(tick);
      });
    }
    const origCreateHostImports = window.createHostImports;
    if (origCreateHostImports && !origCreateHostImports.__aoeProfiled) {
      window.createHostImports = function(ctx) {
        const base = origCreateHostImports(ctx);
        const host = base && base.host;
        const surfaceSlotFromHdc = hdc => {
          hdc = hdc >>> 0;
          return hdc >= 0x200000 && hdc < 0x300000 ? hdc - 0x200000 : -1;
        };
        const ensureSurfaceSlot = (prof, slot) => {
          const root = prof && prof.surfaceDc;
          if (!root || slot < 0) return null;
          const key = String(slot >>> 0);
          return root.bySlot[key] || (root.bySlot[key] = {
            dirty: false,
            syncIn: 0,
            syncOut: 0,
            cleanOut: 0,
            dirtyOut: 0,
            writes: 0,
            cleanMs: 0,
            dirtyMs: 0,
            lastWrite: null,
          });
        };
        const markSurfaceWrite = (hdc, name) => {
          const prof = window.__aoeProfile;
          const slot = surfaceSlotFromHdc(hdc);
          const s = ensureSurfaceSlot(prof, slot);
          if (!s) return;
          s.dirty = true;
          s.writes++;
          s.lastWrite = name;
          prof.surfaceDc.writes++;
        };
        const noteSurfaceSync = (args, dt) => {
          const prof = window.__aoeProfile;
          if (!prof || !prof.surfaceDc) return;
          const slot = (args[0] >>> 0);
          const dir = args[1] | 0;
          const s = ensureSurfaceSlot(prof, slot);
          if (!s) return;
          if (dir === 0) {
            s.dirty = false;
            s.syncIn++;
            prof.surfaceDc.syncIn++;
          } else if (dir === 1) {
            s.syncOut++;
            prof.surfaceDc.syncOut++;
            if (s.dirty) {
              s.dirtyOut++;
              s.dirtyMs += dt;
              prof.surfaceDc.dirtyOut++;
              prof.surfaceDc.dirtyMs += dt;
            } else {
              s.cleanOut++;
              s.cleanMs += dt;
              prof.surfaceDc.cleanOut++;
              prof.surfaceDc.cleanMs += dt;
            }
            s.dirty = false;
          }
        };
        const wrapHost = (key, name, frameName, opts = null) => {
          const orig = host && host[key];
          if (!orig) return;
          host[key] = function(...args) {
            const t = performance.now();
            let ret;
            try {
              ret = orig.apply(this, args);
              return ret;
            } finally {
              const dt = performance.now() - t;
              if (window.__aoeProfile) {
                if (opts && opts.surfaceDstArg !== undefined) markSurfaceWrite(args[opts.surfaceDstArg], name);
                if (opts && opts.surfaceSync) noteSurfaceSync(args, dt);
                window.__aoeProfile.add(name, dt, { args: args.slice(0, 8), ret: ret || null });
                if (frameName) window.__aoeProfile.frame(frameName, { dtMs: round(dt), args: args.slice(0, 5) });
              }
            }
          };
        };
        wrapHost('gdi_set_dib_to_device', 'gdi.setDibToDevice', 'present', { surfaceDstArg: 0 });
        wrapHost('gdi_stretch_dib_bits', 'gdi.stretchDibBits', 'present', { surfaceDstArg: 0 });
        wrapHost('gdi_bitblt', 'gdi.bitblt', null, { surfaceDstArg: 0 });
        wrapHost('gdi_stretch_blt', 'gdi.stretchBlt', null, { surfaceDstArg: 0 });
        wrapHost('gdi_draw_edge', 'gdi.drawEdge', null, { surfaceDstArg: 0 });
        wrapHost('gdi_fill_rect', 'gdi.fillRect', null, { surfaceDstArg: 0 });
        wrapHost('gdi_fill_rgn', 'gdi.fillRgn', null, { surfaceDstArg: 0 });
        wrapHost('gdi_gradient_fill_h', 'gdi.gradientFillH', null, { surfaceDstArg: 0 });
        wrapHost('gdi_draw_focus_rect', 'gdi.drawFocusRect', null, { surfaceDstArg: 0 });
        wrapHost('gdi_rectangle', 'gdi.rectangle', null, { surfaceDstArg: 0 });
        wrapHost('gdi_ellipse', 'gdi.ellipse', null, { surfaceDstArg: 0 });
        wrapHost('gdi_polygon', 'gdi.polygon', null, { surfaceDstArg: 0 });
        wrapHost('gdi_line_to', 'gdi.lineTo', null, { surfaceDstArg: 0 });
        wrapHost('gdi_arc', 'gdi.arc', null, { surfaceDstArg: 0 });
        wrapHost('gdi_text_out', 'gdi.textOut', null, { surfaceDstArg: 0 });
        wrapHost('gdi_draw_text', 'gdi.drawText', null, { surfaceDstArg: 0 });
        wrapHost('gdi_set_pixel', 'gdi.setPixel', null, { surfaceDstArg: 0 });
        wrapHost('gdi_frame_rect', 'gdi.frameRect', null, { surfaceDstArg: 0 });
        wrapHost('dx_surface_sync', 'dx.surfaceSync', null, { surfaceSync: true });
        return base;
      };
      window.createHostImports.__aoeProfiled = true;
    }
    return 1;
  })()`);

  const preLaunch = await evalExpr(`(() => {
    const sel = document.getElementById('app-select');
    if (sel && !Array.from(sel.options).some(o => o.value === 'aoe1')) {
      const opt = document.createElement('option');
      opt.value = 'aoe1';
      opt.textContent = 'Age of Empires (demo)';
      sel.appendChild(opt);
    }
    if (sel) sel.value = 'aoe1';
    const slice = document.getElementById('slice-size-select');
    if (slice) slice.value = String(${RUN_SLICE});
    return {
      value: sel && sel.value,
      hasAoe: typeof apps !== 'undefined' && !!apps.aoe1,
      options: sel ? Array.from(sel.options).map(o => o.value).filter(Boolean).slice(-20) : [],
      status: document.getElementById('status').textContent,
      logTail: document.getElementById('log').textContent.slice(-500),
    };
  })()`);
  progress('prelaunch ' + JSON.stringify(preLaunch));
  await evalExpr(`(() => {
    return launchApp();
  })()`, 60000, true);
  progress('launchApp(aoe1) requested');
  const postLaunch = await evalExpr(`(() => ({
    status: document.getElementById('status').textContent,
    apps: runningApps ? runningApps.length : 0,
    logTail: document.getElementById('log').textContent.slice(-1000),
  }))()`);
  progress('postlaunch ' + JSON.stringify(postLaunch));

  const launchState = await evalExpr(`new Promise(resolve => {
    const started = performance.now();
    const tick = () => {
      const app = runningApps && runningApps[0];
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      if (app && app.wine && app.wine.instance) {
        resolve({
          ready: true,
          status: document.getElementById('status').textContent,
          mainHwnd: e && e.get_main_hwnd ? (e.get_main_hwnd() >>> 0) : 0,
          logTail: document.getElementById('log').textContent.slice(-2000),
        });
      } else if (performance.now() - started > 120000) {
        resolve({
          ready: false,
          status: document.getElementById('status').textContent,
          apps: runningApps ? runningApps.length : 0,
          logTail: document.getElementById('log').textContent.slice(-3000),
        });
      }
      else setTimeout(tick, 100);
    };
    tick();
  })`, 125000);
  if (!launchState || !launchState.ready) {
    throw new Error('AoE did not launch: ' + JSON.stringify(launchState));
  }
  progress('AoE instance ready');
  await stageShot('launched');

  await wait(MENU_WAIT_MS);
  await refreshCanvasMetrics();
  await refreshGameScale();
  await stageShot('main-menu-waited');
  let p = gamePoint(384, 237);
  await clickCanvas(p.x, p.y);
  await stageShot('click-single-player');
  await wait(SINGLE_PLAYER_WAIT_MS);
  p = gamePoint(384, 226);
  await clickCanvas(p.x, p.y);
  await stageShot('click-random-map-menu');
  await wait(RANDOM_MAP_WAIT_MS);
  await stageShot('random-map-name-waited');
  await keyPress(65);
  await keyPress(79);
  await keyPress(69);
  await stageShot('typed-aoe');
  await wait(500);
  await clickCanvas(360, 456);
  await stageShot('click-name-ok');
  await wait(CAMPAIGN_WAIT_MS);
  await stageShot('campaign-waited');
  await clickCanvas(285, 683);
  await stageShot('click-campaign-ok');
  await wait(GAME_LOAD_WAIT_MS);
  await stageShot('game-load-waited');
  await clickCanvas(840, 698);
  await stageShot('click-gameplay');
  await wait(2500);
  await refreshCanvasMetrics();
  await refreshGameScale();

  await evalExpr(`(() => {
    if (window.__aoeProfile) window.__aoeProfile.reset('gameplay');
    const buildSnapshot = () => {
      const app = runningApps && runningApps[0];
      const wine = app && app.wine;
      const e = wine && wine.instance && wine.instance.exports;
      const renderer = window.sharedRenderer || (wine && wine.renderer);
      return {
        runSlice: ${RUN_SLICE},
        app: app ? app.name : '',
        eip: e && e.get_eip ? (e.get_eip() >>> 0) : 0,
        yieldReason: e && e.get_yield_reason ? (e.get_yield_reason() >>> 0) : 0,
        mainHwnd: e && e.get_main_hwnd ? (e.get_main_hwnd() >>> 0) : 0,
        canvas: (() => {
          const c = document.getElementById('screen');
          const r = c.getBoundingClientRect();
          return { width: c.width, height: c.height, cssW: r.width, cssH: r.height };
        })(),
        mouse: renderer && renderer.getMousePosition ? (renderer.getMousePosition() >>> 0) : 0,
        windows: renderer ? Object.values(renderer.windows || {}).filter(w => w && w.visible).map(w => ({
          hwnd: w.hwnd >>> 0,
          title: w.title || '',
          x: w.x | 0,
          y: w.y | 0,
          w: w.w | 0,
          h: w.h | 0,
        })) : [],
        profile: window.__aoeProfile ? window.__aoeProfile.snapshot() : null,
      };
    };
    clearTimeout(window.__aoeProfileSnapshotTimer);
    window.__aoeProfileSnapshotTimer = setTimeout(() => {
      try {
        console.log(${JSON.stringify(PROFILE_PREFIX)} + JSON.stringify(buildSnapshot()));
      } catch (e) {
        console.log(${JSON.stringify(PROFILE_PREFIX)} + JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }, ${GAMEPLAY_MS});
    return 1;
  })()`);
  progress('gameplay profile started');

  const eventStart = cdp.events.length;
  for (let i = 0; i < 80; i++) {
    const gp = gamePoint(90 + (i % 20) * 16, 130 + Math.floor(i / 20) * 35);
    sendMouseNoWait('mouseMoved', gp.x, gp.y, 'none', 0, 0);
    if (i === 20) {
      const cp = gamePoint(105, 150);
      await clickCanvasNoWait(cp.x, cp.y);
    }
    await wait(Math.max(10, Math.floor(GAMEPLAY_MS / 80)));
  }

  let result = null;
  for (let i = 0; i < 80 && !result; i++) {
    const recent = cdp.events.slice(eventStart);
    for (const ev of recent) {
      if (ev.method !== 'Runtime.consoleAPICalled') continue;
      const args = (ev.params && ev.params.args) || [];
      const text = args.map(a => Object.prototype.hasOwnProperty.call(a, 'value')
        ? String(a.value)
        : (a.description || '')).join(' ');
      if (!text.startsWith(PROFILE_PREFIX)) continue;
      result = JSON.parse(text.slice(PROFILE_PREFIX.length));
      break;
    }
    if (!result) await wait(250);
  }
  if (!result) {
    throw new Error('AoE profile snapshot did not arrive; console events=' +
      JSON.stringify(cdp.events.slice(-12).map(ev => ev.method)));
  }

  if (SCREENSHOT) {
    try {
      const shot = await withTimeout(
        cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
        5000,
        'Page.captureScreenshot'
      );
      if (shot && shot.data) {
        fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
        result.screenshot = SCREENSHOT;
      }
    } catch (e) {
      result.screenshotError = e && e.message ? e.message : String(e);
    }
  }
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
  cleanup();
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
