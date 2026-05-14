#!/usr/bin/env node
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = process.cwd();
const PORT = 8765;
const DEBUG_PORT = 9223;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function main() {
  const headless = process.env.HEADLESS !== '0';
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const userData = '/private/tmp/wine-assembly-chrome-profile';
  const chromeArgs = [
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userData}`,
    `http://127.0.0.1:${PORT}/index.html`,
  ];
  if (headless) chromeArgs.unshift('--headless=new');
  const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  let serverErr = '';
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });
  server.stderr.on('data', d => { serverErr += d.toString(); });
  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { server.kill('SIGKILL'); } catch (_) {}
  };
  process.on('exit', cleanup);

  let page;
  for (let i = 0; i < 80; i++) {
    try {
      const pages = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      page = pages.find(p => p.type === 'page');
      if (page) break;
    } catch (_) {}
    await wait(100);
  }
  if (!page) {
    throw new Error('Chrome page did not appear\nchrome stderr:\n' + chromeErr.slice(-4000) + '\nserver stderr:\n' + serverErr.slice(-1000));
  }

  const cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function evalExpr(expression, timeout = 5000) {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result && r.result.value;
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
      else if (performance.now() - started > 8000) reject(new Error('app globals not ready'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 9000);

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
        try { return orig.apply(this, args); }
        finally { add(name, performance.now() - t, args[0]); }
      };
      proto[key].__profiled = true;
    };
    wrap(Win98Renderer.prototype, 'repaint', 'renderer.repaint');
    wrap(Win98Renderer.prototype, 'flushRepaint', 'renderer.flushRepaint');
    wrap(Win98Renderer.prototype, 'handleMouseDown', 'input.mouseDown');
    wrap(Win98Renderer.prototype, 'handleMouseUp', 'input.mouseUp');
    wrap(ThreadManager.prototype, 'checkMainYield', 'thread.checkMainYield');
    wrap(ThreadManager.prototype, 'runSlice', 'thread.runSlice');
  })()`);

  await evalExpr(`document.getElementById('app-select').value = 'winamp'; launchApp()`, 15000);
  await wait(1800);
  await evalExpr(`(() => {
    const app = runningApps[0];
    app.wine.instance.exports.post_message_q(app.wine.instance.exports.get_main_hwnd(), 0x0111, 2, 0);
    return 1;
  })()`);
  await wait(900);
  await evalExpr(`(() => {
    const app = runningApps[0];
    app.wine.instance.exports.post_message_q(app.wine.instance.exports.get_main_hwnd(), 0x0111, 40041, 0);
    return 1;
  })()`);
  await wait(1200);

  await evalExpr(`(() => {
    const r = window.sharedRenderer || runningApps[0].wine.renderer;
    window.__waProfile.marks.push({ name: 'click-credits', t: performance.now() - window.__waProfile.t0 });
    r.handleMouseDown(170, 42, 1);
    r.handleMouseUp(170, 42, 1);
    return 1;
  })()`);
  await wait(1500);
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
    const r = window.sharedRenderer || runningApps[0].wine.renderer;
    window.__waProfile.marks.push({ name: 'click-winamp', t: performance.now() - window.__waProfile.t0 });
    r.handleMouseDown(60, 42, 1);
    r.handleMouseUp(60, 42, 1);
    return 1;
  })()`);
  await wait(1500);

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
  cdp.close();
  cleanup();
}

main().catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});
