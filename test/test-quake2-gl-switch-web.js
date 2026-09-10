#!/usr/bin/env node
'use strict';

// Quake II renderer-switch regression. Production now starts in OpenGL; this
// test deliberately overrides only its page to software/menu, then uses
// trusted browser keyboard input to exercise the DLL/window lifecycle bug.

const assert = require('assert');
const fs = require('fs');
const { startStaticServer: startSharedStaticServer } = require('./static-server');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXE = path.join(ROOT, 'test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe');
const OUT = path.join(ROOT, 'scratch', 'quake2-gl-switch-web');

if (!fs.existsSync(CHROME) || !fs.existsSync(EXE)) {
  console.log('SKIP Chrome or local Quake II payload is absent');
  process.exit(0);
}

function startServer() {
  return startSharedStaticServer({ root: ROOT });
}

async function frame(page) {
  return page.evaluate(() => {
    const win = Object.values(sharedRenderer.windows || {}).find(value =>
      value && value.visible && /Quake 2/i.test(value.title || '') &&
      (value._gpuFrameLayer || value._dxFrameLayer));
    if (!win) return null;
    const gpu = win._gpuFrameLayer;
    const layer = gpu || win._dxFrameLayer;
    const canvas = layer.canvas;
    if (gpu && gpu.backend) {
      const gl = gpu.backend.gl;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { width: canvas.width, height: canvas.height,
        pixels: Array.from(pixels), bottomUp: true, gpu: true,
        writeSeq: gpu.writeSeq | 0 };
    }
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height,
      pixels: Array.from(pixels), bottomUp: false, gpu: false, writeSeq: 0 };
  });
}

function metrics(value) {
  const colors = new Set(); let black = 0;
  for (let i = 0; i < value.pixels.length; i += 4) {
    const r = value.pixels[i], g = value.pixels[i + 1], b = value.pixels[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (r < 8 && g < 8 && b < 8) black++;
  }
  return { colors: colors.size, black, total: value.width * value.height };
}

function save(value, name) {
  const png = new PNG({ width: value.width, height: value.height });
  for (let y = 0; y < value.height; y++) {
    const sourceY = value.bottomUp ? value.height - 1 - y : y;
    const source = sourceY * value.width * 4;
    for (let x = 0; x < value.width * 4; x++) {
      png.data[y * value.width * 4 + x] = value.pixels[source + x];
    }
  }
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));
}

async function press(page, key, delay = 250) {
  await page.keyboard.press(key);
  await new Promise(resolve => setTimeout(resolve, delay));
}

