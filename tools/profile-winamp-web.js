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
const ABOUT_WAIT_MS = Math.max(0, parseInt(process.env.ABOUT_WAIT_MS || '1800', 10) || 0);
const ABOUT_MANUAL_RUN_STEPS = Math.max(0, parseInt(process.env.ABOUT_MANUAL_RUN_STEPS || '0', 10) || 0);
const VIEWPORT_WIDTH = Math.max(0, parseInt(process.env.VIEWPORT_WIDTH || '0', 10) || 0);
const VIEWPORT_HEIGHT = Math.max(0, parseInt(process.env.VIEWPORT_HEIGHT || '0', 10) || 0);
const SCREENSHOT_PATH = process.env.SCREENSHOT_PATH || '';
const WINAMP_DOUBLE_SIZE = process.env.WINAMP_DOUBLE_SIZE === '1';
const WINAMP_PLAYLIST_LARGE = process.env.WINAMP_PLAYLIST_LARGE === '1';

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
  const mode = process.env.MODE ||
    (process.argv.includes('--audio') ? 'audio' :
     process.argv.includes('--about-menu') ? 'about-menu' : 'credits');
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-chrome-profile-'));
  const chromeArgs = [
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userData}`,
    `http://127.0.0.1:${PORT}/index.html?profile=${Date.now()}`,
  ];
  if (VIEWPORT_WIDTH && VIEWPORT_HEIGHT) chromeArgs.splice(3, 0, `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`);
  if (headless) chromeArgs.unshift('--headless=new');
  const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
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
      page = pages.find(p => p.type === 'page');
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

  const cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
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
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (shot && shot.data) fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
  }

  async function evalExpr(expression, timeout = 5000, userGesture = false) {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout,
      userGesture,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result && r.result.value;
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
    wrap(Win98Renderer.prototype, 'repaint', 'renderer.repaint');
    wrap(Win98Renderer.prototype, 'flushRepaint', 'renderer.flushRepaint');
    wrap(Win98Renderer.prototype, 'handleMouseDown', 'input.mouseDown');
    wrap(Win98Renderer.prototype, 'handleMouseUp', 'input.mouseUp');
    wrap(ThreadManager.prototype, 'checkMainYield', 'thread.checkMainYield');
    wrap(ThreadManager.prototype, 'runSlice', 'thread.runSlice');
  })()`);

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
  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (runningApps[0] && runningApps[0].wine && runningApps[0].wine.instance) resolve(1);
      else if (performance.now() - started > 15000) reject(new Error('Winamp did not launch'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 16000);
  await wait(1800);
  await evalExpr(`(() => {
    const app = runningApps[0];
    app.wine.instance.exports.post_message_q(app.wine.instance.exports.get_main_hwnd(), 0x0111, 2, 0);
    return 1;
  })()`);
  await wait(900);

  if (mode === 'audio') {
    await clickCanvasPoint(66, 129);
    await wait(2500);
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
        voices: voiceMap,
        windows: Object.values((window.sharedRenderer || wine.renderer).windows)
          .filter(w => w && w.visible)
          .map(w => ({ hwnd: w.hwnd, title: w.title || '', x: w.x, y: w.y, w: w.w, h: w.h })),
      };
    })()`);
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
    await wait(ABOUT_WAIT_MS);
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
  await saveScreenshot();
  cdp.close();
  cleanup();
}

main().catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});
