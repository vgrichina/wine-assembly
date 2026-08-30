#!/usr/bin/env node
'use strict';

// Production-browser input acceptance for Quake II. This deliberately uses
// the dropdown's real OpenGL +menu_main command line, trusted CDP keyboard and
// mouse events, and Quake's own ClipCursor/GetCursorPos path.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXE = path.join(ROOT,
  'test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe');
const OUT = path.join(ROOT, 'scratch', 'quake2-input-web');

if (!fs.existsSync(CHROME) || !fs.existsSync(EXE)) {
  console.log('SKIP Chrome or local Quake II payload is absent');
  process.exit(0);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const root = fs.realpathSync(ROOT);
    const server = http.createServer((request, response) => {
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
      catch (_) { response.writeHead(400); response.end(); return; }
      if (pathname === '/') pathname = '/index.html';
      const file = path.normalize(path.join(root, pathname));
      if (file !== root && !file.startsWith(root + path.sep)) {
        response.writeHead(403); response.end(); return;
      }
      fs.readFile(file, (error, bytes) => {
        if (error) { response.writeHead(404); response.end(); return; }
        const ext = path.extname(file).toLowerCase();
        const type = ext === '.js' ? 'text/javascript' : ext === '.wasm'
          ? 'application/wasm' : ext === '.json' ? 'application/json'
            : ext === '.html' ? 'text/html' : 'application/octet-stream';
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(bytes);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function readFrame(page) {
  return page.evaluate(() => {
    const win = Object.values(sharedRenderer.windows || {}).find(value =>
      value && value.visible && /Quake 2/i.test(value.title || '') &&
      value._gpuFrameLayer && value._gpuFrameLayer.backend);
    if (!win) return null;
    const layer = win._gpuFrameLayer;
    const gl = layer.backend.gl;
    const pixels = new Uint8Array(layer.canvas.width * layer.canvas.height * 4);
    gl.readPixels(0, 0, layer.canvas.width, layer.canvas.height,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { width: layer.canvas.width, height: layer.canvas.height,
      pixels: Array.from(pixels), writeSeq: layer.writeSeq | 0 };
  });
}

function changedPixels(before, after) {
  assert(before && after);
  assert.deepStrictEqual([before.width, before.height], [after.width, after.height]);
  let changed = 0;
  for (let i = 0; i < before.pixels.length; i += 4) {
    const delta = Math.abs(before.pixels[i] - after.pixels[i]) +
      Math.abs(before.pixels[i + 1] - after.pixels[i + 1]) +
      Math.abs(before.pixels[i + 2] - after.pixels[i + 2]);
    if (delta > 24) changed++;
  }
  return changed;
}

function saveFrame(frame, file) {
  const png = new PNG({ width: frame.width, height: frame.height });
  for (let y = 0; y < frame.height; y++) {
    const source = (frame.height - 1 - y) * frame.width * 4;
    for (let x = 0; x < frame.width * 4; x++) {
      png.data[y * frame.width * 4 + x] = frame.pixels[source + x];
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

async function heldKey(page, key, holdMs) {
  await page.keyboard.down(key);
  await new Promise(resolve => setTimeout(resolve, holdMs));
  await page.keyboard.up(key);
}

async function waitForMainMenu(page) {
  await page.waitForFunction(() => {
    const win = Object.values(sharedRenderer.windows || {}).find(value =>
      value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
      value._gpuFrameLayer.backend);
    if (!win) return false;
    const layer = win._gpuFrameLayer, gl = layer.backend.gl;
    const width = layer.canvas.width, height = layer.canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let neutral = 0;
    for (let y = Math.floor(height * 0.18); y < Math.floor(height * 0.72); y++) {
      for (let x = Math.floor(width * 0.2); x < Math.floor(width * 0.8); x++) {
        const i = ((height - 1 - y) * width + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (r >= 28 && r <= 180 && Math.abs(r - g) <= 12 && Math.abs(g - b) <= 12) neutral++;
      }
    }
    return neutral > width * height * 0.025;
  }, { timeout: 240000, polling: 1000 });
}

async function waitForGameplay(page) {
  await page.waitForFunction(() => {
    const win = Object.values(sharedRenderer.windows || {}).find(value =>
      value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
      value._gpuFrameLayer.backend);
    if (!win) return false;
    const layer = win._gpuFrameLayer, gl = layer.backend.gl;
    const width = layer.canvas.width, height = layer.canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lowerLit = 0;
    for (let i = 0; i < width * Math.floor(height / 2) * 4; i += 4) {
      if (pixels[i] >= 8 || pixels[i + 1] >= 8 || pixels[i + 2] >= 8) lowerLit++;
    }
    return lowerLit > width * height * 0.08;
  }, { timeout: 240000, polling: 500 });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-q2-input-'));
  const browser = await puppeteer.launch({
    headless: true, executablePath: CHROME, userDataDir: profile,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    page.on('console', message => {
      const text = message.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(text)) errors.push(text);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&no-log`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => typeof launchApp === 'function' && apps.quake2_demo,
      { timeout: 30000 });
    await page.evaluate(() => {
      window.__q2Input = { dom: [], taken: [], relative: [], absolute: [] };
      for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup']) {
        window.addEventListener(type, event => {
          window.__q2Input.dom.push({ type, trusted: event.isTrusted,
            keyCode: event.keyCode | 0, button: event.button | 0 });
        }, true);
      }
    });
    await page.select('#app-select', 'quake2_demo');
    const args = await page.evaluate(() => apps.quake2_demo.args);
    assert.match(args, /\+set\s+vid_ref\s+gl/i, `production renderer is not GL: ${args}`);
    assert.match(args, /\+menu_main/i, `production launch does not use the main menu: ${args}`);
    await page.evaluate(() => {
      window.WINE_THREADS = false;
      localStorage.setItem('wine-assembly.threads', '0');
      const select = document.getElementById('slice-size-select');
      const option = document.createElement('option');
      option.value = '10000'; option.textContent = '10k'; select.appendChild(option);
      select.value = '10000';
    });
    await page.click('button[onclick="launchApp()"]');
    await page.waitForFunction(() => sharedRenderer && typeof sharedRenderer.takeInput === 'function',
      { timeout: 120000 });
    await page.evaluate(() => {
      const take = sharedRenderer.takeInput;
      sharedRenderer.takeInput = function() {
        const event = take.apply(this, arguments);
        if (event && (event.type === 'key' || event.type === 'mouse')) {
          window.__q2Input.taken.push({ msg: event.msg >>> 0,
            wParam: event.wParam >>> 0, lParam: event.lParam >>> 0 });
        }
        return event;
      };
      const relative = sharedRenderer.handleRelativeMouseMove;
      sharedRenderer.handleRelativeMouseMove = function(dx, dy) {
        const before = [this._mouseX | 0, this._mouseY | 0];
        const result = relative.apply(this, arguments);
        window.__q2Input.relative.push({ dx, dy, before,
          after: [this._mouseX | 0, this._mouseY | 0] });
        return result;
      };
      const absolute = sharedRenderer.handleMouseMove;
      sharedRenderer.handleMouseMove = function(x, y, motion) {
        window.__q2Input.absolute.push({ x, y, relative: !!(motion && motion.relative) });
        return absolute.apply(this, arguments);
      };
    });
    await waitForMainMenu(page);
    await heldKey(page, 'Enter', 750);
    await new Promise(resolve => setTimeout(resolve, 750));
    await heldKey(page, 'Enter', 750);
    await waitForGameplay(page);
    await new Promise(resolve => setTimeout(resolve, 800));
    const controlConfig = await page.evaluate(() => {
      const app = runningApps.find(value => value && value.name === 'quake2_demo');
      const entry = app && app.wine && app.wine._helpCtx && app.wine._helpCtx.vfs &&
        app.wine._helpCtx.vfs.files.get('c:\\baseq2\\config.cfg');
      return entry && entry.data ? new TextDecoder().decode(entry.data) : '';
    });
    assert(/bind\s+"?w"?\s+"\+forward"/i.test(controlConfig) &&
      /bind\s+"?a"?\s+"\+moveleft"/i.test(controlConfig) &&
      /set\s+freelook\s+"?1"?/i.test(controlConfig),
    `modern first-launch controls were not mounted: ${controlConfig.slice(0, 500)}`);

    const beforeKey = await readFrame(page);
    saveFrame(beforeKey, path.join(OUT, 'before-key.png'));
    await page.keyboard.down('w');
    await new Promise(resolve => setTimeout(resolve, 800));
    const heldState = await page.evaluate(() => ({
      down: !!(sharedRenderer._asyncKeys && sharedRenderer._asyncKeys[87]),
      queued: sharedRenderer.inputQueue.filter(event => event && event.type === 'key').length,
    }));
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.keyboard.up('w');
    await page.waitForFunction(() =>
      !(sharedRenderer._asyncKeys && sharedRenderer._asyncKeys[87]) &&
      !sharedRenderer.inputQueue.some(event => event && event.type === 'key'),
    { timeout: 30000, polling: 50 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const afterKey = await readFrame(page);
    saveFrame(afterKey, path.join(OUT, 'after-key.png'));
    const keyMotion = changedPixels(beforeKey, afterKey);

    const mouseState = await page.evaluate(() => {
      const app = runningApps.find(value => value && value.name === 'quake2_demo');
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      return {
        clip: !!(e && e.clip_cursor_active && e.clip_cursor_active()),
        bounds: e && e.clip_cursor_active && e.clip_cursor_active() ?
          [e.clip_cursor_left() | 0, e.clip_cursor_top() | 0,
            e.clip_cursor_right() | 0, e.clip_cursor_bottom() | 0] : [],
        exclusive: !!(sharedRenderer._exclusiveTransform ||
          sharedRenderer._exclusivePresentationViewport),
      };
    });
    assert(mouseState.clip && mouseState.exclusive,
      `Quake did not activate exclusive ClipCursor input: ${JSON.stringify(mouseState)}`);
    const canvas = await page.$('#screen');
    const box = await canvas.boundingBox();
    await page.evaluate(() => { window.__q2Input.absolute.length = 0; });
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.55,
      { steps: 4 });
    const preLockAbsolute = await page.evaluate(() => window.__q2Input.absolute.slice());
    assert.deepStrictEqual(preLockAbsolute, [],
      `pre-lock absolute mouse motion entered Quake's recenter loop: ${JSON.stringify(preLockAbsolute)}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.pointerLockElement === document.getElementById('screen'),
      { timeout: 10000, polling: 50 });
    const beforeMouse = await readFrame(page);
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.55,
      { steps: 6 });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const shotTakenStart = await page.evaluate(() => window.__q2Input.taken.length);
    const shotStates = [];
    for (let i = 0; i < 12; i++) {
      await page.mouse.down({ button: 'left' });
      await new Promise(resolve => setTimeout(resolve, 30 + (i % 3) * 35));
      const held = await page.evaluate(() => ({ mask: sharedRenderer._mouseButtonsMask | 0 }));
      await page.mouse.up({ button: 'left' });
      await new Promise(resolve => setTimeout(resolve, 80));
      const released = await page.evaluate(() => ({ mask: sharedRenderer._mouseButtonsMask | 0 }));
      shotStates.push({ held, released });
    }
    const heldMouseState = shotStates[0].held;
    const releasedMouseState = shotStates.at(-1).released;
    const afterMouse = await readFrame(page);
    saveFrame(afterMouse, path.join(OUT, 'after-mouse.png'));
    const mouseMotion = changedPixels(beforeMouse, afterMouse);
    const input = await page.evaluate(() => {
      const value = window.__q2Input;
      value.pointerLocked = document.pointerLockElement === document.getElementById('screen');
      return value;
    });
    fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify({
      args, controlConfig, heldState, mouseState, heldMouseState, releasedMouseState,
      shotStates, shotTakenStart, preLockAbsolute,
      keyMotion, mouseMotion, input,
    }, null, 2));

    assert(heldState.down, `held W was not visible to GetKeyState/GetAsyncKeyState: ${JSON.stringify(heldState)}`);
    const wDown = input.taken.find(event => event.msg === 0x0100 && event.wParam === 87);
    const wUp = input.taken.find(event => event.msg === 0x0101 && event.wParam === 87);
    assert(wDown && ((wDown.lParam >>> 16) & 0xFF) === 0x11,
      `WM_KEYDOWN/W scan code did not reach the Win32 queue: ${JSON.stringify(wDown)}`);
    assert(wUp && ((wUp.lParam & 0xC0000000) >>> 0) === 0xC0000000,
      `WM_KEYUP/W transition bits did not reach the Win32 queue: ${JSON.stringify(wUp)}`);
    assert(input.dom.some(event => event.type === 'keydown' && event.keyCode === 87 && event.trusted) &&
      input.dom.some(event => event.type === 'keyup' && event.keyCode === 87 && event.trusted),
    'W input must come from trusted browser events');
    // Quake starts close to collision geometry, so a short forward step need
    // not cross three percent of the frame. Two percent is still >6,000
    // independently changed pixels at 640x480 and cannot be a key highlight.
    assert(keyMotion > beforeKey.width * beforeKey.height * 0.02,
      `held W changed only ${keyMotion} gameplay pixels`);
    assert(input.pointerLocked && input.relative.some(event => Math.abs(event.dx) + Math.abs(event.dy) > 0),
      `trusted mouse motion missed pointer-lock relative routing: ${JSON.stringify(input.relative)}`);
    assert(shotStates.every(state => state.held.mask & 1),
      `pointer-locked mouse down missed a left-button mask: ${JSON.stringify(shotStates)}`);
    assert(shotStates.every(state => !(state.released.mask & 1)),
      `pointer-locked mouse up left a fire button held: ${JSON.stringify(shotStates)}`);
    assert(input.dom.some(event => event.type === 'mouseup' && event.button === 0 && event.trusted),
      'pointer-locked release must come from a trusted browser mouseup');
    const shotEvents = input.taken.slice(shotTakenStart);
    assert(shotEvents.filter(event => event.msg === 0x0201).length >= shotStates.length,
      `pointer-locked fire did not deliver WM_LBUTTONDOWN: ${JSON.stringify(shotEvents)}`);
    assert(shotEvents.filter(event => event.msg === 0x0202).length >= shotStates.length,
      `pointer-locked release did not deliver WM_LBUTTONUP: ${JSON.stringify(shotEvents)}`);
    assert(mouseMotion > beforeMouse.width * beforeMouse.height * 0.01,
      `relative mouse look changed only ${mouseMotion} gameplay pixels`);
    assert.strictEqual(errors.length, 0, errors.join('\n'));
    console.log(`PASS Quake II input: W ${keyMotion} pixels, mouse ${mouseMotion} pixels, ` +
      `${input.relative.length} relative samples, clip=${mouseState.bounds.join(',')}`);
    console.log(`Artifacts: ${OUT}`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
