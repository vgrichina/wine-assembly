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
const OUT = path.join(ROOT, 'test', 'output', 'mspaint-web');
const PNG = path.join(OUT, 'startup.png');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Paint browser test');
  process.exit(0);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch (_) { response.writeHead(400); response.end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403); response.end(); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      response.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
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
        `GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`,
        'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
      const started = Date.now();
      const poll = () => ready ? resolve() :
        (Date.now() - started > 5000 ? reject(new Error('websocket timeout')) : setTimeout(poll, 25));
      poll();
    });
    socket.once('error', reject);
  });

  function send(method, params = {}) {
    const id = nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
    header[0] = 0x81;
    const maskOffset = payload.length < 126 ? 2 : 4;
    if (payload.length < 126) header[1] = 0x80 | payload.length;
    else { header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    crypto.randomBytes(4).copy(header, maskOffset);
    for (let i = 0; i < payload.length; i++) payload[i] ^= header[maskOffset + (i & 3)];
    socket.write(Buffer.concat([header, payload]));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  return { opened, send, close: () => socket.destroy() };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer();
  const port = server.address().port;
  const debugPort = await reservePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-mspaint-web-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-search-engine-choice-screen',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/index.html?debug&mspaint-web=${Date.now()}`,
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
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  async function evaluate(expression, timeoutMs = 10000) {
    const response = await Promise.race([
      cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime.evaluate timeout')), timeoutMs)),
    ]);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || JSON.stringify(response.exceptionDetails));
    return response.result && response.result.value;
  }

  await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (document.readyState === 'complete' && typeof launchApp === 'function' &&
          document.querySelector('#app-select option[value="mspaint98"]')) resolve(1);
      else if (performance.now() - started > 15000) reject(new Error('browser globals did not initialize'));
      else setTimeout(poll, 50);
    }; poll();
  })`, 18000);
  const viewport = await evaluate(`(() => {
    resizeCanvas();
    const canvas = document.getElementById('screen');
    const wrap = document.getElementById('screen-wrap');
    return {
      innerWidth,
      innerHeight,
      wrapWidth: wrap.clientWidth,
      wrapHeight: wrap.clientHeight,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
  })()`);
  assert(viewport.wrapWidth >= 1200 && viewport.canvasWidth >= 1200,
    `Paint browser test did not enter wide layout: ${JSON.stringify(viewport)}`);
  console.log('INFO  wide viewport:', JSON.stringify(viewport));
  await evaluate(`(() => {
    document.getElementById('app-select').value = 'mspaint98';
    return launchApp();
  })()`, 45000);

  const state = await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const app = runningApps.find(item => item && item.name === 'mspaint98');
      const wins = Object.values((sharedRenderer && sharedRenderer.windows) || {});
      const main = wins.find(win => win && win.visible && /Paint$/i.test(win.title || ''));
      const tools = wins.find(win => win && win.visible && win.title === 'Tools');
      const colors = wins.find(win => win && win.visible && win.title === 'Colors');
      if (app && app.wine.running && main && tools && colors) {
        resolve({ main: main.hwnd, tools: tools.hwnd, colors: colors.hwnd, log: document.getElementById('log').textContent });
      } else if (performance.now() - started > 25000) {
        reject(new Error('Paint did not stay ready: ' + document.getElementById('log').textContent.slice(-2500)));
      } else setTimeout(poll, 100);
    }; poll();
  })`, 28000);

  const appearance = await evaluate(`(() => {
    sharedRenderer.repaint();
    const canvas = document.getElementById('screen');
    const pixels = canvas.getContext('2d').getImageData(26, 62, 52, 200).data;
    let brightRed = 0;
    let buttonFace = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 240 && pixels[i + 1] < 24 && pixels[i + 2] < 24) brightRed++;
      if (Math.abs(pixels[i] - 192) <= 2 &&
          Math.abs(pixels[i + 1] - 192) <= 2 &&
          Math.abs(pixels[i + 2] - 192) <= 2) buttonFace++;
    }
    return { brightRed, buttonFace };
  })()`);

  const interaction = await evaluate(`new Promise((resolve, reject) => {
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const sample = () => Array.from(ctx.getImageData(130, 160, 130, 110).data);
    const before = sample();
    const app = runningApps.find(item => item && item.name === 'mspaint98');
    const wine = app && app.wine;
    const slicesBefore = wine && wine._runSliceCount || 0;
    sharedRenderer.handleMouseDown(39, 146, 1);
    sharedRenderer.handleMouseUp(39, 146, 1);
    sharedRenderer.handleMouseDown(140, 170, 1);
    sharedRenderer.handleMouseMove(175, 205);
    sharedRenderer.handleMouseMove(210, 235);
    sharedRenderer.handleMouseUp(240, 260, 1);
    const started = performance.now();
    const poll = () => {
      const slicesAfter = wine && wine._runSliceCount || 0;
      const after = sample();
      let changed = 0;
      for (let i = 0; i < after.length; i += 4) {
        if (before[i] !== after[i] || before[i + 1] !== after[i + 1] ||
            before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) changed++;
      }
      if (changed >= 20 && slicesAfter > slicesBefore) {
        resolve({ changed, slicesBefore, slicesAfter });
      } else if (performance.now() - started > 10000) {
        reject(new Error('Paint did not respond in wide layout: ' + JSON.stringify({
          changed, slicesBefore, slicesAfter,
          log: document.getElementById('log').textContent.slice(-2000),
        })));
      } else setTimeout(poll, 100);
    };
    poll();
  })`, 12000);

  const floodFill = await evaluate(`(async () => {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const click = (x, y) => {
      sharedRenderer.handleMouseDown(x, y, 1);
      sharedRenderer.handleMouseUp(x, y, 1);
    };
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    click(39, 221); // rectangle
    await pause(150);
    sharedRenderer.handleMouseDown(100, 90, 1);
    sharedRenderer.handleMouseMove(145, 120);
    sharedRenderer.handleMouseUp(190, 150, 1);
    await pause(200);
    click(91, 375); // red foreground
    await pause(100);
    click(64, 96); // fill
    await pause(100);
    click(140, 120);
    const started = performance.now();
    while (performance.now() - started < 10000) {
      await pause(100);
      sharedRenderer.repaint();
      const pixels = ctx.getImageData(105, 95, 80, 50).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 180 && pixels[i + 1] < 100 && pixels[i + 2] < 100) red++;
      }
      const app = runningApps.find(item => item && item.name === 'mspaint98');
      if (red >= 2000 && app && app.wine.running) return { red, running: true };
    }
    const app = runningApps.find(item => item && item.name === 'mspaint98');
    throw new Error('Paint browser flood fill failed: ' + JSON.stringify({
      running: !!(app && app.wine.running),
      log: document.getElementById('log').textContent.slice(-2000),
    }));
  })()`, 13000);

  const screenshot = await evaluate(`(() => {
    sharedRenderer.repaint();
    return document.getElementById('screen').toDataURL('image/png');
  })()`);
  fs.writeFileSync(PNG, Buffer.from(screenshot.replace(/^data:image\/png;base64,/, ''), 'base64'));
  assert(!/--- Program exited ---/.test(state.log), `Paint exited:\n${state.log.slice(-2500)}`);
  assert(appearance.brightRed < 40,
    `Paint tool buttons should not expose the red mask color (${appearance.brightRed} red pixels)`);
  assert(appearance.buttonFace > 1000,
    `Paint tool palette should retain Win98 button faces (${appearance.buttonFace} gray pixels)`);
  assert(fs.statSync(PNG).size > 0, 'Paint browser screenshot should be written');
  console.log('PASS  Paint Win98 stays running in the browser');
  console.log(`PASS  Paint runs on wide ${viewport.canvasWidth}x${viewport.canvasHeight} browser canvas`);
  console.log(`PASS  Paint accepts wide-layout drawing input (${interaction.changed} changed pixels)`);
  console.log(`PASS  Paint flood fill stays running and paints the closed area (${floodFill.red} red pixels)`);
  console.log('PASS  Paint frame, Tools, and Colors windows are visible');
  console.log('PASS  Paint tool-strip mask color is mapped to button face');
  console.log('PASS  screenshot:', PNG);
  cleanup();
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
