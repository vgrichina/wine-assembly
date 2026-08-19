#!/usr/bin/env node

'use strict';

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
const OUT = path.join(ROOT, 'scratch', 'win98-audio-web');
const volumePng = path.join(OUT, 'volume-active.png');
const recorderPng = path.join(OUT, 'sound-recorder.png');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Win98 audio browser test');
  process.exit(0);
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (_) { res.writeHead(400); res.end('bad url'); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code || 'read error'); return; }
      res.writeHead(200, { 'Content-Type': mimeType(file), 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
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
      res.on('data', data => { body += data; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function wsConnect(wsUrl) {
  const url = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect(Number(url.port), url.hostname);
  const pending = new Map();
  const events = [];
  let buffer = Buffer.alloc(0);
  let ready = false;
  let nextId = 1;

  function parseFrames() {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        if (buffer.readUInt32BE(2)) throw new Error('large websocket frame');
        length = buffer.readUInt32BE(6); offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString('utf8'));
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      } else {
        events.push(message);
      }
    }
  }

  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    if (!ready) {
      const end = buffer.toString('latin1').indexOf('\r\n\r\n');
      if (end < 0) return;
      ready = true;
      buffer = buffer.subarray(end + 4);
    }
    parseFrames();
  });

  const opened = new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
      const started = Date.now();
      const poll = () => {
        if (ready) resolve();
        else if (Date.now() - started > 5000) reject(new Error('websocket timeout'));
        else setTimeout(poll, 25);
      };
      poll();
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

  return { opened, send, events, close: () => socket.destroy() };
}

