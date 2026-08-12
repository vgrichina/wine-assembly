#!/usr/bin/env node
// Browser regression for WordPad's RichEdit startup path. The web launcher
// must preload riched20.dll, keep WordPad alive, and route typed text to its
// native RichEdit20A child.

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
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-web');
const PNG = path.join(OUT, 'hello-world.png');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for WordPad browser test');
  process.exit(0);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch (_) { response.writeHead(400); response.end('bad url'); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403); response.end('forbidden'); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); return; }
      response.writeHead(200, { 'Content-Type': mimeType(file), 'Cache-Control': 'no-store' });
      response.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function reservePort() {
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
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function connectWebSocket(wsUrl) {
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
        'Sec-WebSocket-Version: 13', '', '',
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
  return events.filter(event => event.method === 'Runtime.consoleAPICalled').map(event =>
    ((event.params && event.params.args) || []).map(arg =>
      Object.prototype.hasOwnProperty.call(arg, 'value') ? String(arg.value) : (arg.description || '')).join(' '));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer();
  const port = server.address().port;
  const debugPort = await reservePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-wordpad-web-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-search-engine-choice-screen',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/index.html?debug&wordpad-web=${Date.now()}`,
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

  cdp = connectWebSocket(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');

  async function evaluate(expression, timeoutMs = 10000) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime.evaluate timeout')), timeoutMs));
    const response = await Promise.race([cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }), timeout]);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || JSON.stringify(response.exceptionDetails));
    return response.result && response.result.value;
  }

  await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (document.readyState === 'complete' && typeof launchApp === 'function') resolve(1);
      else if (performance.now() - started > 15000) reject(new Error('browser globals did not initialize'));
      else setTimeout(poll, 50);
    };
    poll();
  })`, 18000);

  await evaluate(`(() => {
    document.getElementById('app-select').value = 'wordpad';
    return launchApp();
  })()`, 45000);

  const ready = await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const app = runningApps.find(item => item && item.name === 'wordpad');
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      const main = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .find(win => win && win.visible && !win.isChild && /WordPad/i.test(win.title || ''));
      let editor = 0;
      if (main && e && e.wnd_next_child_slot && e.wnd_slot_hwnd && e.ctrl_get_id) {
        let slot = 0;
        while ((slot = e.wnd_next_child_slot(main.hwnd, slot) | 0) >= 0) {
          const hwnd = e.wnd_slot_hwnd(slot) | 0;
          slot++;
          if (hwnd && (e.ctrl_get_id(hwnd) | 0) === 59648) { editor = hwnd; break; }
        }
      }
      if (app && app.wine.running && main && editor) resolve({ main: main.hwnd, editor });
      else if (performance.now() - started > 25000) reject(new Error('WordPad/RichEdit did not stay ready: ' + document.getElementById('log').textContent.slice(-2000)));
      else setTimeout(poll, 100);
    };
    poll();
  })`, 28000);

  const typed = await evaluate(`new Promise((resolve, reject) => {
    const app = runningApps.find(item => item && item.name === 'wordpad');
    const e = app.wine.instance.exports;
    e.set_focus(${ready.editor});
    if ((e.get_focus_hwnd() | 0) !== ${ready.editor}) e.set_focus_hwnd(${ready.editor});
    for (const ch of 'hello world') sharedRenderer.handleKeyPress(ch.charCodeAt(0));
    const started = performance.now();
    const poll = () => {
      const length = e.send_message(${ready.editor}, 0x000E, 0, 0) | 0;
      if (length >= 11) {
        const guest = e.guest_alloc(64) >>> 0;
        e.send_message(${ready.editor}, 0x000D, 64, guest);
        const wa = app.wine._guestToWasmAddress(guest);
        const bytes = new Uint8Array(app.wine.memory.buffer);
        let text = '';
        for (let i = 0; i < length && bytes[wa + i]; i++) text += String.fromCharCode(bytes[wa + i]);
        if (e.guest_free) e.guest_free(guest);
        resolve({ length, text, running: app.wine.running, focus: e.get_focus_hwnd() | 0 });
      } else if (performance.now() - started > 8000) reject(new Error('WordPad did not accept text: ' + JSON.stringify({
        length,
        focus: e.get_focus_hwnd ? e.get_focus_hwnd() | 0 : -1,
        running: !!app.wine.running,
        eip: e.get_eip ? e.get_eip() >>> 0 : 0,
        yieldReason: e.get_yield_reason ? e.get_yield_reason() | 0 : -1,
        postQueue: e.get_post_queue_count ? e.get_post_queue_count() | 0 : -1,
        rendererOwnsApp: sharedRenderer.wasm === app.wine.instance,
        keyboardOwnsApp: sharedRenderer._keyboardInputWasm === app.wine.instance,
        inputQueue: (sharedRenderer.inputQueue || []).map(item => ({ msg: item.msg, wParam: item.wParam, hwnd: item.hwnd })),
        log: document.getElementById('log').textContent.slice(-2500),
      })));
      else setTimeout(poll, 100);
    };
    poll();
  })`, 10000);

  const screenshot = await evaluate(`(() => {
    sharedRenderer.repaint();
    const canvas = document.getElementById('screen');
    return canvas.toDataURL('image/png');
  })()`);
  fs.writeFileSync(PNG, Buffer.from(screenshot.replace(/^data:image\/png;base64,/, ''), 'base64'));

  const log = await evaluate(`document.getElementById('log').textContent`);
  const menuFontState = await evaluate(`(() => {
    const app = runningApps.find(item => item && item.name === 'wordpad');
    const main = sharedRenderer.windows[${ready.main}];
    const e = app.wine.instance.exports;
    const hdc = (${ready.main} + 0x40000) >>> 0;
    const gdi = app.wine.hostCtx && app.wine.hostCtx.sharedGdi;
    const dc = gdi && gdi._dcState && gdi._dcState[hdc];
    const handle = dc && dc.selectedFont || 0;
    const font = gdi && gdi._gdiObjects && gdi._gdiObjects[handle];
    return {
      handle,
      css: font && font.css || '',
      secondItemX: e.menu_bar_item_x ? e.menu_bar_item_x(main.hwnd, 1) | 0 : -1,
    };
  })()`);
  const sizeState = await evaluate(`(() => {
    const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
      .find(item => item && item.wasm && item.wasm.exports.ctrl_get_id &&
        (item.wasm.exports.ctrl_get_id(item.hwnd) | 0) === 166);
    if (!win) return null;
    const app = runningApps.find(item => item && item.wine && item.wine.instance === win.wasm);
    const e = win.wasm.exports;
    const guest = e.guest_alloc(32) >>> 0;
    e.send_message(win.hwnd, 0x000D, 32, guest);
    const wa = app.wine._guestToWasmAddress(guest);
    const bytes = new Uint8Array(app.wine.memory.buffer);
    let guestText = '';
    for (let i = 0; i < 31 && bytes[wa + i]; i++) guestText += String.fromCharCode(bytes[wa + i]);
    if (e.guest_free) e.guest_free(guest);
    return { rendererText: win.title, guestText };
  })()`);
  const consoleText = consoleSummary(cdp.events).join('\n');
  assert.strictEqual(typed.text, 'hello world', `native RichEdit text mismatch: ${JSON.stringify(typed)}`);
  assert(typed.running, 'WordPad should remain running after typing');
  assert.strictEqual(typed.focus, ready.editor, 'native RichEdit child should retain focus');
  assert(!/--- Program exited ---/.test(log), `WordPad should not exit:\n${log.slice(-3000)}`);
  assert(/DLL: riched20\.dll at/i.test(consoleText),
    `browser should preload riched20.dll:\n${consoleText.slice(-5000)}`);
  assert.deepStrictEqual(sizeState, { rendererText: '10', guestText: '10' },
    'WordPad browser toolbar should show the 10pt default in renderer and control state');
  assert.strictEqual(menuFontState.handle, 0x30021,
    `WordPad menu should select DEFAULT_GUI_FONT: ${JSON.stringify(menuFontState)}`);
  assert(/W95FA/.test(menuFontState.css),
    `WordPad menu should use the Win98 UI font: ${JSON.stringify(menuFontState)}`);
  assert(fs.statSync(PNG).size > 0, 'WordPad browser screenshot should be written');

  console.log('PASS  WordPad stays running in the browser');
  console.log('PASS  browser preloads riched20.dll');
  console.log('PASS  native RichEdit accepts "hello world"');
  console.log('PASS  browser toolbar shows 10pt default size');
  console.log('PASS  browser menu font:', JSON.stringify(menuFontState));
  console.log('PASS  screenshot:', PNG);
  cleanup();
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
