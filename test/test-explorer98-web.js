#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { startStaticServer } = require('./static-server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'explorer98-web');
const PNG = path.join(OUT, 'desktop.png');
const viewportMatch = String(process.env.EXPLORER_VIEWPORT || '1280x900')
  .match(/^(\d+)x(\d+)$/i);
if (!viewportMatch) throw new Error('EXPLORER_VIEWPORT must be WIDTHxHEIGHT');
const VIEWPORT = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };
const requestedTrace = String(process.env.EXPLORER_TRACE_API || '')
  .split(',').map(name => name.trim()).filter(Boolean);
const TRACE_API = requestedTrace.includes('*')
  ? require('../src/api_table.json').map(entry => entry.name)
  : requestedTrace;
const STARTUP_TIMEOUT_MS = Number(process.env.EXPLORER_TIMEOUT_MS || 60000);
const STEPS_PER_SLICE = Number(process.env.EXPLORER_STEPS_PER_SLICE || 100000);

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Explorer 98 browser test');
  process.exit(0);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer({ root: ROOT });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', message => {
      if (message.type() === 'error') console.error(`browser: ${message.text()}`);
      else if (TRACE_API.length && message.text().startsWith('[API]')) {
        console.log(message.text());
      }
    });
    page.on('pageerror', error => console.error(`browser page error: ${error.message}`));
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
    await page.goto(
      `http://127.0.0.1:${server.address().port}/index.html?debug&explorer98-web=${Date.now()}`,
      { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('#app-select option[value="explorer98"]'),
    { timeout: 20000 });
    await page.evaluate(async ({ traceApi, stepsPerSlice }) => {
      window.__waTraceApiNames = new Set(traceApi);
      stopAllApps();
      const select = document.getElementById('app-select');
      select.value = 'explorer98';
      await shell.launchApp('explorer98');
      const app = runningApps.find(item => item && item.name === 'explorer98');
      if (!app || runningApps.length !== 1) {
        throw new Error(`Explorer harness launched wrong app set: ${
          runningApps.map(item => item && item.name).join(',')}`);
      }
      if (app) app.wine.stepsPerSlice = stepsPerSlice;
    }, { traceApi: TRACE_API, stepsPerSlice: STEPS_PER_SLICE });
    try {
      await page.waitForFunction(() => {
        const app = runningApps.find(item => item && item.name === 'explorer98');
        const windows = Object.values((sharedRenderer && sharedRenderer.windows) || {});
        return !!(app && app.wine.running && app.wine._runSliceCount >= 120 &&
          windows.some(win => win && win.visible && win.className === 'Progman') &&
          windows.some(win => win && win.visible && win.className === 'Shell_TrayWnd') &&
          windows.some(win => win && win.visible && win.className === 'SysListView32'));
      }, { timeout: STARTUP_TIMEOUT_MS });
    } catch (error) {
      const state = await page.evaluate(() => {
        const app = runningApps.find(item => item && item.name === 'explorer98');
        return {
          app: app && { running: app.wine.running, slices: app.wine._runSliceCount },
          canvas: (() => {
            const screen = document.getElementById('screen');
            return screen && [screen.width, screen.height];
          })(),
          windows: Object.values((sharedRenderer && sharedRenderer.windows) || {})
            .map(win => win && ({ hwnd: win.hwnd, visible: win.visible,
              className: win.className, title: win.title })),
          log: document.getElementById('log').textContent.slice(-4000),
        };
      });
      throw new Error(`${error.message}\nExplorer browser state: ${JSON.stringify(state, null, 2)}`);
    }

    // Exercise the same callback-backed ListView paint boundary as a real
    // exposed desktop. This asks stock SHELL32 for its PIDL label/image data;
    // it does not seed or substitute any desktop content in the harness.
    await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'explorer98');
      const list = Object.values(sharedRenderer.windows)
        .find(win => win && win.visible && win.className === 'SysListView32');
      app.wine.instance.exports.send_message(list.hwnd, 0x000F, 0, 0);
      sharedRenderer.repaint();
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'explorer98');
      const list = Object.values(sharedRenderer.windows)
        .find(win => win && win.visible && win.className === 'SysListView32');
      const e = app.wine.instance.exports;
      const buf = e.guest_alloc(64);
      const textLength = e.listview_get_item_text(list.hwnd, 0, 0, buf, 64) | 0;
      const wa = (buf - e.get_image_base() + 0x12000) >>> 0;
      const labelBytes = new Uint8Array(
        app.wine.memory.buffer, wa, Math.max(0, textLength));
      let label = '';
      for (const byte of labelBytes) label += String.fromCharCode(byte);

      sharedRenderer.repaint();
      const screen = document.getElementById('screen');
      const ctx = screen.getContext('2d');
      const pixels = ctx.getImageData(0, 0, screen.width, screen.height).data;
      let teal = 0;
      let taskbarGray = 0;
      let iconInk = 0;
      for (let y = 0; y < screen.height; y++) {
        for (let x = 0; x < screen.width; x++) {
          const i = (y * screen.width + x) * 4;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          if (r < 8 && g >= 118 && g <= 138 && b >= 118 && b <= 138) teal++;
          if (y >= screen.height - 30 && r >= 150 && r <= 230 &&
              Math.max(r, g, b) - Math.min(r, g, b) <= 12) taskbarGray++;
          if (x < 100 && y < 140 &&
              !(r < 8 && g >= 118 && g <= 138 && b >= 118 && b <= 138) &&
              (r > 24 || g > 24 || b > 24)) iconInk++;
        }
      }
      return {
        width: screen.width,
        height: screen.height,
        teal,
        taskbarGray,
        iconInk,
        label,
        slices: app.wine._runSliceCount,
        dlls: Object.keys(app.wine._loadedDllBytesByName || {}).sort(),
        log: document.getElementById('log').textContent,
        png: screen.toDataURL('image/png'),
      };
    });

    fs.writeFileSync(PNG, Buffer.from(result.png.split(',')[1], 'base64'));
    for (const dll of ['browseui.dll', 'shdoc401.dll', 'ole32.dll', 'shlwapi.dll',
      'shdocvw.dll', 'comctl32.dll', 'shell32.dll']) {
      assert(result.dlls.includes(dll), `browser did not load local stock ${dll}`);
    }
    assert.strictEqual(result.label, 'My Computer',
      `stock DefView callback label mismatch: ${JSON.stringify(result.label)}`);
    assert(result.teal > 200000,
      `desktop screenshot lacks COLOR_DESKTOP pixels: ${result.teal}`);
    assert(result.taskbarGray > 5000,
      `desktop screenshot lacks the stock taskbar band: ${result.taskbarGray}`);
    assert(result.iconInk > 500,
      `desktop screenshot lacks rendered icon/label pixels: ${result.iconInk}`);
    assert(!/ERROR:|LinkError|UNIMPLEMENTED API:/.test(result.log), result.log.slice(-4000));
    console.log(`PASS  web Explorer loaded all seven local stock DLLs`);
    console.log(`PASS  screenshot has desktop=${result.teal}, taskbar=${result.taskbarGray}, icon=${result.iconInk} pixels`);
    console.log(`PASS  stock callback rendered ${JSON.stringify(result.label)} through ${result.slices} slices`);
    console.log(`Snapshot: ${PNG}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
