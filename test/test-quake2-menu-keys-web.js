#!/usr/bin/env node
'use strict';

// Real-browser regression for Quake II's Win32 keyboard path.  The renderer
// can receive VK codes while Quake still ignores every menu key if WM_KEYDOWN
// lParam omits the Set-1 scan code consumed by its MapKey routine.

const assert = require('assert');
const fs = require('fs');
const { startStaticServer: startSharedStaticServer } = require('./static-server');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXE = path.join(ROOT,
  'test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe');
const OUT = path.join(ROOT, 'scratch', 'quake2-menu-keys-web');

if (!fs.existsSync(CHROME) || !fs.existsSync(EXE)) {
  console.log('SKIP Chrome or local Quake II payload is absent');
  process.exit(0);
}

function startServer() {
  return startSharedStaticServer({ root: ROOT });
}

async function gameFrame(page) {
  return page.evaluate(() => {
    const win = Object.values(sharedRenderer.windows || {}).find(value =>
      value && value.visible && /Quake 2/i.test(value.title || '') &&
      (value._gpuFrameLayer || value._dxFrameLayer));
    if (!win) return null;
    if (win._gpuFrameLayer && win._gpuFrameLayer.backend) {
      const layer = win._gpuFrameLayer;
      const gl = layer.backend.gl;
      const pixels = new Uint8Array(layer.canvas.width * layer.canvas.height * 4);
      gl.readPixels(0, 0, layer.canvas.width, layer.canvas.height,
        gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { width: layer.canvas.width, height: layer.canvas.height,
        pixels: Array.from(pixels), bottomUp: true, gpu: true };
    }
    const canvas = win._dxFrameLayer.canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height,
      pixels: Array.from(pixels), bottomUp: false, gpu: false };
  });
}