async function pressAndDrain(page, key, settle = 750) {
  // Quake polls key state. A same-turn synthetic down/up can be invisible
  // even after both host events drain, so hold across cooperative slices.
  await page.keyboard.down(key);
  await new Promise(resolve => setTimeout(resolve, 750));
  await page.keyboard.up(key);
  await page.waitForFunction(() => !sharedRenderer.inputQueue.some(event =>
    event && event.type === 'key'), { timeout: 15000, polling: 25 });
  await new Promise(resolve => setTimeout(resolve, settle));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-q2-gl-switch-'));
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
      ]);
    });
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    page.on('console', message => {
      const text = message.text();
      if (/^\[API\]|^\s*=>/.test(text)) traces.push(text);
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(text)) errors.push(text);
      if (process.env.VERBOSE_SWITCH && /Quake|ref_|exit|window|gl/i.test(text)) console.log(text);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&no-log`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => typeof launchApp === 'function' && apps.quake2_demo,
      { timeout: 30000 });
    await page.select('#app-select', 'quake2_demo');
    const args = await page.evaluate(() => apps.quake2_demo.args);
    assert.match(args, /\+set\s+vid_ref\s+gl/i,
      `production dropdown must select OpenGL: ${args}`);
    assert.match(args, /\+menu_main/i);
    await page.evaluate(() => {
      // This is intentionally the inverse of the production GL default: it
      // preserves the user's reported software -> OpenGL Apply lifecycle path.
      apps.quake2_demo.args = '+set vid_ref soft +menu_main';
    });
    await page.click('button[onclick="launchApp()"]');
    await page.waitForFunction(() => {
      const win = Object.values(sharedRenderer.windows || {}).find(value =>
        value && value.visible && /Quake 2/i.test(value.title || '') &&
        value._dxFrameLayer && !value._gpuFrameLayer);
      if (!win) return false;
      const canvas = win._dxFrameLayer.canvas;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set(); let black = 0;
      for (let i = 0; i < data.length; i += 4) {
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) black++;
      }
      return colors.size >= 32 && black < canvas.width * canvas.height * 0.85;
    }, { timeout: 180000, polling: 250 });
    const main = await frame(page);
    save(main, 'software-main-menu.png');

    // Preserve the production app/arguments while making individual UI
    // events observable. At 100k blocks one slice can outlive the harness's
    // key delay and several key pairs queue before Quake consumes the first.
    await page.evaluate(() => {
      const app = runningApps.find(value => value && value.name === 'quake2_demo');
      if (app && app.wine) app.wine.stepsPerSlice = 10000;
    });

    await press(page, 'ArrowDown');
    await press(page, 'ArrowDown');
    await press(page, 'ArrowDown');
    await press(page, 'Enter', 1500);
    const video = await frame(page);
    assert(video && !video.gpu, 'Video menu remains on the software renderer');
    save(video, 'software-video-menu.png');
    assert(metrics(video).colors >= 24, 'Video menu rendered enough distinct colors');

    if (process.env.STOP_AT_VIDEO_MENU) {
      console.log(`PASS captured production Quake Video menu: ${OUT}/software-video-menu.png`);
      return;
    }

    // Driver is the selected first row. Right selects default OpenGL. Walk the
    // authentic keyboard cursor one item at a time and preserve every frame:
    // this menu does not reliably select rows from an absolute mouse click.
    await pressAndDrain(page, 'ArrowRight');
    save(await frame(page), 'opengl-selected.png');
    save(await frame(page), 'before-apply.png');

    await page.evaluate(() => {
      const app = runningApps.find(value => value && value.name === 'quake2_demo');
      const wine = app && app.wine;
      window.__q2SwitchLifecycle = [];
      window.__q2SwitchStart = performance.now();
      const snapshot = type => {
        const current = runningApps.find(value => value && value.name === 'quake2_demo');
        const instance = current && current.wine;
        const lo = instance && instance._hwndBase || 0;
        const windows = Object.values(sharedRenderer.windows || {}).filter(value =>
          value && (!lo || (value.hwnd >= lo && value.hwnd < lo + 0x10000)))
          .map(value => ({ hwnd: value.hwnd >>> 0, title: value.title || '',
            child: !!value.isChild, gpu: !!value._gpuFrameLayer }));
        const dlls = [];
        const ex = instance && instance.instance && instance.instance.exports;
        if (ex && ex.get_dll_table && ex.get_dll_count && ex.get_image_base) {
          const dv = new DataView(instance.memory.buffer);
          const mem = new Uint8Array(instance.memory.buffer);
          const table = ex.get_dll_table() >>> 0;
          const imageBase = ex.get_image_base() >>> 0;
          const g2w = address => (address - imageBase + 0x12000) >>> 0;
          const readString = address => {
            let result = '';
            for (let i = 0; i < 128 && address + i < mem.length; i++) {
              const ch = mem[address + i];
              if (!ch) break;
              result += String.fromCharCode(ch);
            }
            return result;
          };
          for (let i = 0; i < (ex.get_dll_count() | 0); i++) {
            const entry = table + i * 32;
            const base = dv.getUint32(entry, true) >>> 0;
            const exportRva = dv.getUint32(entry + 8, true) >>> 0;
            let name = '';
            if (base && exportRva) {
              const exportAddress = g2w((base + exportRva) >>> 0);
              const nameRva = dv.getUint32(exportAddress + 12, true) >>> 0;
              if (nameRva) name = readString(g2w((base + nameRva) >>> 0));
            }
            dlls.push({ index: i, name, base });
          }
        }
        window.__q2SwitchLifecycle.push({ type,
          ms: Math.round(performance.now() - window.__q2SwitchStart),
          present: !!current, running: !!(instance && instance.running),
          stopAt: instance && instance._lastWindowStopAt || 0, windows, dlls });
      };
      if (wine) {
        const originalStop = wine.stop;
        wine.stop = function() {
          snapshot('stop-called');
          window.__q2SwitchStopStack = new Error('Quake stop').stack;
          return originalStop.apply(this, arguments);
        };
      }
      snapshot('before-apply');
      window.__q2SwitchTimer = setInterval(() => {
        const before = window.__q2SwitchLifecycle.at(-1);
        snapshot('poll');
        const after = window.__q2SwitchLifecycle.at(-1);
        const stable = before && before.present === after.present &&
          before.running === after.running && before.stopAt === after.stopAt &&
          JSON.stringify(before.windows) === JSON.stringify(after.windows);
        if (stable) window.__q2SwitchLifecycle.pop();
      }, 25);
    });

    // Reset is not in Quake's keyboard cursor order; seven Downs selects Apply.
    for (let i = 1; i <= 7; i++) {
      await pressAndDrain(page, 'ArrowDown');
      save(await frame(page), `cursor-down-${i}.png`);
    }
    await pressAndDrain(page, 'Enter', 250);
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.waitForFunction(() => {
      const app = runningApps.find(value => value && value.name === 'quake2_demo');
      const gpu = Object.values(sharedRenderer.windows || {}).some(value =>
        value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
        value._gpuFrameLayer.writeSeq > 1);
      return !app || !app.wine.running || gpu;
    }, { timeout: 180000, polling: 50 }).catch(() => {});
    const state = await page.evaluate(() => {
      clearInterval(window.__q2SwitchTimer);
      const app = runningApps.find(value => value && value.name === 'quake2_demo');
      const gpu = Object.values(sharedRenderer.windows || {}).some(value =>
        value && /Quake 2/i.test(value.title || '') && value._gpuFrameLayer &&
        value._gpuFrameLayer.writeSeq > 0);
      return { present: !!app, running: !!(app && app.wine.running), gpu,
        lifecycle: window.__q2SwitchLifecycle || [],
        stopStack: window.__q2SwitchStopStack || '' };
    });
    const after = await frame(page);
    if (after) save(after, 'after-apply.png');
    fs.writeFileSync(path.join(OUT, 'lifecycle.json'), JSON.stringify({ state, traces }, null, 2));

    if (process.env.EXPECT_EXIT) {
      assert(!state.present || !state.running,
        `expected reported process exit, got ${JSON.stringify(state)}`);
      console.log(`PASS reproduced Quake renderer-switch exit: ${OUT}/lifecycle.json`);
      return;
    }
    assert(state.present && state.running, `Quake exited during renderer switch: ${JSON.stringify(state)}`);
    assert(state.gpu, `Quake stayed alive but did not present OpenGL: ${JSON.stringify(state)}`);
    assert.strictEqual(errors.length, 0, errors.join('\n'));
    console.log(`PASS Quake software -> OpenGL Apply remains alive: ${OUT}/after-apply.png`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
