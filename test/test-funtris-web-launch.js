#!/usr/bin/env node
// Browser launch/gameplay regression for Funtris.
//
// This exercises index.html, not only the Node e2e harness: select Funtris in
// the page, call launchApp(), verify startup dialogs are dismissed, then start
// a new game through the real browser page's running app instance.

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
const PORT = Number(process.env.FUNTRIS_WEB_PORT || 8879);
const DEBUG_PORT = Number(process.env.FUNTRIS_WEB_DEBUG_PORT || 9339);

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Funtris browser launch test');
  process.exit(0);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += d.toString(); });

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-funtris-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userData}`,
    `http://127.0.0.1:${PORT}/index.html?debug&funtris-web=${Date.now()}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { server.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  let page;
  for (let i = 0; i < 100; i++) {
    try {
      const pages = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      page = pages.find(p => p.type === 'page' && String(p.url || '').includes('/index.html'));
      if (page) break;
    } catch (_) {}
    await wait(100);
  }
  assert(page, 'Chrome page did not appear\nchrome:\n' + chromeErr.slice(-4000) + '\nserver:\n' + serverErr.slice(-1000));

  const cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  try { await cdp.send('Log.enable'); } catch (_) {}

  async function evalExpr(expression, timeoutMs = 10000) {
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime.evaluate timeout')), timeoutMs));
    const result = await Promise.race([cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }), timer]);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    }
    return result.result && result.result.value;
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
          typeof launchApp === 'function') resolve(1);
      else if (performance.now() - started > 10000) reject(new Error('page globals not ready'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 12000);

  await evalExpr(`(() => {
    localStorage.clear();
    document.getElementById('app-select').value = 'funtris';
    return launchApp();
  })()`, 30000);

  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      const app = runningApps && runningApps[0];
      const wins = Object.values((sharedRenderer && sharedRenderer.windows) || {}).filter(w => w && w.visible);
      if (app && app.wine && app.wine.instance && wins.length) resolve(1);
      else if (performance.now() - started > 20000) reject(new Error('Funtris visible window did not appear'));
      else setTimeout(tick, 100);
    };
    tick();
  })`, 22000);
  // Funtris opens on a modal "Version 1.0" splash and does not create its game
  // window until that is acknowledged, so the splash has to be clicked -- it
  // never times out. test/test-funtris-new-game.js clicks the same button.
  // Find OK by walking the dialog's children rather than hardcoding a point,
  // so a layout change fails the click instead of silently missing it.
  const dismissed = await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      const app = runningApps[0];
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      const dlg = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .find(w => w && w.visible && w.isDialog && /^Funtris$/i.test(w.title || ''));
      if (e && dlg) {
        let slot = 0;
        let hwnd = 0;
        while ((slot = e.wnd_next_child_slot(dlg.hwnd, slot) | 0) >= 0) {
          const child = e.wnd_slot_hwnd(slot) | 0;
          slot++;
          if (child && (e.ctrl_get_id(child) | 0) === 1) { hwnd = child; break; }
        }
        if (hwnd) {
          if (sharedRenderer._computeClientRect) sharedRenderer._computeClientRect(dlg);
          const client = dlg.clientRect || { x: dlg.x + 3, y: dlg.y + 23 };
          const xy = e.ctrl_get_xy(hwnd) | 0;
          const wh = e.ctrl_get_wh(hwnd) | 0;
          const cx = client.x + (xy & 0xffff) + ((wh & 0xffff) >> 1);
          const cy = client.y + (xy >>> 16) + ((wh >>> 16) >> 1);
          sharedRenderer.handleMouseDown(cx, cy, 0);
          resolve({ hwnd, cx, cy });
          return;
        }
      }
      if (performance.now() - started > 8000) reject(new Error('Funtris startup dialog had no OK button'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 10000);
  // Press and release have to land in separate slices with the guest running
  // in between; a synchronous down+up never lets the button see the press.
  await new Promise(r => setTimeout(r, 250));
  await evalExpr(`(() => {
    sharedRenderer.handleMouseUp(${dismissed.cx}, ${dismissed.cy}, 0);
    return 1;
  })()`);
  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      const wins = Object.values((sharedRenderer && sharedRenderer.windows) || {});
      const main = wins.find(w => w && w.visible && !w.isDialog && /^Funtris$/i.test(w.title || ''));
      const startupDlg = wins.find(w => w && w.visible && w.isDialog && /^Funtris$/i.test(w.title || ''));
      if (main && !startupDlg) resolve(1);
      else if (performance.now() - started > 8000) reject(new Error('Funtris startup dialog was not dismissed'));
      else setTimeout(tick, 50);
    };
    tick();
  })`, 10000);

  // The game window exists as soon as the splash closes, but New Game is only
  // meaningful once the playfield has been painted -- commanding it earlier
  // leaves the board half-built and the falling brick never shows.
  await evalExpr(`new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      const canvas = document.getElementById('screen');
      if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
      const data = canvas.getContext('2d').getImageData(70, 60, 140, 255).data;
      let black = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (!data[i] && !data[i + 1] && !data[i + 2]) black++;
      }
      if (black > 20000) resolve(black);
      else if (performance.now() - started > 8000) reject(new Error('Funtris playfield never painted, black=' + black));
      else setTimeout(tick, 100);
    };
    tick();
  })`, 10000);

  // A tetromino is whatever colour the game picked for it, so counting a
  // specific colour measures the shuffle, not the game. This counts saturated
  // pixels -- anything whose channels are far enough apart to not be part of
  // the black playfield or the grey chrome around it. Funtris' pieces are
  // drawn with lit and shadowed bevels, so a piece contributes several shades
  // of one hue and all of them count. The narrower predicate this replaces
  // scored a correctly drawn green piece at 68 against a threshold of 100,
  // which is most of why this test was unreliable.
  await evalExpr(`(() => {
    window.PLAYFIELD = { x0: 70, y0: 60, x1: 210, y1: 315 };
    window.countPlayfieldInk = () => {
      const canvas = document.getElementById('screen');
      const r = window.PLAYFIELD;
      const w = Math.min(r.x1, canvas.width) - r.x0;
      const h = Math.min(r.y1, canvas.height) - r.y0;
      if (w <= 0 || h <= 0) return 0;
      const data = canvas.getContext('2d').getImageData(r.x0, r.y0, w, h).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        const max = Math.max(data[i], data[i + 1], data[i + 2]);
        const min = Math.min(data[i], data[i + 1], data[i + 2]);
        if (max - min > 30) ink++;
      }
      return ink;
    };
    return 1;
  })()`);

  // What an empty playfield looks like, measured the same way as the piece
  // below. A brick count only means "a brick appeared" if the same count was
  // zero a moment earlier -- otherwise a chrome change anywhere in the rect
  // reads as gameplay.
  const inkBefore = await evalExpr(`(() => {
    if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
    return countPlayfieldInk();
  })()`);

  await evalExpr(`(() => {
    const app = runningApps[0];
    const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
    if (!e || !e.post_message_q || !e.get_main_hwnd) throw new Error('post_message_q unavailable');
    e.post_message_q(e.get_main_hwnd(), 0x0111, 40001, 0);
    return 1;
  })()`);
  const result = await evalExpr(`new Promise(resolve => {
    const started = performance.now();
    const sample = () => {
      const r = sharedRenderer;
      const windows = Object.values((r && r.windows) || {})
        .filter(w => w && w.visible)
        .map(w => ({
          hwnd: w.hwnd >>> 0,
          title: w.title || '',
          x: w.x | 0,
          y: w.y | 0,
          w: w.w | 0,
          h: w.h | 0,
          isChild: !!w.isChild,
          isDialog: !!w.isDialog,
        }));
      const canvas = document.getElementById('screen');
      if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const count = (rect, pred) => {
        let n = 0;
        for (let y = rect.y0; y < Math.min(rect.y1, canvas.height); y++) {
          for (let x = rect.x0; x < Math.min(rect.x1, canvas.width); x++) {
            const i = (y * canvas.width + x) * 4;
            if (pred(data[i], data[i + 1], data[i + 2])) n++;
          }
        }
        return n;
      };
      const playfieldBlack = count({ x0: 70, y0: 60, x1: 210, y1: 315 },
        (r, g, b) => r === 0 && g === 0 && b === 0);
      const fallingBrick = countPlayfieldInk();
      const result = {
        status: document.getElementById('status').textContent,
        log: document.getElementById('log').textContent.slice(-3000),
        registry: localStorage.getItem('reg:HKCU\\\\Software\\\\Funpack Software\\\\Funtris\\\\Options'),
        windows,
        runningApps: runningApps.length,
        playfieldBlack,
        fallingBrick,
      };
      if ((playfieldBlack > 20000 && fallingBrick > 100) || performance.now() - started > 10000) {
        // A failure here is "the board never started", which is invisible in
        // a pixel count. Carry the frame out with it.
        result.screen = document.getElementById('screen').toDataURL('image/png');
        resolve(result);
      } else {
        setTimeout(sample, 100);
      }
    };
    sample();
  })`, 12000);
  result.consoleEvents = consoleEventSummary(cdp.events);
  cdp.close();

  const shotDir = path.join(ROOT, 'scratch', 'funtris-web');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, 'new-game.png');
  if (result.screen) {
    fs.writeFileSync(shot, Buffer.from(result.screen.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }
  delete result.screen;

  const titles = result.windows.map(w => w.title).join(', ');
  const resultSummary = JSON.stringify({
    windows: result.windows,
    registry: result.registry,
    black: result.playfieldBlack,
    brick: result.fallingBrick,
    console: result.consoleEvents.slice(-40),
  });
  assert.strictEqual(result.runningApps, 1, 'Funtris should be the only running app');
  assert(!result.windows.some(w => w.isDialog && /^Funtris$/i.test(w.title)), 'Funtris startup MessageBox should be dismissed: ' + resultSummary);
  assert(!/Get Started/i.test(titles), 'Funtris browser launch should not show Get Started dialog: ' + resultSummary);
  assert(result.windows.some(w => !w.isDialog && /^Funtris$/i.test(w.title)), 'Funtris main window should remain visible: ' + resultSummary);
  assert(/"GetStarted":\{"type":4,"data":0\}/.test(result.registry || ''), 'browser launch should seed GetStarted=0: ' + resultSummary);
  assert(!/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED/i.test(result.log), 'browser log should not contain launch errors\n' + result.log);
  assert(result.playfieldBlack > 20000, `new game should render initialized playfield, black=${result.playfieldBlack}`);
  assert.strictEqual(inkBefore, 0,
    `playfield should be empty before New Game, ink=${inkBefore} (see ${shot})`);
  assert(result.fallingBrick > 100,
    `new game should render a falling brick, ink ${inkBefore} -> ${result.fallingBrick} (see ${shot})`);

  console.log('PASS  Funtris browser launch dismisses startup dialog and starts gameplay');
  console.log(`windows=${JSON.stringify(result.windows)} black=${result.playfieldBlack} ink ${inkBefore} -> ${result.fallingBrick}`);
  cleanup();
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
