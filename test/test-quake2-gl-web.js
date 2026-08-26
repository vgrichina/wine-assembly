#!/usr/bin/env node
'use strict';

// Real-browser acceptance for Quake II's ref_gl.dll. Context creation or a
// menu is not a pass: require a textured in-game framebuffer and motion after
// normal renderer keyboard input.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXE = path.join(ROOT, 'test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe');
const OUT = path.join(ROOT, 'scratch', 'quake2-gl-web');

if (!fs.existsSync(CHROME) || !fs.existsSync(EXE)) {
  console.log('SKIP Chrome or local Quake II payload is absent');
  process.exit(0);
}

function server() {
  return new Promise((resolve, reject) => {
    const root = fs.realpathSync(ROOT);
    const value = http.createServer((req, res) => {
      let name;
      try { name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
      catch (_) { res.writeHead(400); res.end(); return; }
      if (name === '/') name = '/index.html';
      const file = path.normalize(path.join(root, name));
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403); res.end(); return;
      }
      fs.readFile(file, (error, bytes) => {
        if (error) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(file);
        const type = ext === '.js' ? 'text/javascript' : ext === '.wasm'
          ? 'application/wasm' : ext === '.json' ? 'application/json'
            : ext === '.html' ? 'text/html' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(bytes);
      });
    });
    value.once('error', reject);
    value.listen(0, '127.0.0.1', () => resolve(value));
  });
}

async function frame(page) {
  return page.evaluate(() => {
    const win = Object.values(sharedRenderer.windows || {}).find(value =>
      value && value.visible && /Quake 2/i.test(value.title || '') &&
      value._gpuFrameLayer && value._gpuFrameLayer.backend);
    if (!win) return null;
    const layer = win._gpuFrameLayer, gl = layer.backend.gl;
    const width = layer.canvas.width, height = layer.canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { width, height, pixels: Array.from(pixels), writeSeq: layer.writeSeq | 0 };
  });
}

function metrics(value) {
  const colors = new Set(); let black = 0, lowerLit = 0;
  for (let i = 0; i < value.pixels.length; i += 4) {
    const r = value.pixels[i], g = value.pixels[i + 1], b = value.pixels[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (r < 8 && g < 8 && b < 8) black++;
    // readPixels starts at GL's bottom row, so its first half is the lower
    // half of the displayed (vertically flipped) PNG.
    else if ((i / 4 / value.width) < value.height / 2) lowerLit++;
  }
  return { colors: colors.size, black, lowerLit, total: value.width * value.height };
}

function changed(a, b) {
  let result = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    const d = Math.abs(a.pixels[i] - b.pixels[i]) +
      Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
      Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
    if (d > 24) result++;
  }
  return result;
}