function saveFrame(frame, file) {
  const png = new PNG({ width: frame.width, height: frame.height });
  for (let y = 0; y < frame.height; y++) {
    const sourceY = frame.bottomUp ? frame.height - 1 - y : y;
    const source = sourceY * frame.width * 4;
    for (let x = 0; x < frame.width * 4; x++) {
      png.data[y * frame.width * 4 + x] = frame.pixels[source + x];
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

function metrics(frame) {
  const colors = new Set();
  let black = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    const r = frame.pixels[i], g = frame.pixels[i + 1], b = frame.pixels[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (r < 8 && g < 8 && b < 8) black++;
  }
  return { colors: colors.size, black, total: frame.width * frame.height };
}

function changedPixels(before, after) {
  assert.deepStrictEqual([before.width, before.height], [after.width, after.height]);
  let changed = 0, large = 0;
  for (let i = 0; i < before.pixels.length; i += 4) {
    const delta = Math.abs(before.pixels[i] - after.pixels[i]) +
      Math.abs(before.pixels[i + 1] - after.pixels[i + 1]) +
      Math.abs(before.pixels[i + 2] - after.pixels[i + 2]);
    if (delta > 12) changed++;
    if (delta > 60) large++;
  }
  return { changed, large, total: before.width * before.height };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-q2-menu-'));
  const browser = await puppeteer.launch({
    headless: true, executablePath: CHROME, userDataDir: profile,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = [];
  const traces = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      window.__waTraceApiDetails = true;
      window.__waTraceApiNames = new Set([
        'LoadLibraryA', 'FreeLibrary', 'DestroyWindow', 'ExitProcess',
        'wglCreateContext', 'wglDeleteContext', 'wglMakeCurrent',
        'wglGetProcAddress', 'glGetString',
      ]);
    });
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    page.on('console', message => {
      const text = message.text();
      if (/^\[API\]|^\s*=>|Program exited|ref_gl|wgl/i.test(text)) traces.push(text);
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(text)) {
        errors.push(text);
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&no-log`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' && apps.quake2_demo,
      { timeout: 30000 });
    await page.evaluate(() => {
      window.__q2ColdStop = null;
      window.__q2GpuCalls = [];
      const bridge = OpenGLCompat && OpenGLCompat.OpenGLHostBridge;
      const originalGpuCall = bridge && bridge.prototype.call;
      if (originalGpuCall) {
        bridge.prototype.call = function(opcode, stack, aux) {
          const ex = this._exports();
          const esp = ex && ex.get_esp ? ex.get_esp() >>> 0 : 0;
          const args = [];
          if (ex && ex.guest_read32 && esp) {
            for (let i = 0; i < 12; i++) {
              args.push(ex.guest_read32((esp + 4 + i * 4) >>> 0) >>> 0);
            }
          }
          const event = { name: OpenGLCompat.CALLS[opcode | 0] || `opcode${opcode}`,
            opcode: opcode | 0, eip: ex && ex.get_eip ? ex.get_eip() >>> 0 : 0,
            esp, returnAddress: ex && ex.guest_read32 && esp
              ? ex.guest_read32(esp) >>> 0 : 0,
            stack: stack >>> 0, aux: aux >>> 0, args };
          let result;
          try { result = originalGpuCall.apply(this, arguments); }
          catch (error) { event.error = error && (error.stack || String(error)); throw error; }
          finally {
            event.result = result >>> 0;
            window.__q2GpuCalls.push(event);
            if (window.__q2GpuCalls.length > 512) window.__q2GpuCalls.shift();
          }
          return result;
        };
      }
      const originalStop = WineAssembly.prototype.stop;
      WineAssembly.prototype.stop = function() {
        const ex = this.instance && this.instance.exports;
        const config = this._helpCtx && this._helpCtx.vfs &&
          this._helpCtx.vfs.files.get('c:\\baseq2\\config.cfg');
        const data = config && config.data;
        let configText = '';
        if (data) {
          try { configText = new TextDecoder().decode(data.slice(0, 16384)); } catch (_) {}
        }
        const lo = this._hwndBase || 0;
        const windows = Object.values(sharedRenderer.windows || {}).filter(value =>
          value && (!lo || (value.hwnd >= lo && value.hwnd < lo + 0x10000)))
          .map(value => ({ hwnd: value.hwnd >>> 0, title: value.title || '',
            gpu: !!value._gpuFrameLayer,
            writeSeq: value._gpuFrameLayer && value._gpuFrameLayer.writeSeq || 0 }));
        window.__q2ColdStop = {
          eip: ex && ex.get_eip ? ex.get_eip() >>> 0 : 0,
          esp: ex && ex.get_esp ? ex.get_esp() >>> 0 : 0,
          eax: ex && ex.get_eax ? ex.get_eax() >>> 0 : 0,
          yieldReason: ex && ex.get_yield_reason ? ex.get_yield_reason() | 0 : -1,
          runHalt: ex && ex.get_last_run_halt ? ex.get_last_run_halt() | 0 : -1,
          previousEip: ex && ex.get_dbg_prev_eip ? ex.get_dbg_prev_eip() >>> 0 : 0,
          stopAt: this._lastWindowStopAt || 0,
          running: !!this.running,
          windows,
          configText,
          gpuCalls: window.__q2GpuCalls || [],
          stack: new Error('Quake cold-start stop').stack,
        };
        return originalStop.apply(this, arguments);
      };
    });
    await page.select('#app-select', 'quake2_demo');
    const args = await page.evaluate(() => apps.quake2_demo.args);
    assert(/\+set\s+vid_ref\s+gl/i.test(args), `production OpenGL renderer missing: ${args}`);
    assert(/\+menu_main/i.test(args), `production launch must open the ordinary menu: ${args}`);
    await page.click('button[onclick="launchApp()"]');
    await page.waitForFunction(() => {
      if (window.__q2ColdStop) return true;
      const win = Object.values(sharedRenderer.windows || {}).find(value =>
        value && value.visible && /Quake 2/i.test(value.title || '') &&
        value._gpuFrameLayer && value._gpuFrameLayer.backend);
      if (!win) return false;
      const layer = win._gpuFrameLayer;
      const canvas = layer.canvas;
      const gl = layer.backend.gl;
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const colors = new Set(); let black = 0;
      for (let i = 0; i < data.length; i += 4) {
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) black++;
      }
      // Quake's GL menu intentionally leaves most of its 640x480 background
      // near black; the real frame is still richly textured (>800 colors).
      return colors.size >= 32 && black < canvas.width * canvas.height * 0.90;
    }, { timeout: 180000, polling: 250 });

    await new Promise(resolve => setTimeout(resolve, 5000));
    const coldStart = await page.evaluate(() => {
      const app = runningApps.find(value => value && value.name === 'quake2_demo');
      return { stop: window.__q2ColdStop,
        present: !!app, running: !!(app && app.wine && app.wine.running) };
    });
    fs.writeFileSync(path.join(OUT, 'coldstart-lifecycle.json'),
      JSON.stringify({ coldStart, traces, errors }, null, 2));
    assert(!coldStart.stop && coldStart.present && coldStart.running,
      `Quake GL cold start exited: ${JSON.stringify(coldStart)}`);

    // Record the exact queued Win32 lParams while still using trusted browser
    // keyboard events for the behavior under test.
    await page.evaluate(() => {
      window.__q2KeyMessages = [];
      const original = sharedRenderer.handleKeyDown;
      sharedRenderer.handleKeyDown = function(vk, info) {
        const result = original.call(this, vk, info);
        const event = this.inputQueue.slice().reverse().find(value =>
          value && value.type === 'key' && value.msg === 0x0100 && value.wParam === vk);
        if (event) window.__q2KeyMessages.push({ vk, lParam: event.lParam >>> 0 });
        return result;
      };
    });

    const before = await gameFrame(page);
    assert(before, 'Quake main-menu frame is present');
    const first = metrics(before);
    saveFrame(before, path.join(OUT, 'main-menu.png'));
    await page.keyboard.press('ArrowDown');
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.keyboard.press('Enter');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const after = await gameFrame(page);
    assert(after, 'Quake submenu frame remains present');
    saveFrame(after, path.join(OUT, 'after-arrow-enter.png'));
    const motion = changedPixels(before, after);
    const keyMessages = await page.evaluate(() => window.__q2KeyMessages);

    assert(keyMessages.some(value => value.vk === 0x28 && value.lParam === 0x01500001),
      `ArrowDown scan code did not reach the queue: ${JSON.stringify(keyMessages)}`);
    assert(keyMessages.some(value => value.vk === 0x0D && value.lParam === 0x001C0001),
      `Enter scan code did not reach the queue: ${JSON.stringify(keyMessages)}`);
    assert(first.colors >= 32 && first.black < first.total * 0.90,
      `initial menu is black: ${JSON.stringify(first)}`);
    assert(motion.changed > motion.total * 0.02 && motion.large > motion.total * 0.005,
      `ArrowDown+Enter did not visibly open a submenu: ${JSON.stringify(motion)}`);
    assert.strictEqual(errors.length, 0, errors.join('\n'));
    console.log(`PASS Quake II menu consumes scan-coded ArrowDown+Enter; ` +
      `${motion.changed}/${motion.total} pixels changed`);
    console.log(`Screenshots: ${OUT}/main-menu.png, ${OUT}/after-arrow-enter.png`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