function consoleSummary(events) {
  const lines = [];
  for (const event of events) {
    if (event.method === 'Runtime.consoleAPICalled') {
      lines.push(((event.params && event.params.args) || []).map(arg =>
        Object.prototype.hasOwnProperty.call(arg, 'value') ? String(arg.value) : (arg.description || '')).join(' '));
    } else if (event.method === 'Runtime.exceptionThrown') {
      const details = (event.params && event.params.exceptionDetails) || {};
      lines.push(details.text || (details.exception && details.exception.description) || '');
    }
  }
  return lines.filter(Boolean).slice(-120);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of [volumePng, recorderPng]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }

  const server = await startStaticServer();
  const port = server.address().port;
  const debugPort = await reserveTcpPort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-audio-web-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/index.html?debug&audio-web=${Date.now()}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeError = '';
  chrome.stderr.on('data', data => { chromeError += data.toString(); });
  let cdp = null;

  const cleanup = () => {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  let page;
  for (let i = 0; i < 120; i++) {
    try {
      const pages = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      page = pages.find(item => item.type === 'page' && String(item.url || '').includes('/index.html'));
      if (page) break;
    } catch (_) {}
    await wait(100);
  }
  assert(page, `Chrome page did not appear\n${chromeError.slice(-4000)}`);

  cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function evaluate(expression, timeoutMs = 10000) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime.evaluate timeout')), timeoutMs));
    const response = await Promise.race([cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }), timeout]);
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      const description = details.exception && details.exception.description;
      throw new Error(description || details.text || JSON.stringify(details));
    }
    return response.result && response.result.value;
  }

  async function clickLaunch() {
    const point = await evaluate(`(() => {
      const button = document.querySelector('button[onclick="launchApp()"]');
      if (!button) throw new Error('Launch button not found');
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
    });
  }

  async function guestPoint(x, y) {
    return evaluate(`(() => {
      const canvas = document.getElementById('screen');
      const rect = canvas.getBoundingClientRect();
      const t = sharedRenderer && sharedRenderer._exclusiveTransform;
      const inputX = t
        ? t.dstX + (${x} - t.srcX) * t.dstW / Math.max(1, t.srcW)
        : ${x};
      const inputY = t
        ? t.dstY + (${y} - t.srcY) * t.dstH / Math.max(1, t.srcH)
        : ${y};
      return {
        x: rect.left + inputX * rect.width / canvas.width,
        y: rect.top + inputY * rect.height / canvas.height,
      };
    })()`);
  }

  async function clickGuest(x, y) {
    const point = await guestPoint(x, y);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
    });
  }

  async function dragGuest(fromX, fromY, toX, toY) {
    const from = await guestPoint(fromX, fromY);
    const to = await guestPoint(toX, toY);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await wait(100);
    for (let step = 1; step <= 5; step++) {
      const ratio = step / 5;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
        button: 'none', buttons: 1, clickCount: 0,
      });
      await wait(50);
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
    });
  }

  await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (document.readyState === 'complete' && typeof launchApp === 'function' &&
          typeof createHostImports === 'function' && typeof WineAssembly !== 'undefined') resolve(1);
      else if (performance.now() - started > 15000) reject(new Error('browser globals did not initialize'));
      else setTimeout(poll, 50);
    };
    poll();
  })`, 18000);

  await evaluate(`(() => {
    localStorage.clear();
    document.getElementById('app-select').value = 'pinball';
    return 1;
  })()`);
  await clickLaunch();
  let pinballMenuPoint = await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const app = runningApps.find(item => item && item.name === 'pinball');
      const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .find(w => w && w.visible && /3D Pinball for Windows/i.test(w.title || ''));
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      if (app && app.wine.running && win && e && e.menu_bar_screen_x && e.menu_bar_item_x) {
        sharedRenderer.handleKeyDown(18);
        sharedRenderer.handleKeyDown(79);
        sharedRenderer.handleKeyUp(79);
        sharedRenderer.handleKeyUp(18);
        if (!e.menu_open_hwnd || !e.menu_open_hwnd() || e.menu_open_top() !== 1) {
          reject(new Error('Pinball Options menu did not open'));
          return;
        }
        resolve({
          x: (e.menu_bar_screen_x(win.hwnd) | 0) + (e.menu_bar_item_x(win.hwnd, 1) | 0) + 45,
          y: (e.menu_bar_screen_y(win.hwnd) | 0) + (e.menu_bar_screen_h() | 0) + 2 + 5 * 20 + 10,
        });
      } else if (performance.now() - started > 120000) {
        const apps = runningApps.map(item => ({ name: item && item.name, running: !!(item && item.wine && item.wine.running) }));
        const log = document.getElementById('log').textContent.slice(-3000);
        reject(new Error('Pinball did not become ready: apps=' + JSON.stringify(apps) + '\\n' + log));
      } else setTimeout(poll, 100);
    };
    poll();
  })`, 125000);
  let pinballChecked = false;
  for (let attempt = 0; attempt < 3 && !pinballChecked; attempt++) {
    await wait(250);
    await clickGuest(pinballMenuPoint.x, pinballMenuPoint.y);
    await wait(1500);
    pinballChecked = await evaluate(`(() => {
      const app = runningApps.find(item => item && item.name === 'pinball');
      const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .find(w => w && w.visible && /3D Pinball for Windows/i.test(w.title || ''));
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      return !!(e && win && e.menu_child_flags && (e.menu_child_flags(win.hwnd, 1, 5) & 4));
    })()`);
    if (!pinballChecked) {
      pinballMenuPoint = await evaluate(`(() => {
        const app = runningApps.find(item => item && item.name === 'pinball');
        const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
          .find(w => w && w.visible && /3D Pinball for Windows/i.test(w.title || ''));
        const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
        if (!e || !win) throw new Error('Pinball disappeared while reopening Options');
        if (e.menu_close) e.menu_close();
        sharedRenderer.handleKeyDown(18);
        sharedRenderer.handleKeyDown(79);
        sharedRenderer.handleKeyUp(79);
        sharedRenderer.handleKeyUp(18);
        return {
          x: (e.menu_bar_screen_x(win.hwnd) | 0) + (e.menu_bar_item_x(win.hwnd, 1) | 0) + 45,
          y: (e.menu_bar_screen_y(win.hwnd) | 0) + (e.menu_bar_screen_h() | 0) + 2 + 5 * 20 + 10,
        };
      })()`);
    }
  }
  await evaluate(`(() => {
    sharedRenderer.handleKeyDown(113);
    sharedRenderer.handleKeyUp(113);
    return 1;
  })()`);
  await wait(3500);
  const pinballMusic = await evaluate(`(() => {
    const app = runningApps.find(item => item && item.name === 'pinball');
    const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
      .find(w => w && w.visible && /3D Pinball for Windows/i.test(w.title || ''));
    const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
    return {
      running: !!(app && app.wine.running),
      visible: !!win,
      checked: !!(e && win && e.menu_child_flags && (e.menu_child_flags(win.hwnd, 1, 5) & 4)),
      mciDevices: app && app.wine.hostCtx && app.wine.hostCtx._mci
        ? app.wine.hostCtx._mci.devices.size : 0,
      lastUnimplemented: wine && wine.hostCtx && wine.hostCtx.lastUnimplemented || '',
      eip: wine && wine.instance && wine.instance.exports && wine.instance.exports.get_eip
        ? '0x' + (wine.instance.exports.get_eip() >>> 0).toString(16) : '',
      esp: wine && wine.instance && wine.instance.exports && wine.instance.exports.get_esp
        ? '0x' + (wine.instance.exports.get_esp() >>> 0).toString(16) : '',
      ebp: wine && wine.instance && wine.instance.exports && wine.instance.exports.get_ebp
        ? '0x' + (wine.instance.exports.get_ebp() >>> 0).toString(16) : '',
      log: document.getElementById('log').textContent.slice(-2000),
    };
  })()`);
  const pinballConsole = consoleSummary(cdp.events).join('\n');
  assert.deepStrictEqual(
    { running: pinballMusic.running, visible: pinballMusic.visible, checked: pinballMusic.checked },
    { running: true, visible: true, checked: true },
    `Pinball should remain alive after checking Music at ${JSON.stringify(pinballMenuPoint)}: ${JSON.stringify(pinballMusic)}\n${pinballConsole.slice(-4000)}`);
  console.log(`PASS  browser Pinball remains live after checking Music (${pinballMusic.mciDevices} MCI device(s))`);

  await evaluate(`(() => {
    document.getElementById('app-select').value = 'sndvol32';
    return 1;
  })()`);
  await clickLaunch();

  await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .find(w => w && w.visible && /^Volume Control$/i.test(w.title || ''));
      const log = document.getElementById('log').textContent;
      const pinball = runningApps.some(item => item && item.name === 'pinball');
      const volume = runningApps.some(item => item && item.name === 'sndvol32');
      if (pinball && volume && win) resolve(1);
      else if (/ERROR launching|RuntimeError|LinkError|UNIMPLEMENTED/i.test(log)) reject(new Error(log.slice(-1500)));
      else if (performance.now() - started > 25000) reject(new Error('Volume Control did not appear'));
      else setTimeout(poll, 100);
    };
    poll();
  })`, 28000);

  const volumeWindowForMixer = await evaluate(`(() => {
    const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
      .find(w => w && w.visible && /^Volume Control$/i.test(w.title || ''));
    const pinball = runningApps.find(item => item && item.name === 'pinball');
    const volume = runningApps.find(item => item && item.name === 'sndvol32');
    const voices = pinball && pinball.wine && pinball.wine._sharedAudio && pinball.wine._sharedAudio.voices;
    const ac = pinball && pinball.wine && (pinball.wine._audioCtx || (voices && voices._ac));
    const e = volume && volume.wine && volume.wine.instance && volume.wine.instance.exports;
    const controls = {};
    if (win && e && e.wnd_next_child_slot && e.wnd_slot_hwnd) {
      let slot = 0;
      while ((slot = e.wnd_next_child_slot(win.hwnd, slot) | 0) >= 0) {
        const hwnd = e.wnd_slot_hwnd(slot) | 0;
        slot++;
        if (!hwnd || !e.ctrl_get_class || !e.ctrl_get_id) continue;
        const cls = e.ctrl_get_class(hwnd) | 0;
        const id = e.ctrl_get_id(hwnd) | 0;
        const x = e.wnd_window_screen_x(hwnd) | 0;
        const y = e.wnd_window_screen_y(hwnd) | 0;
        const w = e.wnd_screen_w(hwnd) | 0;
        const h = e.wnd_screen_h(hwnd) | 0;
        if ((cls === 19 && h > w && [1001, 2001, 3001].includes(id)) ||
            (cls === 1 && [1000, 2000, 3000].includes(id))) {
          controls[id] = { hwnd, cls, id, x, y, w, h };
        }
      }
    }
    return win && {
      hwnd: win.hwnd, x: win.x, y: win.y, w: win.w, h: win.h,
      before: ac && ac._wineMidiBus && ac._wineMidiBus.gain.value,
      controls,
    };
  })()`);
  assert(volumeWindowForMixer && [1000, 1001, 2000, 2001, 3000, 3001]
    .every(id => volumeWindowForMixer.controls[id]),
    `Volume Control and Pinball MIDI bus should both be live: ${JSON.stringify(volumeWindowForMixer)}`);
  await clickGuest(volumeWindowForMixer.x + 145, volumeWindowForMixer.y + 55);
  await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const volume = runningApps.find(item => item && item.name === 'sndvol32');
      const top = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .filter(win => win && win.visible && !win.isChild)
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
      if (volume && top && /^Volume Control$/i.test(top.title || '') && !sharedRenderer._exclusiveTransform) resolve(1);
      else if (performance.now() - started > 3000) reject(new Error('Volume Control did not leave exclusive Pinball input mode'));
      else setTimeout(poll, 50);
    };
    poll();
  })`, 5000);
  const masterTrack = volumeWindowForMixer.controls[1001];
  const waveTrack = volumeWindowForMixer.controls[2001];
  const midiTrack = volumeWindowForMixer.controls[3001];
  const midiMute = volumeWindowForMixer.controls[3000];

  const dragTrackHalfway = control => dragGuest(
    control.x + Math.floor(control.w / 2), control.y + 8,
    control.x + Math.floor(control.w / 2), control.y + Math.floor(control.h / 2));
  const resetTrack = control => dragGuest(
    control.x + Math.floor(control.w / 2), control.y + Math.floor(control.h / 2),
    control.x + Math.floor(control.w / 2), control.y + 8);
  const inspectPinballMixer = () => evaluate(`(() => {
    const pinball = runningApps.find(item => item && item.name === 'pinball');
    const volume = runningApps.find(item => item && item.name === 'sndvol32');
    const voices = pinball && pinball.wine && pinball.wine._sharedAudio && pinball.wine._sharedAudio.voices;
    const ac = pinball && pinball.wine && (pinball.wine._audioCtx || (voices && voices._ac));
    const mixer = volume && volume.wine && volume.wine._sharedMixer;
    const volumeExports = volume && volume.wine && volume.wine.instance && volume.wine.instance.exports;
    const controls = ${JSON.stringify(volumeWindowForMixer.controls)};
    const trackPositions = {};
    for (const id of [1001, 2001, 3001]) {
      trackPositions[id] = volumeExports && volumeExports.send_message
        ? volumeExports.send_message(controls[id].hwnd, 0x0400, 0, 0) | 0 : -1;
    }
    return {
      master: ac && ac._wineMaster && ac._wineMaster.gain.value,
      wave: ac && ac._wineWaveBus && ac._wineWaveBus.gain.value,
      midi: ac && ac._wineMidiBus && ac._wineMidiBus.gain.value,
      volumes: mixer && mixer.mixerVolumes ? mixer.mixerVolumes.map(value => value >>> 0) : [],
      mutes: mixer && mixer.mixerMutes ? [...mixer.mixerMutes] : [],
      trackPositions,
    };
  })()`);

  const initialMixer = await inspectPinballMixer();
  await dragTrackHalfway(waveTrack);
  await wait(500);
  const waveIsolation = await inspectPinballMixer();
  assert(waveIsolation.wave < initialMixer.wave && waveIsolation.midi === initialMixer.midi &&
    waveIsolation.master === initialMixer.master && waveIsolation.volumes[1] !== 0xffffffff,
    `Wave fader should affect Pinball effects but not MIDI: ${JSON.stringify({ initialMixer, waveIsolation })}`);
  await resetTrack(waveTrack);
  await wait(300);

  await dragTrackHalfway(masterTrack);
  await wait(500);
  const masterMixer = await inspectPinballMixer();
  assert(masterMixer.master < initialMixer.master && masterMixer.wave === initialMixer.wave &&
    masterMixer.midi === initialMixer.midi && masterMixer.volumes[0] !== 0xffffffff,
    `Master fader should attenuate Pinball globally without replacing channel gains: ${JSON.stringify(masterMixer)}`);
  await resetTrack(masterTrack);
  await wait(300);

  await dragGuest(
    midiTrack.x + Math.floor(midiTrack.w / 2), midiTrack.y + 8,
    midiTrack.x + Math.floor(midiTrack.w / 2), midiTrack.y + Math.floor(midiTrack.h / 2));
  await wait(500);
  const crossAppMixer = await evaluate(`(() => {
    const pinball = runningApps.find(item => item && item.name === 'pinball');
    const volume = runningApps.find(item => item && item.name === 'sndvol32');
    const voices = pinball && pinball.wine && pinball.wine._sharedAudio && pinball.wine._sharedAudio.voices;
    const ac = pinball && pinball.wine && (pinball.wine._audioCtx || (voices && voices._ac));
    const mixer = volume && volume.wine && volume.wine._sharedMixer;
    const volumeExports = volume && volume.wine && volume.wine.instance && volume.wine.instance.exports;
    const packed = mixer && mixer.mixerVolumes ? mixer.mixerVolumes[2] >>> 0 : 0xffffffff;
    const after = ac && ac._wineMidiBus && ac._wineMidiBus.gain.value;
    const trackPos = volumeExports && volumeExports.send_message
      ? volumeExports.send_message(${midiTrack.hwnd}, 0x0400, 0, 0) | 0 : -1;
    const captureHwnd = volumeExports && volumeExports.get_capture_hwnd
      ? volumeExports.get_capture_hwnd() >>> 0 : 0;
    if (volume && volume.wine && volume.wine.hostCtx && volume.wine.hostCtx.setAudioMixerVolume) {
      volume.wine.hostCtx.setAudioMixerVolume(2, 0xffffffff);
    }
    return {
      before: ${volumeWindowForMixer.before},
      after,
      packed,
      separateAudio: !!(pinball && volume && pinball.wine._sharedAudio !== volume.wine._sharedAudio),
      midiTrack: ${JSON.stringify(midiTrack)},
      trackPos,
      captureHwnd,
      rendererOwnsVolume: !!(volume && sharedRenderer.wasm === volume.wine.instance),
      dialogDrag: sharedRenderer._dialogBtnDrag && { ...sharedRenderer._dialogBtnDrag, wasm: !!sharedRenderer._dialogBtnDrag.wasm },
      exclusiveTransform: sharedRenderer._exclusiveTransform,
    };
  })()`);
  assert(crossAppMixer.separateAudio && crossAppMixer.after < crossAppMixer.before && crossAppMixer.packed !== 0xffffffff,
    `Volume Control MIDI fader should change Pinball without sharing process audio: ${JSON.stringify(crossAppMixer)}`);

  // Restore the fader to the adjusted value after the diagnostic read reset it.
  await dragTrackHalfway(midiTrack);
  await wait(300);
  await clickGuest(midiMute.x + Math.floor(midiMute.w / 2), midiMute.y + Math.floor(midiMute.h / 2));
  await wait(300);
  const midiMuted = await inspectPinballMixer();
  assert.strictEqual(midiMuted.midi, 0, `MIDI mute should silence Pinball MIDI: ${JSON.stringify(midiMuted)}`);
  assert.strictEqual(midiMuted.mutes[2], 1, 'desktop MIDI mute state should be set');
  await clickGuest(midiMute.x + Math.floor(midiMute.w / 2), midiMute.y + Math.floor(midiMute.h / 2));
  await wait(300);
  const midiRestored = await inspectPinballMixer();
  assert(midiRestored.midi > 0 && Math.abs(midiRestored.midi - crossAppMixer.after) < 0.02 && midiRestored.mutes[2] === 0,
    `unmuting MIDI should restore the adjusted Pinball gain: ${JSON.stringify({ crossAppMixer, midiRestored })}`);

  await evaluate(`(() => {
    const volume = runningApps.find(item => item && item.name === 'sndvol32');
    if (volume && volume.wine && volume.wine.hostCtx && volume.wine.hostCtx.setAudioMixerVolume) {
      for (let bus = 0; bus < 3; bus++) volume.wine.hostCtx.setAudioMixerVolume(bus, 0xffffffff);
    }
    return 1;
  })()`);
  await clickGuest(
    volumeWindowForMixer.x + volumeWindowForMixer.w - 13,
    volumeWindowForMixer.y + 12);
  const mixerCloseLifecycle = await evaluate(`new Promise(resolve => {
    const started = performance.now();
    const poll = () => {
      const pinball = runningApps.find(item => item && item.name === 'pinball');
      const volume = runningApps.find(item => item && item.name === 'sndvol32');
      const voices = pinball && pinball.wine && pinball.wine._sharedAudio && pinball.wine._sharedAudio.voices;
      const ac = pinball && pinball.wine && (pinball.wine._audioCtx || (voices && voices._ac));
      const mci = pinball && pinball.wine && pinball.wine.hostCtx && pinball.wine.hostCtx._mci;
      const result = {
        volumeRunning: !!volume,
        pinballRunning: !!(pinball && pinball.wine.running),
        contextState: ac && ac.state,
        mciDevices: mci ? mci.devices.size : 0,
      };
      if (!volume || performance.now() - started > 5000) resolve(result);
      else setTimeout(poll, 100);
    };
    poll();
  })`, 7000);
  assert.deepStrictEqual(mixerCloseLifecycle,
    { volumeRunning: false, pinballRunning: true, contextState: 'running', mciDevices: 1 },
    `closing Volume Control should leave Pinball audio running: ${JSON.stringify(mixerCloseLifecycle)}`);

  await evaluate(`(() => {
    const app = runningApps.find(item => item && item.name === 'pinball');
    if (app && app.wine) app.wine.stop();
    return 1;
  })()`);

  await evaluate(`(() => {
    document.getElementById('app-select').value = 'sndvol32';
    return 1;
  })()`);
  await clickLaunch();
  await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .find(w => w && w.visible && /^Volume Control$/i.test(w.title || ''));
      if (runningApps.some(item => item && item.name === 'sndvol32') && win) resolve(1);
      else if (performance.now() - started > 25000) reject(new Error('Volume Control did not relaunch'));
      else setTimeout(poll, 100);
    };
    poll();
  })`, 28000);

  const audioGraph = await evaluate(`(() => {
    const app = runningApps.find(item => item && item.name === 'sndvol32');
    const memory = new WebAssembly.Memory({ initial: 2 });
    const ctx = {
      getMemory: () => memory.buffer,
      get _audioCtx() { return app.wine._audioCtx; },
      set _audioCtx(value) { app.wine._audioCtx = value; },
      sharedAudio: app.wine._sharedAudio,
      sharedMixer: app.wine._sharedMixer,
      midiBackend: 'oscillator',
    };
    const probe = createHostImports(ctx).host;
    const samples = new Int16Array(memory.buffer, 0x1000, 11025);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 8) * 30000);
    const wave = probe.wave_out_open(22050, 1, 16, 0);
    probe.wave_out_write(wave, 0x1000, samples.byteLength);
    const midi = probe.midi_out_open(0, 0, 0, 0);
    probe.midi_out_short_msg(midi, 0x00643c90);
    probe.audio_mixer_mark_peak(1, 32767, 5000);
    probe.audio_mixer_mark_peak(2, 18000, 5000);
    window.__audioWebProbe = { probe, wave, midi };
    const ac = app.wine._audioCtx;
    return {
      contextState: ac && ac.state,
      masterAnalyser: !!(ac && ac._wineMasterAnalyser),
      waveAnalyser: !!(ac && ac._wineWaveAnalyser),
      midiAnalyser: !!(ac && ac._wineMidiAnalyser),
      waveBus: !!(ac && ac._wineWaveBus),
      midiBus: !!(ac && ac._wineMidiBus),
    };
  })()`);

  const volume = await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const inspect = () => {
      if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
      const win = Object.values(sharedRenderer.windows)
        .find(w => w && w.visible && /^Volume Control$/i.test(w.title || ''));
      const canvas = document.getElementById('screen');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const meter = offset => {
        const result = { green: 0, yellow: 0, red: 0 };
        for (let y = win.y + 166; y < win.y + 250; y++) {
          for (let x = win.x + offset; x < win.x + offset + 12; x++) {
            const i = (y * canvas.width + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (g >= 100 && r < 20 && b < 20) result.green++;
            if (r >= 200 && g >= 200 && b < 40) result.yellow++;
            if (r >= 200 && g < 40 && b < 40) result.red++;
          }
        }
        return result;
      };
      const meters = [meter(64), meter(154), meter(244)];
      if ((meters[0].red && meters[1].red && meters[2].green) || performance.now() - started > 5000) {
        const crop = document.createElement('canvas');
        crop.width = win.w; crop.height = win.h;
        crop.getContext('2d').drawImage(canvas, win.x, win.y, win.w, win.h, 0, 0, win.w, win.h);
        resolve({ meters, width: win.w, height: win.h, png: crop.toDataURL('image/png') });
      } else {
        setTimeout(inspect, 100);
      }
    };
    inspect();
  })`, 8000);
  fs.writeFileSync(volumePng, Buffer.from(volume.png.replace(/^data:image\/png;base64,/, ''), 'base64'));

  await evaluate(`(() => {
    document.getElementById('app-select').value = 'sndrec32_98';
    return 1;
  })()`);
  await clickLaunch();
  const recorderWindow = await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .filter(w => w && w.visible && /Sound Recorder/i.test(w.title || ''))
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
      if (win) resolve({ hwnd: win.hwnd, x: win.x, y: win.y, w: win.w, h: win.h });
      else if (performance.now() - started > 25000) reject(new Error('Sound Recorder did not appear'));
      else setTimeout(poll, 100);
    };
    poll();
  })`, 28000);
  let capture = null;
  let captureProbe = null;
  for (let attempt = 0; attempt < 3 && !capture; attempt++) {
    await clickGuest(recorderWindow.x + 239, recorderWindow.y + 138);
    captureProbe = await evaluate(`new Promise((resolve, reject) => {
      const started = performance.now();
      const poll = () => {
        const app = runningApps.find(item => item && item.name === 'sndrec32_98');
        const waveIn = app && app.wine && app.wine._sharedAudio && app.wine._sharedAudio.waveIn;
        const device = waveIn && waveIn.devices && waveIn.devices.values().next().value;
        if (device && device.stream && device.processor) {
          setTimeout(() => resolve({
            started: true,
            stream: !!device.stream,
            processor: !!device.processor,
            queue: device.queue.length,
            capturedFrames: device.capturedFrames || 0,
            error: device.lastError || '',
          }), 1200);
        } else if (device && device.lastError) {
          reject(new Error('microphone failed: ' + device.lastError));
        } else if (performance.now() - started > 4000) {
          resolve({ started: false, device: !!device, running: !!(device && device.running) });
        } else setTimeout(poll, 100);
      };
      poll();
    })`, 7000);
    if (captureProbe.started) capture = captureProbe;
    else if (captureProbe.running) break;
  }
  assert(capture, `browser microphone capture did not start after three Record clicks: ${JSON.stringify(captureProbe)}`);
  let captureStopped = false;
  for (let attempt = 0; attempt < 3 && !captureStopped; attempt++) {
    await clickGuest(recorderWindow.x + 187, recorderWindow.y + 138);
    captureStopped = await evaluate(`new Promise(resolve => {
      const started = performance.now();
      const poll = () => {
        const app = runningApps.find(item => item && item.name === 'sndrec32_98');
        const waveIn = app && app.wine && app.wine._sharedAudio && app.wine._sharedAudio.waveIn;
        const device = waveIn && waveIn.devices && waveIn.devices.values().next().value;
        if (!device || !device.running) resolve(true);
        else if (performance.now() - started > 2500) resolve(false);
        else setTimeout(poll, 100);
      };
      poll();
    })`, 4000);
  }
  assert(captureStopped, 'Sound Recorder did not stop capture after three transport clicks');
  await wait(300);
  const recorder = await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const inspect = () => {
      if (sharedRenderer && sharedRenderer.repaint) sharedRenderer.repaint();
      const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .filter(w => w && w.visible && /Sound Recorder/i.test(w.title || ''))
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
      if (!win) {
        if (performance.now() - started > 25000) reject(new Error('Sound Recorder did not appear'));
        else setTimeout(inspect, 100);
        return;
      }
      const canvas = document.getElementById('screen');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const dark = (x0, y0, x1, y1) => {
        let count = 0;
        for (let y = win.y + y0; y < Math.min(win.y + y1, win.y + win.h, canvas.height); y++) {
          for (let x = win.x + x0; x < Math.min(win.x + x1, win.x + win.w, canvas.width); x++) {
            const i = (y * canvas.width + x) * 4;
            if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) count++;
          }
        }
        return count;
      };
      const crop = document.createElement('canvas');
      crop.width = win.w; crop.height = win.h;
      crop.getContext('2d').drawImage(canvas, win.x, win.y, win.w, win.h, 0, 0, win.w, win.h);
      resolve({
        title: win.title, width: win.w, height: win.h,
        displayGreen: (() => {
          let count = 0;
          for (let y = win.y + 48; y < win.y + 89; y++) {
            for (let x = win.x + 82; x < win.x + 194; x++) {
              const i = (y * canvas.width + x) * 4;
              if (data[i] < 40 && data[i + 1] > 90 && data[i + 2] < 40) count++;
            }
          }
          return count;
        })(),
        transportBottomInk: dark(50, 145, 304, 153),
        lowerChromeInk: dark(40, 154, 318, 165),
        png: crop.toDataURL('image/png'),
      });
    };
    inspect();
  })`, 28000);
  fs.writeFileSync(recorderPng, Buffer.from(recorder.png.replace(/^data:image\/png;base64,/, ''), 'base64'));

  await clickGuest(recorderWindow.x + recorderWindow.w - 13, recorderWindow.y + 12);
  const recorderClosed = await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const windows = Object.values((sharedRenderer && sharedRenderer.windows) || {});
      const visible = windows.some(w => w && w.visible && /Sound Recorder/i.test(w.title || ''));
      const running = runningApps.some(item => item && item.name === 'sndrec32_98');
      if (!visible && !running) resolve({ visible, running });
      else if (performance.now() - started > 5000) resolve({ visible, running });
      else setTimeout(poll, 100);
    };
    poll();
  })`, 7000);

  const volumeWindow = await evaluate(`(() => {
    const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
      .find(w => w && w.visible && /^Volume Control$/i.test(w.title || ''));
    return win && { hwnd: win.hwnd, x: win.x, y: win.y, w: win.w, h: win.h };
  })()`);
  assert(volumeWindow, 'Volume Control should remain after Sound Recorder closes');
  await clickGuest(volumeWindow.x + volumeWindow.w - 13, volumeWindow.y + 12);
  const volumeClosed = await evaluate(`new Promise(resolve => {
    const started = performance.now();
    const poll = () => {
      const windows = Object.values((sharedRenderer && sharedRenderer.windows) || {});
      const visible = windows.some(w => w && w.visible && /^Volume Control$/i.test(w.title || ''));
      const running = runningApps.some(item => item && item.name === 'sndvol32');
      if ((!visible && !running) || performance.now() - started > 5000) resolve({ visible, running });
      else setTimeout(poll, 100);
    };
    poll();
  })`, 7000);

  const consoleText = consoleSummary(cdp.events).join('\n');
  const meterColor = meter => meter.green + meter.yellow + meter.red;
  assert.strictEqual(audioGraph.contextState, 'running', 'browser AudioContext should be running');
  assert(audioGraph.masterAnalyser && audioGraph.waveAnalyser && audioGraph.midiAnalyser,
    `browser audio graph should contain all analysers: ${JSON.stringify(audioGraph)}`);
  assert(audioGraph.waveBus && audioGraph.midiBus, 'browser audio graph should contain independent Wave and MIDI buses');
  assert(volume.meters[0].green >= 200 && volume.meters[0].yellow >= 40 && volume.meters[0].red >= 40,
    `master browser meter should reach all color bands: ${JSON.stringify(volume.meters)}`);
  assert(volume.meters[1].green >= 200 && volume.meters[1].yellow >= 40 && volume.meters[1].red >= 40,
    `Wave browser meter should reach all color bands: ${JSON.stringify(volume.meters)}`);
  assert(meterColor(volume.meters[2]) >= 100 && volume.meters[2].red === 0,
    `MIDI browser meter should show a lower independent level: ${JSON.stringify(volume.meters)}`);
  assert(recorder.width >= 275 && recorder.height >= 160,
    `Sound Recorder browser window should include full client area, got ${recorder.width}x${recorder.height}`);
  assert(recorder.transportBottomInk >= 180 && recorder.lowerChromeInk >= 200,
    `Sound Recorder transport row should not be clipped: ${JSON.stringify(recorder)}`);
  assert(capture.stream && capture.processor && capture.capturedFrames >= 1000 && !capture.error,
    `Sound Recorder should acquire and process browser microphone audio: ${JSON.stringify(capture)}`);
  assert(recorder.displayGreen >= 100,
    `Sound Recorder should render captured microphone PCM, green=${recorder.displayGreen}`);
  assert.deepStrictEqual(recorderClosed, { visible: false, running: false },
    `Sound Recorder title-bar close should destroy its window and app: ${JSON.stringify(recorderClosed)}`);
  assert.deepStrictEqual(volumeClosed, { visible: false, running: false },
    `Volume Control title-bar close should destroy its window and app: ${JSON.stringify(volumeClosed)}`);
  assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(consoleText),
    `browser console should not contain runtime failures\n${consoleText.slice(-4000)}`);
  assert(fs.statSync(volumePng).size > 8000 && fs.statSync(recorderPng).size > 5000,
    'browser screenshots should be complete');

  console.log('PASS  browser SndVol uses live Web Audio Wave/MIDI analyser buses');
  console.log(`PASS  browser SndVol MIDI fader controls Pinball (${crossAppMixer.before.toFixed(3)} -> ${crossAppMixer.after.toFixed(3)})`);
  console.log('PASS  browser SndVol Master/Wave/MIDI controls remain isolated and MIDI mute restores gain');
  console.log('PASS  browser closing SndVol leaves Pinball MIDI and AudioContext running');
  console.log(`PASS  browser native peak meters render independently ${JSON.stringify(volume.meters)}`);
  console.log(`PASS  browser Sound Recorder transport row is complete (${recorder.width}x${recorder.height})`);
  console.log(`PASS  browser Sound Recorder captures microphone PCM (${capture.capturedFrames} frames, ${recorder.displayGreen} waveform pixels)`);
  console.log('PASS  browser Sound Recorder and Volume Control close from their title bars');
  console.log(`Screenshots: ${OUT}`);
  cleanup();
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