function save(value, file) {
  const png = new PNG({ width: value.width, height: value.height });
  // readPixels is bottom-up relative to PNG.
  for (let y = 0; y < value.height; y++) {
    const src = (value.height - 1 - y) * value.width * 4;
    value.pixels.slice(src, src + value.width * 4).forEach((v, i) => {
      png.data[y * value.width * 4 + i] = v;
    });
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const web = await server();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-q2-gl-'));
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
      if (process.env.VERBOSE_GL && /gl|wgl|Quake/i.test(text)) console.log(text);
    });
    await page.goto(`http://127.0.0.1:${web.address().port}/index.html?debug&no-log`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => typeof launchApp === 'function' && apps.quake2_demo,
      { timeout: 30000 });
    await page.evaluate(() => {
      window.__q2GlFault = null;
      const original = OpenGLCompat.OpenGLHostBridge.prototype.call;
      OpenGLCompat.OpenGLHostBridge.prototype.call = function(opcode, stack, aux) {
        try { return original.apply(this, arguments); }
        catch (error) {
          const ex = this._exports();
          const dv = new DataView(this._memory());
          const pointer = opcode === OpenGLCompat.CALL_INDEX.glVertex3fv
            ? dv.getUint32((stack >>> 0) + 4, true) >>> 0 : 0;
          window.__q2GlFault = {
            name: OpenGLCompat.CALLS[opcode | 0] || `opcode${opcode}`,
            opcode: opcode | 0, pointer,
            imageBase: ex && ex.get_image_base ? ex.get_image_base() >>> 0 : 0,
            directWasm: pointer && ex && ex.get_image_base
              ? ((pointer - (ex.get_image_base() >>> 0) + 0x12000) >>> 0) : 0,
            memoryBytes: this._memory().byteLength,
            eip: ex && ex.get_eip ? ex.get_eip() >>> 0 : 0,
            esp: ex && ex.get_esp ? ex.get_esp() >>> 0 : 0,
            error: error && (error.stack || String(error)),
          };
          throw error;
        }
      };
    });
    await page.select('#app-select', 'quake2_demo');
    await page.evaluate(() => {
      WinePerf.enabled = true;
      WinePerf.guestFrames.length = 0;
    });
    const args = await page.evaluate(() => apps.quake2_demo.args);
    assert.match(args, /\+set\s+vid_ref\s+gl/i,
      `production dropdown must select OpenGL: ${args}`);
    assert.match(args, /\+menu_main/i,
      `production dropdown must open the ordinary menu: ${args}`);
    await page.evaluate(() => {
      // Keep ref_gl's immediate-mode calls cooperative with Puppeteer while
      // allowing map parsing and texture conversion to finish in test time.
      const select = document.getElementById('slice-size-select');
      const option = document.createElement('option');
      option.value = '10000'; option.textContent = '10k'; select.appendChild(option);
      select.value = '10000';
    });
    await page.click('button[onclick="launchApp()"]');
    await page.waitForFunction(() => Object.values(sharedRenderer.windows || {}).some(value =>
      value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
      value._gpuFrameLayer.writeSeq > 1), { timeout: 180000, polling: 250 });
    // Drive Quake's ordinary menu, but do not send input while the textured
    // startup console happens to satisfy the first-present gate. The menu's
    // large neutral-grey metal buttons occupy thousands of pixels in the
    // centre; console glyphs on a brown/black field cannot match this.
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
    }, { timeout: 180000, polling: 1000 });
    const menu = await frame(page);
    save(menu, path.join(OUT, 'main-menu.png'));
    await page.evaluate(() => {
      const win = Object.values(sharedRenderer.windows || {}).find(value =>
        value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
        value._gpuFrameLayer.backend);
      const layer = win._gpuFrameLayer, gl = layer.backend.gl;
      const pixels = new Uint8Array(layer.canvas.width * layer.canvas.height * 4);
      gl.readPixels(0, 0, layer.canvas.width, layer.canvas.height,
        gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      window.__q2GlMainMenu = pixels;
    });
    // GAME is selected on the main menu and the first game-menu item starts a
    // new Easy game. Both keys travel through the normal browser input path.
    await page.keyboard.down('Enter');
    await new Promise(resolve => setTimeout(resolve, 750));
    await page.keyboard.up('Enter');
    await page.waitForFunction(() => {
      const win = Object.values(sharedRenderer.windows || {}).find(value =>
        value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
        value._gpuFrameLayer.backend);
      if (!win || !window.__q2GlMainMenu) return false;
      const layer = win._gpuFrameLayer, gl = layer.backend.gl;
      const pixels = new Uint8Array(layer.canvas.width * layer.canvas.height * 4);
      gl.readPixels(0, 0, layer.canvas.width, layer.canvas.height,
        gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let changed = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - window.__q2GlMainMenu[i]) +
            Math.abs(pixels[i + 1] - window.__q2GlMainMenu[i + 1]) +
            Math.abs(pixels[i + 2] - window.__q2GlMainMenu[i + 2]) > 24) changed++;
      }
      return changed > layer.canvas.width * layer.canvas.height * 0.02;
    }, { timeout: 30000, polling: 250 });
    const gameMenu = await frame(page);
    save(gameMenu, path.join(OUT, 'game-menu.png'));
    await page.keyboard.down('Enter');
    await new Promise(resolve => setTimeout(resolve, 750));
    await page.keyboard.up('Enter');
    // Broad coverage in the displayed lower half cannot be satisfied by
    // console text or the loading background.
    const gameplayDeadline = Date.now() + 180000;
    let gameplayState;
    while (Date.now() < gameplayDeadline) {
      gameplayState = await page.evaluate(() => {
        if (window.__q2GlFault) return { fault: window.__q2GlFault, ready: false };
      const win = Object.values(sharedRenderer.windows || {}).find(value =>
        value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
        value._gpuFrameLayer.backend);
      if (!win) return { ready: false };
      const layer = win._gpuFrameLayer, gl = layer.backend.gl;
      const width = layer.canvas.width, height = layer.canvas.height;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let lowerLit = 0;
      const lowerBytes = width * Math.floor(height / 2) * 4;
      for (let i = 0; i < lowerBytes; i += 4) {
        if (pixels[i] >= 8 || pixels[i + 1] >= 8 || pixels[i + 2] >= 8) lowerLit++;
      }
      return { ready: lowerLit > width * height * 0.08 };
      });
      if (gameplayState.fault || gameplayState.ready) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (gameplayState && gameplayState.fault) {
      fs.writeFileSync(path.join(OUT, 'gameplay-fault.json'),
        JSON.stringify(gameplayState.fault, null, 2));
      assert.fail(`Quake GL gameplay host fault: ${JSON.stringify(gameplayState.fault)}`);
    }
    assert(gameplayState && gameplayState.ready, 'Quake GL gameplay frame timed out');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const before = await frame(page);
    assert(before, 'Quake GL presentation layer must exist');
    const first = metrics(before);
    save(before, path.join(OUT, 'gameplay-before.png'));
    assert(first.colors >= 48, `gameplay framebuffer has only ${first.colors} colors`);
    assert(first.black < first.total * 0.8, 'gameplay framebuffer is predominantly black');
    assert(first.lowerLit > first.total * 0.08,
      `lower-half scene coverage is only ${first.lowerLit} lit pixels (console/loading frame)`);
    await page.keyboard.down('w');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await page.keyboard.up('w');
    await new Promise(resolve => setTimeout(resolve, 800));
    const after = await frame(page);
    save(after, path.join(OUT, 'gameplay-after.png'));
    const motion = changed(before, after);
    // A short forward step changes the world edges and weapon animation even
    // when the player starts close to collision geometry. Three percent is
    // still >9k independently changed pixels at 640x480.
    assert(motion > before.width * before.height * 0.03,
      `normal-input gameplay changed only ${motion} pixels`);
    const perf = await page.evaluate(() => WinePerf.snapshot());
    assert(perf.guestFps > 0,
      `GPU presents did not reach guest FPS accounting: ${JSON.stringify(perf)}`);
    assert.strictEqual(errors.length, 0, errors.join('\n'));
    console.log(`PASS Quake II ref_gl gameplay ${before.width}x${before.height}, ` +
      `${first.colors} colors, ${motion} moved pixels, ${perf.guestFps.toFixed(1)} guest fps`);
  } finally {
    await browser.close(); web.close();
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
