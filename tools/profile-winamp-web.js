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

function parseIntAuto(value) {
  const s = String(value || '').trim();
  if (!s) return 0;
  return Math.max(0, parseInt(s, /^0x/i.test(s) ? 16 : 10) || 0);
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
    const resetMatch = s.match(/^profile-reset(?::(.+))?$/i);
    if (resetMatch) return { profileReset: resetMatch[1] || 'playback' };
    const waitMatch = s.match(/^wait:(\d+)$/i);
    if (waitMatch) return { wait: parseInt(waitMatch[1], 10) || 0 };
    const postCmdMatch = s.match(/^post-cmd:(\d+)$/i);
    if (postCmdMatch) return { postCmd: parseIntAuto(postCmdMatch[1]) };
    const timerMatch = s.match(/^timer-interval:([^,]+),([^,]+)$/i);
    if (timerMatch) return { timerInterval: true, hwnd: parseIntAuto(timerMatch[1]), intervalMs: parseIntAuto(timerMatch[2]) };
    const guest8Match = s.match(/^guest8:([^,]+),([^,]+)$/i);
    if (guest8Match) return { guest8: true, addr: parseIntAuto(guest8Match[1]), value: parseIntAuto(guest8Match[2]) & 0xff };
    const clearWorkerCacheMatch = s.match(/^clear-worker-cache:(all|t?\d+)$/i);
    if (clearWorkerCacheMatch) {
      const raw = String(clearWorkerCacheMatch[1] || '').toLowerCase();
      return {
        clearWorkerCache: true,
        tid: raw === 'all' ? 0 : parseIntAuto(raw.replace(/^t/, '')),
      };
    }
    const traceEipMatch = s.match(/^trace-eip:([^,]+),([^,]+),([^,]+),([^,]+)$/i);
    if (traceEipMatch) {
      const tidRaw = String(traceEipMatch[2] || '').trim().toLowerCase();
      const tid = tidRaw === 'all' ? null : parseIntAuto(tidRaw.replace(/^t/, ''));
      return {
        traceEip: true,
        label: traceEipMatch[1],
        tid,
        lo: parseIntAuto(traceEipMatch[3]),
        hi: parseIntAuto(traceEipMatch[4]),
      };
    }
    const schedulerMatch = s.match(/^scheduler-hot:(\d+),(\d+)$/i);
    if (schedulerMatch) {
      return {
        schedulerHot: true,
        quantumSteps: parseIntAuto(schedulerMatch[1]),
        maxWallMs: parseIntAuto(schedulerMatch[2]),
      };
    }
    const schedulerLeadMatch = s.match(/^scheduler-lead:(\d+),(\d+),(\d+),(\d+)$/i);
    if (schedulerLeadMatch) {
      return {
        schedulerLead: true,
        quantumSteps: parseIntAuto(schedulerLeadMatch[1]),
        lowWallMs: parseIntAuto(schedulerLeadMatch[2]),
        highWallMs: parseIntAuto(schedulerLeadMatch[3]),
        leadThresholdMs: parseIntAuto(schedulerLeadMatch[4]),
      };
    }
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
  .filter(p => p.profileReset !== undefined || p.wait !== undefined || p.postCmd !== undefined || p.timerInterval || p.guest8 || p.clearWorkerCache || p.traceEip || p.schedulerHot || p.schedulerLead || p.drag || (Number.isFinite(p.x) && Number.isFinite(p.y)));
const ABOUT_TAB = (argValue('about-tab') || process.env.ABOUT_TAB || '').toLowerCase();
const CREDIT_TAB_WAIT_MS = intArgOrEnv('credit-tab-wait-ms', 'CREDIT_TAB_WAIT_MS', 1500);
const RETURN_TAB_WAIT_MS = intArgOrEnv('return-tab-wait-ms', 'RETURN_TAB_WAIT_MS', 1500);
const TRACE_TREE_GDI = process.env.TRACE_TREE_GDI === '1' || process.argv.includes('--trace-tree-gdi');
const DUMP_CONSOLE = process.env.DUMP_CONSOLE === '1' || process.argv.includes('--dump-console');
const PROGRESS = process.env.PROGRESS === '1' || process.argv.includes('--progress');
const PROFILE_SUMMARY = process.env.PROFILE_SUMMARY === '1' || process.argv.includes('--profile-summary');
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

function compactProfileResult(result) {
  if (!PROFILE_SUMMARY || !result || !result.profile) return result;
  const visibleWindows = (result.visibleWindows || []).map(w => ({
    hwnd: w.hwnd,
    title: w.title,
    w: w.w,
    h: w.h,
    back: w.back,
  }));
  const audioProbe = result.audioProbe ? {
    starts: result.audioProbe.starts,
    resumes: result.audioProbe.resumes,
    leadSamples: (result.audioProbe.scheduleLeadMs || []).length,
    bufferDurationMs: (result.audioProbe.bufferDurationsMs || [])[0] || null,
  } : null;
  return {
    postCmd: result.postCmd,
    audioProbe,
    audioContext: result.audioContext,
    sharedAudio: result.sharedAudio,
    profile: {
      label: result.profile.label,
      elapsedMs: result.profile.elapsedMs,
      counters: result.profile.counters,
      jitter: result.profile.jitter,
      threadSleepIntervals: result.profile.threadSleepIntervals,
      eipRanges: result.profile.eipRanges,
      schedulerLead: result.profile.schedulerLead,
      threads: result.profile.threads,
      hostEvents: result.profile.hostEvents,
    },
    postClickSnapshots: result.postClickSnapshots,
    winampVisGlobals: result.winampVisGlobals,
    winampVisRuntime: result.winampVisRuntime,
    visibleWindows,
  };
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
      frames: Object.create(null),
      threads: Object.create(null),
      hostEvents: Object.create(null),
      eipRanges: [],
      label: 'startup',
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
    p.reset = (label) => {
      p.t0 = performance.now();
      p.counters = Object.create(null);
      p.samples = Object.create(null);
      p.marks = [];
      p.frames = Object.create(null);
      p.threads = Object.create(null);
      p.hostEvents = Object.create(null);
      p.eipRanges = [];
      p.label = label || 'profile';
      if (window.__waAudioProbe) {
        Object.assign(window.__waAudioProbe, {
          starts: 0,
          startTimes: [],
          startCallTimes: [],
          scheduleLeadMs: [],
          bufferDurationsMs: [],
          peaks: [],
          resumes: 0,
          resumeStates: [],
        });
      }
    };
    const round = v => +((Number(v) || 0).toFixed(3));
    const pushFrame = (name, t, data) => {
      if (!Number.isFinite(t) || t < 0) return;
      const arr = p.frames[name] || (p.frames[name] = []);
      arr.push({ t: round(t), data: data || null });
      if (arr.length > 5000) arr.splice(0, arr.length - 5000);
    };
    const valueStats = (values) => {
      const nums = (values || []).map(Number).filter(Number.isFinite);
      if (!nums.length) return { count: 0 };
      const sorted = nums.slice().sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const avg = sum / nums.length;
      const pct = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
      const variance = nums.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / nums.length;
      return {
        count: nums.length,
        minMs: round(sorted[0]),
        avgMs: round(avg),
        p50Ms: round(pct(0.50)),
        p95Ms: round(pct(0.95)),
        p99Ms: round(pct(0.99)),
        maxMs: round(sorted[sorted.length - 1]),
        stddevMs: round(Math.sqrt(variance)),
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
      stats.fps = stats.durationMs > 0 ? round((Math.max(0, times.length - 1) * 1000) / stats.durationMs) : 0;
      stats.targetMs = round(target);
      stats.over20ms = intervals.filter(v => v > 20).length;
      stats.over33ms = intervals.filter(v => v > 33.334).length;
      stats.over50ms = intervals.filter(v => v > 50).length;
      stats.droppedAtTarget = intervals.reduce((n, v) => n + Math.max(0, Math.round(v / target) - 1), 0);
      return stats;
    };
    const worstIntervals = (events, limit) => {
      const times = (events || [])
        .map(e => ({ t: Number(typeof e === 'number' ? e : e && e.t), data: e && e.data }))
        .filter(e => Number.isFinite(e.t))
        .sort((a, b) => a.t - b.t);
      const intervals = [];
      for (let i = 1; i < times.length; i++) {
        intervals.push({ dtMs: round(times[i].t - times[i - 1].t), atMs: round(times[i].t), data: times[i].data || null });
      }
      return intervals.sort((a, b) => b.dtMs - a.dtMs).slice(0, limit || 8);
    };
    const coalescedFrames = (events, mergeMs) => {
      const sorted = (events || [])
        .map(e => ({ t: Number(typeof e === 'number' ? e : e && e.t), data: e && e.data }))
        .filter(e => Number.isFinite(e.t))
        .sort((a, b) => a.t - b.t);
      const out = [];
      let cur = null;
      const gap = Number(mergeMs) || 5;
      for (const ev of sorted) {
        if (!cur || ev.t - cur.lastT > gap) {
          cur = { t: ev.t, lastT: ev.t, count: 1, data: ev.data || null };
          out.push(cur);
        } else {
          cur.lastT = ev.t;
          cur.count++;
        }
      }
      return out.map(ev => ({ t: round(ev.t), data: { blits: ev.count, lastT: round(ev.lastT) } }));
    };
    const counterOut = (map) => {
      const out = {};
      for (const [name, c] of Object.entries(map || {})) {
        out[name] = {
          count: c.count | 0,
          totalMs: round(c.total),
          maxMs: round(c.max),
          avgMs: c.count ? round(c.total / c.count) : 0,
        };
      }
      return out;
    };
    const sleepHistOut = (hist) => {
      const out = {};
      for (const [ms, count] of Object.entries(hist || {})) out[ms] = count | 0;
      return out;
    };
    const threadSleepIntervals = () => {
      const out = {};
      for (const [name, events] of Object.entries(p.frames || {})) {
        const m = /^thread\\.T(\\d+)\\.sleep$/.exec(name);
        if (!m) continue;
        out[m[1]] = {
          intervals: intervalStats(events, 16.667),
          worst: worstIntervals(events, 6),
        };
      }
      return out;
    };
    const eipRangeOut = () => (p.eipRanges || []).map(r => ({
      label: r.label || '',
      tid: r.tid == null ? null : r.tid | 0,
      lo: r.lo >>> 0,
      hi: r.hi >>> 0,
      count: r.count | 0,
      byThread: Object.fromEntries(Object.entries(r.byThread || {}).map(([tid, count]) => [tid, count | 0])),
      topEips: Object.entries(r.byEip || {})
        .map(([eip, count]) => ({ eip: Number(eip) >>> 0, count: count | 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 24),
    }));
    window.__waResetProfile = (label) => p.reset(label);
    window.__waProfileAddEipRange = (label, tid, lo, hi) => {
      const range = {
        label: String(label || 'eip'),
        tid: tid == null ? null : (tid | 0),
        lo: lo >>> 0,
        hi: hi >>> 0,
        count: 0,
        byThread: Object.create(null),
        byEip: Object.create(null),
      };
      p.eipRanges.push(range);
      return range;
    };
    window.__waProfileEipHit = (eip, tid) => {
      eip = eip >>> 0;
      tid = (tid || 0) | 0;
      for (const r of p.eipRanges || []) {
        if (r.tid != null && r.tid !== tid) continue;
        if (eip < (r.lo >>> 0) || eip > (r.hi >>> 0)) continue;
        r.count++;
        const tidKey = String(tid);
        r.byThread[tidKey] = (r.byThread[tidKey] || 0) + 1;
        const eipKey = String(eip);
        r.byEip[eipKey] = (r.byEip[eipKey] || 0) + 1;
      }
    };
    window.__waProfileSnapshot = () => ({
      label: p.label || 'profile',
      elapsedMs: round(performance.now() - p.t0),
      counters: counterOut(p.counters),
      jitter: (() => {
        const audio = window.__waAudioProbe || {};
        const scheduled = (audio.startTimes || [])
          .map(t => Number(t) * 1000)
          .filter(Number.isFinite);
        const durations = (audio.bufferDurationsMs || [])
          .map(Number)
          .filter(Number.isFinite);
        const scheduleGaps = [];
        for (let i = 1; i < scheduled.length; i++) {
          const prevDuration = Number.isFinite(durations[i - 1]) ? durations[i - 1] : 0;
          scheduleGaps.push(+(scheduled[i] - scheduled[i - 1] - prevDuration).toFixed(3));
        }
        const underrunGaps = scheduleGaps.filter(g => g > 2);
        return {
          raf: intervalStats(p.frames.raf, 16.667),
          repaint: intervalStats(p.frames['renderer.repaint'], 16.667),
          bitblt: intervalStats(p.frames['gdi.bitblt'], 16.667),
          visualBitblt: intervalStats(p.frames['visual.bitblt'], 16.667),
          visualFrames: intervalStats(coalescedFrames(p.frames['visual.bitblt'], 5), 66.667),
          audioSubmit: intervalStats(p.frames['audio.startCall'], 26.122),
          audioScheduled: intervalStats(scheduled, 26.122),
          audioBufferDuration: valueStats(durations),
          audioScheduleGap: valueStats(scheduleGaps),
          audioUnderrunGap: valueStats(underrunGaps),
          audioLead: valueStats(audio.scheduleLeadMs || []),
          worst: {
            raf: worstIntervals(p.frames.raf, 6),
            repaint: worstIntervals(p.frames['renderer.repaint'], 6),
            visualBitblt: worstIntervals(p.frames['visual.bitblt'], 6),
            visualFrames: worstIntervals(coalescedFrames(p.frames['visual.bitblt'], 5), 6),
            audioSubmit: worstIntervals(p.frames['audio.startCall'], 6),
          },
        };
      })(),
      threadSleepIntervals: threadSleepIntervals(),
      eipRanges: eipRangeOut(),
      schedulerLead: window.__waProfileSchedulerLead ? {
        quantumSteps: window.__waProfileSchedulerLead.quantumSteps,
        lowWallMs: window.__waProfileSchedulerLead.lowWallMs,
        highWallMs: window.__waProfileSchedulerLead.highWallMs,
        leadThresholdMs: window.__waProfileSchedulerLead.leadThresholdMs,
        samples: (window.__waProfileSchedulerLead.samples || []).slice(-240),
      } : null,
      samples: p.samples || {},
      threads: Object.fromEntries(Object.entries(p.threads || {}).map(([tid, t]) => [tid, {
        tid: t.tid | 0,
        handle: t.handle >>> 0,
        startAddr: t.startAddr >>> 0,
        param: t.param >>> 0,
        runs: t.runs | 0,
        steps: t.steps | 0,
        totalMs: round(t.totalMs),
        maxMs: round(t.maxMs),
        hotAudioMs: round(t.hotAudioMs),
        audioHostMs: round(t.audioHostMs),
        gdiHostMs: round(t.gdiHostMs),
        hostMs: round(t.hostMs),
        sleepYields: t.sleepYields | 0,
        sleepMsTotal: round(t.sleepMsTotal),
        sleepMsMax: round(t.sleepMsMax),
        sleepMsAvg: t.sleepYields ? round(t.sleepMsTotal / t.sleepYields) : 0,
        sleepMsHist: sleepHistOut(t.sleepMsHist),
        audioEvents: t.audioEvents | 0,
        gdiEvents: t.gdiEvents | 0,
        lastEip: t.lastEip >>> 0,
        lastYield: t.lastYield >>> 0,
        state: t.state || '',
      }])),
      hostEvents: counterOut(p.hostEvents),
    });
    const threadEntry = (tid) => {
      const key = String((tid || 0) | 0);
      return p.threads[key] || (p.threads[key] = {
        tid: (tid || 0) | 0,
        handle: 0,
        startAddr: 0,
        param: 0,
        runs: 0,
        steps: 0,
        totalMs: 0,
        maxMs: 0,
        hotAudioMs: 0,
        audioHostMs: 0,
        gdiHostMs: 0,
        hostMs: 0,
        sleepYields: 0,
        sleepMsTotal: 0,
        sleepMsMax: 0,
        sleepMsHist: Object.create(null),
        audioEvents: 0,
        gdiEvents: 0,
        lastEip: 0,
        lastYield: 0,
        state: '',
      });
    };
    window.__waProfileThreadRun = (info) => {
      info = info || {};
      const dt = Number(info.elapsedMs) || 0;
      const tid = (info.tid || 0) | 0;
      const t = threadEntry(tid);
      t.handle = info.handle >>> 0;
      t.startAddr = info.startAddr >>> 0;
      t.param = info.param >>> 0;
      t.runs++;
      t.steps += (info.steps || 0) | 0;
      t.totalMs += dt;
      if (dt > t.maxMs) t.maxMs = dt;
      if (info.hotAudio) t.hotAudioMs += dt;
      if (info.sleepYielded) {
        const ms = info.sleepMs >>> 0;
        t.sleepYields++;
        t.sleepMsTotal += ms;
        if (ms > t.sleepMsMax) t.sleepMsMax = ms;
        t.sleepMsHist[String(ms)] = (t.sleepMsHist[String(ms)] || 0) + 1;
        add('thread.sleepYield', ms, info);
        add('thread.T' + tid + '.sleepYield', ms, info);
        pushFrame('thread.T' + tid + '.sleep', performance.now() - p.t0, {
          ms,
          eipAfter: info.eipAfter >>> 0,
          hotAudio: !!info.hotAudio,
        });
      }
      t.lastEip = info.eipAfter >>> 0;
      t.lastYield = info.yieldReason >>> 0;
      t.state = info.state || t.state || '';
      add('thread.run', dt, info);
      add('thread.T' + tid, dt, info);
      if (info.hotAudio) add('thread.audioHot', dt, info);
    };
    window.__waProfileHostEvent = (ev) => {
      ev = ev || {};
      const dt = Number(ev.elapsedMs) || 0;
      const name = ev.name || 'host';
      const c = p.hostEvents[name] || (p.hostEvents[name] = { count: 0, total: 0, max: 0 });
      c.count++; c.total += dt; if (dt > c.max) c.max = dt;
      add(name, dt, ev.data || null);
      const tid = (ev.threadId || 0) | 0;
      const t = threadEntry(tid);
      t.hostMs += dt;
      if (/^(audio\\.|host\\.waveOut)/.test(name)) {
        t.audioHostMs += dt;
        t.audioEvents++;
      }
      if (/^gdi\\./.test(name)) {
        t.gdiHostMs += dt;
        t.gdiEvents++;
      }
      if (name === 'gdi.bitblt') {
        const at = performance.now() - p.t0;
        pushFrame('gdi.bitblt', at, Object.assign({ threadId: tid, dtMs: round(dt) }, ev.data || {}));
        if (tid === 1) {
          pushFrame('visual.bitblt', at, Object.assign({ threadId: tid, dtMs: round(dt) }, ev.data || {}));
        }
      }
    };
    if (!window.__waProfileRafInstalled) {
      window.__waProfileRafInstalled = true;
      const tick = ts => {
        const profile = window.__waProfile;
        if (profile && profile.frames) {
          pushFrame('raf', ts - profile.t0, null);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
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
          const dt = performance.now() - t;
          add(name, dt, { arg0: args[0], ret: ret || null });
          if (name === 'renderer.repaint') {
            pushFrame('renderer.repaint', performance.now() - p.t0, { dtMs: round(dt) });
          }
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
    window.__waWindowTrace = [];
    const origCreateWindow = Win98Renderer.prototype.createWindow;
    if (origCreateWindow && !origCreateWindow.__waWindowTraced) {
      Win98Renderer.prototype.createWindow = function(hwnd, style, x, y, cx, cy, title, menuId, wasm, wasmMemory) {
        const ret = origCreateWindow.apply(this, arguments);
        const win = this.windows && this.windows[hwnd];
        window.__waWindowTrace.push({
          name: 'createWindow',
          hwnd: hwnd >>> 0,
          title: title || '',
          style: style >>> 0,
          x: x | 0,
          y: y | 0,
          cx: cx | 0,
          cy: cy | 0,
          final: win ? { x: win.x | 0, y: win.y | 0, w: win.w | 0, h: win.h | 0, visible: !!win.visible } : null,
          at: +(performance.now() - window.__waProfile.t0).toFixed(1),
        });
        if (window.__waWindowTrace.length > 200) window.__waWindowTrace.shift();
        return ret;
      };
      Win98Renderer.prototype.createWindow.__waWindowTraced = true;
    }
    wrap(ThreadManager.prototype, 'checkMainYield', 'thread.checkMainYield');
    wrap(ThreadManager.prototype, 'runSlice', 'thread.runSlice');
  })()`);
  progress('profiling hooks installed');

  await evalExpr(`(() => {
    window.__waAudioProbe = {
      starts: 0,
      startTimes: [],
      startCallTimes: [],
      scheduleLeadMs: [],
      bufferDurationsMs: [],
      peaks: [],
      resumes: 0,
      resumeStates: [],
    };
    const srcProto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
    if (srcProto && srcProto.start && !srcProto.start.__waProfiled) {
      const orig = srcProto.start;
      srcProto.start = function(...args) {
        const profile = window.__waProfile;
        const at = profile ? performance.now() - profile.t0 : 0;
        const when = args[0] == null ? null : +args[0];
        const currentTime = this.context && Number.isFinite(this.context.currentTime) ? this.context.currentTime : null;
        const leadMs = when !== null && currentTime !== null ? (when - currentTime) * 1000 : null;
        const durationMs = this.buffer && Number.isFinite(this.buffer.duration) ? this.buffer.duration * 1000 : null;
        window.__waAudioProbe.starts++;
        window.__waAudioProbe.startTimes.push(when);
        window.__waAudioProbe.startCallTimes.push(+at.toFixed(3));
        if (Number.isFinite(leadMs)) window.__waAudioProbe.scheduleLeadMs.push(+leadMs.toFixed(3));
        if (Number.isFinite(durationMs)) window.__waAudioProbe.bufferDurationsMs.push(+durationMs.toFixed(3));
        if (profile && profile.frames) {
          const arr = profile.frames['audio.startCall'] || (profile.frames['audio.startCall'] = []);
          arr.push({
            t: +at.toFixed(3),
            data: {
              when,
              leadMs: Number.isFinite(leadMs) ? +leadMs.toFixed(3) : null,
              durationMs: Number.isFinite(durationMs) ? +durationMs.toFixed(3) : null,
            },
          });
          if (arr.length > 5000) arr.splice(0, arr.length - 5000);
        }
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
    await evalExpr(`(() => {
      if (window.__waResetProfile) window.__waResetProfile('audio-playback');
      return 1;
    })()`);
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
        profile: window.__waProfileSnapshot ? window.__waProfileSnapshot() : null,
        playSnapshots: ${JSON.stringify(playSnapshots)},
        voices: voiceMap,
        windows: Object.values((window.sharedRenderer || wine.renderer).windows)
          .filter(w => w && w.visible)
          .map(w => ({ hwnd: w.hwnd, title: w.title || '', x: w.x, y: w.y, w: w.w, h: w.h })),
      };
    })()`);
    if (DUMP_CONSOLE) result.consoleEvents = consoleEventSummary(cdp.events);
    console.log(JSON.stringify(compactProfileResult(result), null, 2));
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
      if (p.profileReset !== undefined) {
        progress(`profile reset ${p.profileReset}`);
        await evalExpr(`(() => {
          if (window.__waResetProfile) window.__waResetProfile(${JSON.stringify(p.profileReset)});
          return 1;
        })()`);
        postClickSnapshots.push({ action: 'profile-reset', label: p.profileReset });
        continue;
      }
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
      if (p.postCmd !== undefined) {
        progress(`posted WM_COMMAND ${p.postCmd}`);
        await evalExpr(`(() => {
          const app = runningApps[0];
          const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
          if (!e || !e.post_message_q || !e.get_main_hwnd) return 0;
          e.post_message_q(e.get_main_hwnd(), 0x0111, ${p.postCmd} >>> 0, 0);
          return e.get_main_hwnd() >>> 0;
        })()`);
        await wait(POST_CLICK_WAIT_MS);
        postClickSnapshots.push(await evalExpr(`(() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const shared = wine && wine._sharedAudio;
          const voices = shared && shared.voices;
          const ac = (voices && voices._ac) || (wine && wine._audioCtx);
          const e = wine && wine.instance && wine.instance.exports;
          return {
            action: 'post-cmd',
            cmd: ${p.postCmd} >>> 0,
            mainHwnd: e && e.get_main_hwnd ? (e.get_main_hwnd() >>> 0) : 0,
            starts: window.__waAudioProbe && window.__waAudioProbe.starts,
            currentTime: ac ? +ac.currentTime.toFixed(3) : null,
            openHandles: shared && shared.waveOutOpenHandles && shared.waveOutOpenHandles.size,
            pendingWaveDoneCount: shared && (shared.pendingWaveDoneCount || 0),
            voiceCount: voices && voices._map ? Object.keys(voices._map).length : 0,
          };
        })()`));
        continue;
      }
      if (p.timerInterval) {
        progress(`timer interval hwnd 0x${p.hwnd.toString(16)} -> ${p.intervalMs}ms`);
        postClickSnapshots.push(await evalExpr(`(() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const memory = wine && wine.memory;
          const dv = memory ? new DataView(memory.buffer) : null;
          const updated = [];
          if (dv) {
            for (let slot = 0; slot < 16; slot++) {
              const base = 0xAC00 + slot * 20;
              if (base + 20 > dv.byteLength) break;
              const id = dv.getUint32(base + 4, true) >>> 0;
              if (!id) continue;
              const hwnd = dv.getUint32(base, true) >>> 0;
              if (hwnd === (${p.hwnd} >>> 0)) {
                const before = dv.getUint32(base + 8, true) >>> 0;
                dv.setUint32(base + 8, ${p.intervalMs} >>> 0, true);
                updated.push({ slot, hwnd, id, before, after: dv.getUint32(base + 8, true) >>> 0 });
              }
            }
          }
          return {
            action: 'timer-interval',
            hwnd: ${p.hwnd} >>> 0,
            intervalMs: ${p.intervalMs} >>> 0,
            updated,
          };
        })()`));
        continue;
      }
      if (p.guest8) {
        progress(`guest8 0x${p.addr.toString(16)} -> ${p.value}`);
        postClickSnapshots.push(await evalExpr(`(() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const e = wine && wine.instance && wine.instance.exports;
          const memory = wine && wine.memory;
          const dv = memory ? new DataView(memory.buffer) : null;
          const imageBase = e && e.get_image_base ? (e.get_image_base() >>> 0) : 0;
          const guestBase = e && e.get_guest_base ? (e.get_guest_base() >>> 0) : 0x12000;
          const wa = (((${p.addr} >>> 0) - imageBase + guestBase) >>> 0);
          const before = dv && imageBase && wa < dv.byteLength ? (dv.getUint8(wa) >>> 0) : null;
          if (dv && imageBase && wa < dv.byteLength) dv.setUint8(wa, ${p.value} & 0xff);
          const after = dv && imageBase && wa < dv.byteLength ? (dv.getUint8(wa) >>> 0) : null;
          return {
            action: 'guest8',
            addr: ${p.addr} >>> 0,
            value: ${p.value} & 0xff,
            before,
            after,
          };
        })()`));
        continue;
      }
      if (p.clearWorkerCache) {
        progress(`clear worker cache ${p.tid ? 'T' + p.tid : 'all'}`);
        postClickSnapshots.push(await evalExpr(`(() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const tm = wine && wine.threadManager;
          const cleared = [];
          if (tm && typeof tm._clearWorkerCacheSlot === 'function') {
            const max = tm._maxWorkerThreads || 7;
            const target = ${p.tid | 0};
            for (let tid = 1; tid <= max; tid++) {
              if (target && tid !== target) continue;
              tm._clearWorkerCacheSlot(tid);
              cleared.push(tid);
            }
          }
          return {
            action: 'clear-worker-cache',
            tid: ${p.tid | 0},
            cleared,
          };
        })()`));
        continue;
      }
      if (p.traceEip) {
        progress(`trace eip ${p.label} ${p.tid == null ? 'all' : 'T' + p.tid} 0x${p.lo.toString(16)}-0x${p.hi.toString(16)}`);
        postClickSnapshots.push(await evalExpr(`(() => {
          const app = runningApps[0];
          const wine = app && app.wine;
          const tm = wine && wine.threadManager;
          const armed = [];
          const arm = (tid, ex) => {
            if (!ex || !ex.set_trace_eip_range) return;
            if (${p.tid == null ? 'false' : `(${p.tid} !== (tid | 0))`}) return;
            ex.set_trace_eip_range(1, ${p.lo} >>> 0, ${p.hi} >>> 0);
            armed.push(tid | 0);
          };
          if (window.__waProfileAddEipRange) {
            window.__waProfileAddEipRange(${JSON.stringify(p.label)}, ${p.tid == null ? 'null' : p.tid}, ${p.lo} >>> 0, ${p.hi} >>> 0);
          }
          arm(0, wine && wine.instance && wine.instance.exports);
          if (tm && tm.threads) {
            for (const t of tm.threads.values()) {
              arm(t.tid | 0, t.instance && t.instance.exports);
            }
          }
          return {
            action: 'trace-eip',
            label: ${JSON.stringify(p.label)},
            tid: ${p.tid == null ? 'null' : p.tid},
            lo: ${p.lo} >>> 0,
            hi: ${p.hi} >>> 0,
            armed,
          };
        })()`));
        continue;
      }
      if (p.schedulerHot) {
        progress(`scheduler hot quantum=${p.quantumSteps} maxWall=${p.maxWallMs}ms`);
        postClickSnapshots.push(await evalExpr(`(() => {
          window.__waProfileSchedulerHot = {
            quantumSteps: ${p.quantumSteps} | 0,
            maxWallMs: ${p.maxWallMs} | 0,
          };
          if (window.ThreadManager && !ThreadManager.prototype.runBudgeted.__waSchedulerHotProfiled) {
            const origRunBudgeted = ThreadManager.prototype.runBudgeted;
            ThreadManager.prototype.runBudgeted = function(options) {
              const tuning = window.__waProfileSchedulerHot;
              if (tuning && options && options.prioritizeAudioThreads) {
                options = Object.assign({}, options);
                if (tuning.quantumSteps > 0) options.quantumSteps = tuning.quantumSteps;
                if (tuning.maxWallMs > 0) options.maxWallMs = tuning.maxWallMs;
              }
              return origRunBudgeted.call(this, options);
            };
            ThreadManager.prototype.runBudgeted.__waSchedulerHotProfiled = true;
          }
          return {
            action: 'scheduler-hot',
            quantumSteps: window.__waProfileSchedulerHot.quantumSteps,
            maxWallMs: window.__waProfileSchedulerHot.maxWallMs,
          };
        })()`));
        continue;
      }
      if (p.schedulerLead) {
        progress(`scheduler lead quantum=${p.quantumSteps} wall=${p.lowWallMs}/${p.highWallMs}ms threshold=${p.leadThresholdMs}ms`);
        postClickSnapshots.push(await evalExpr(`(() => {
          window.__waProfileSchedulerLead = {
            quantumSteps: ${p.quantumSteps} | 0,
            lowWallMs: ${p.lowWallMs} | 0,
            highWallMs: ${p.highWallMs} | 0,
            leadThresholdMs: ${p.leadThresholdMs} | 0,
            samples: [],
          };
          const leadMs = () => {
            const app = runningApps[0];
            const wine = app && app.wine;
            const shared = wine && wine._sharedAudio;
            const voices = shared && shared.voices;
            const ac = (voices && voices._ac) || (wine && wine._audioCtx);
            if (!voices || !voices._map || !ac || !Number.isFinite(ac.currentTime)) return 0;
            let best = 0;
            for (const v of Object.values(voices._map)) {
              if (!v || !Number.isFinite(v.nextTime)) continue;
              best = Math.max(best, (v.nextTime - ac.currentTime) * 1000);
            }
            return Math.max(0, best);
          };
          if (window.ThreadManager && !ThreadManager.prototype.runBudgeted.__waSchedulerLeadProfiled) {
            const origRunBudgeted = ThreadManager.prototype.runBudgeted;
            ThreadManager.prototype.runBudgeted = function(options) {
              const tuning = window.__waProfileSchedulerLead;
              if (tuning && options && options.prioritizeAudioThreads) {
                const lead = leadMs();
                options = Object.assign({}, options);
                if (tuning.quantumSteps > 0) options.quantumSteps = tuning.quantumSteps;
                options.maxWallMs = lead >= tuning.leadThresholdMs ? tuning.highWallMs : tuning.lowWallMs;
                if (tuning.samples.length < 2000) {
                  tuning.samples.push({
                    at: +(performance.now() - (window.__waProfile ? window.__waProfile.t0 : 0)).toFixed(1),
                    leadMs: +lead.toFixed(3),
                    maxWallMs: options.maxWallMs,
                  });
                }
              }
              return origRunBudgeted.call(this, options);
            };
            ThreadManager.prototype.runBudgeted.__waSchedulerLeadProfiled = true;
          }
          return {
            action: 'scheduler-lead',
            quantumSteps: window.__waProfileSchedulerLead.quantumSteps,
            lowWallMs: window.__waProfileSchedulerLead.lowWallMs,
            highWallMs: window.__waProfileSchedulerLead.highWallMs,
            leadThresholdMs: window.__waProfileSchedulerLead.leadThresholdMs,
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
      const read32 = (guestPtr) => {
        if (!dv || !guestPtr || guestPtr === 0xffffffff || !imageBase) return 0;
        const wa = g2w(guestPtr);
        if (wa + 4 > dv.byteLength) return 0;
        return dv.getUint32(wa, true) >>> 0;
      };
      const read8 = (guestPtr) => {
        if (!dv || !guestPtr || guestPtr === 0xffffffff || !imageBase) return 0;
        const wa = g2w(guestPtr);
        if (wa >= dv.byteLength) return 0;
        return dv.getUint8(wa) >>> 0;
      };
      const childrenOf = (hwnd) => {
        if (!e || !e.wnd_next_child_slot || !e.wnd_slot_hwnd) return [];
        const readControlText = (fn, hwnd, idx) => {
          if (!e || !e.guest_alloc || !e[fn]) return '';
          const buf = e.guest_alloc(256) >>> 0;
          const len = fn === 'listbox_get_item_text'
            ? (e[fn](hwnd, idx, buf, 256) | 0)
            : (e[fn](hwnd, buf, 256) | 0);
          const text = len > 0 ? readStr(buf, Math.min(255, len + 1)) : '';
          if (e.guest_free) e.guest_free(buf);
          return text;
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
            const base = 0x07F00000 + i * 32;
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
            text: cls === 1 ? readControlText('button_get_text', ch, 0) : undefined,
            listbox: cls === 4 ? listboxInfo(ch) : undefined,
            combobox: cls === 5 ? comboboxInfo(ch) : undefined,
          });
          s++;
        }
        return out;
      };
      const visModule = read32(0x458c78);
      const timerTable = (() => {
        const out = [];
        if (!dv) return out;
        for (let slot = 0; slot < 16; slot++) {
          const base = 0xAC00 + slot * 20;
          if (base + 20 > dv.byteLength) break;
          const id = dv.getUint32(base + 4, true) >>> 0;
          if (!id) continue;
          out.push({
            slot,
            hwnd: dv.getUint32(base, true) >>> 0,
            id,
            intervalMs: dv.getUint32(base + 8, true) >>> 0,
            lastTick: dv.getUint32(base + 12, true) >>> 0,
            callback: dv.getUint32(base + 16, true) >>> 0,
          });
        }
        return out;
      })();
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
            profile: window.__waProfileSnapshot ? window.__waProfileSnapshot() : null,
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
              threadId: read32(0x4595a4),
              threadHandle: read32(0x4595ac),
              pluginModule: read32(0x458c78),
              stopRequested: read32(0x459584),
              stopInProgress: read32(0x459810),
              visDataThreadHandle: read32(0x45805c),
              visDataThreadStop: read32(0x458060),
            },
            winampVisRuntime: {
              timerTable,
              visualizerTimers: timerTable.filter(t => t.hwnd === 0x20001 || t.hwnd === 0x20000),
              visualDivider: read8(0x449e65),
              visualDividerCounter: read32(0x458080),
              visualUpdatePtr: read32(0x449e78),
              visualUpdateAltPtr: read32(0x449e84),
              visualUpdateAge: read32(0x449e88),
              visualUpdateMode: read32(0x449e8c),
              renderPending: read32(0x4595b0),
              playbackState1: read32(0x451604),
              playbackState2: read32(0x451608),
              pluginModule: visModule,
              moduleLatencyMs: visModule ? read32(visModule + 0x14) : 0,
              moduleDelayMs: visModule ? read32(visModule + 0x18) : 0,
              moduleSpectrumNch: visModule ? read32(visModule + 0x1c) : 0,
              moduleWaveformNch: visModule ? read32(visModule + 0x20) : 0,
              moduleRenderPtr: visModule ? read32(visModule + 0x92c) : 0,
            },
            mainThread: {
              eip: e && e.get_eip ? (e.get_eip() >>> 0) : 0,
              esp: e && e.get_esp ? (e.get_esp() >>> 0) : 0,
              eax: e && e.get_eax ? (e.get_eax() >>> 0) : 0,
              yieldReason: e && e.get_yield_reason ? (e.get_yield_reason() >>> 0) : 0,
              waitHandle: e && e.get_wait_handle ? (e.get_wait_handle() >>> 0) : 0,
              waitTimeout: e && e.get_wait_timeout ? (e.get_wait_timeout() >>> 0) : 0,
              waitStackBytes: e && e.get_wait_stack_bytes ? (e.get_wait_stack_bytes() >>> 0) : 0,
            },
            memoryRegions: {
              imageBase,
              guestBase,
              heapBase: e && e.get_heap_base ? (e.get_heap_base() >>> 0) : 0,
              heapPtr: e && e.get_heap_ptr ? (e.get_heap_ptr() >>> 0) : 0,
              threadAlloc: e && e.get_thread_alloc ? (e.get_thread_alloc() >>> 0) : 0,
              byteLength: wine && wine.memory ? wine.memory.buffer.byteLength : 0,
            },
	        visibleWindows: Object.values((r && r.windows) || {})
	          .filter(w => w && w.visible)
	          .map(w => ({
	            hwnd: w.hwnd >>> 0,
	            title: w.title || '',
	            x: w.x, y: w.y, w: w.w, h: w.h,
                client: w.clientRect || null,
                wat: (() => {
                  const ex = (w.wasm && w.wasm.exports) || e;
                  if (!ex) return null;
                  return {
                    x: ex.wnd_window_screen_x ? (ex.wnd_window_screen_x(w.hwnd >>> 0) | 0) : null,
                    y: ex.wnd_window_screen_y ? (ex.wnd_window_screen_y(w.hwnd >>> 0) | 0) : null,
                    w: ex.wnd_screen_w ? (ex.wnd_screen_w(w.hwnd >>> 0) | 0) : null,
                    h: ex.wnd_screen_h ? (ex.wnd_screen_h(w.hwnd >>> 0) | 0) : null,
                    cl: ex.get_client_rect_l ? (ex.get_client_rect_l(w.hwnd >>> 0) | 0) : null,
                    ct: ex.get_client_rect_t ? (ex.get_client_rect_t(w.hwnd >>> 0) | 0) : null,
                    cr: ex.get_client_rect_r ? (ex.get_client_rect_r(w.hwnd >>> 0) | 0) : null,
                    cb: ex.get_client_rect_b ? (ex.get_client_rect_b(w.hwnd >>> 0) | 0) : null,
                  };
                })(),
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
          windowTrace: (window.__waWindowTrace || []).slice(-80),
        };
    })()`);
    if (DUMP_CONSOLE) result.consoleEvents = consoleEventSummary(cdp.events);
    console.log(JSON.stringify(compactProfileResult(result), null, 2));
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
    if (r.repaint) r.repaint();
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
      const left = Math.max(0, x | 0);
      const top = Math.max(0, y | 0);
      const right = Math.min(canvas.width | 0, (x + w) | 0);
      const bottom = Math.min(canvas.height | 0, (y + h) | 0);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      if (!width || !height) return null;
      const data = canvas.getContext('2d').getImageData(left, top, width, height).data;
      const colors = new Set();
      let ink = 0;
      for (let i = 0; i < data.length; i += 16) {
        const a = data[i + 3];
        if (!a) continue;
        const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        colors.add(rgb);
        if (rgb !== 0xc0c0c0 && rgb !== 0x000000 && rgb !== 0xffffff) ink++;
      }
      return { x: left, y: top, w: width, h: height, sampledColors: colors.size, sampledInk: ink };
    };
    window.__waProfile.creditsSnapshot = Object.values(r.windows)
      .filter(w => w && w.visible)
      .map(w => {
        const pos = r._windowOriginForComposite(w);
        return {
          hwnd: w.hwnd,
          title: w.title || '',
          x: w.x, y: w.y, w: w.w, h: w.h,
          isDialog: !!w.isDialog,
          isChild: !!w.isChild,
          parentHwnd: w.parentHwnd || 0,
          back: sampleCanvas(w._backCanvas),
          screen: sampleRect(r.canvas, pos.x, pos.y, w.w, w.h),
        };
      });
    const e = runningApps[0].wine.instance.exports;
    window.__waProfile.workerHandlesAtCredits = {
      about: e.guest_read32(0x44f8f8) >>> 0,
      credits: e.guest_read32(0x44f8f4) >>> 0,
    };
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
    if (r.repaint) r.repaint();
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
      const left = Math.max(0, x | 0);
      const top = Math.max(0, y | 0);
      const right = Math.min(canvas.width | 0, (x + w) | 0);
      const bottom = Math.min(canvas.height | 0, (y + h) | 0);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      if (!width || !height) return null;
      const data = canvas.getContext('2d').getImageData(left, top, width, height).data;
      const colors = new Set();
      let ink = 0;
      for (let i = 0; i < data.length; i += 16) {
        const a = data[i + 3];
        if (!a) continue;
        const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        colors.add(rgb);
        if (rgb !== 0xc0c0c0 && rgb !== 0x000000 && rgb !== 0xffffff) ink++;
      }
      return { x: left, y: top, w: width, h: height, sampledColors: colors.size, sampledInk: ink };
    };
    const out = {
      marks: p.marks,
      counters: {},
      samples: p.samples,
      creditsSnapshot: p.creditsSnapshot || null,
      workerHandlesAtCredits: p.workerHandlesAtCredits || null,
    };
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
      visibleWindows: Object.values(r.windows).filter(w => w && w.visible).map(w => {
        const pos = r._windowOriginForComposite(w);
        return {
          hwnd: w.hwnd,
          title: w.title || '',
          x: w.x, y: w.y, w: w.w, h: w.h,
          isDialog: !!w.isDialog,
          isAboutDialog: !!w.isAboutDialog,
          isChild: !!w.isChild,
          parentHwnd: w.parentHwnd || 0,
          back: sampleCanvas(w._backCanvas),
          screen: sampleRect(r.canvas, pos.x, pos.y, w.w, w.h),
        };
      }),
      workerHandles: {
        about: runningApps[0].wine.instance.exports.guest_read32(0x44f8f8) >>> 0,
        credits: runningApps[0].wine.instance.exports.guest_read32(0x44f8f4) >>> 0,
      },
    };
    return out;
  })()`, 5000);

  if (DUMP_CONSOLE) result.consoleEvents = consoleEventSummary(cdp.events);
  console.log(JSON.stringify(result, null, 2));
  await saveScreenshot();
  cdp.close();
  cleanup();
}

main().catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});
