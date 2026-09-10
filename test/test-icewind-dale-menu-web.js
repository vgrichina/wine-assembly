#!/usr/bin/env node

'use strict';

// Browser-path regression for the local Icewind Dale demo. The CLI acceptance
// already checks these labels, but the browser can still render the menu MOS
// and six empty stone buttons. Require the real DirectDraw layer to contain
// the light GUI-font glyphs, keep them for a sustained interval, and verify
// the two resources that supply them are mounted in the browser VFS.

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
const EXE = path.join(ROOT, 'test/binaries/candidates/icewind-dale-demo',
  'installed-extracted/Recommended_compressed/IDDemo.exe');
const OUT = path.join(ROOT,
  'build/local-candidate-smoke/icewind-dale-demo/browser-menu.png');
const STABILITY_MS = Number(process.env.IWD_MENU_STABILITY_MS || 30000);

if (!fs.existsSync(CHROME) || !fs.existsSync(EXE)) {
  console.log('SKIP  Chrome or the local Icewind Dale demo payload is absent');
  process.exit(0);
}

function mimeType(file) {
  return ({
    '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function startServer() {
  return startSharedStaticServer({ root: ROOT, mimeType });
}

async function menuFrame(page) {
  return page.evaluate(() => {
    const windows = Object.values(sharedRenderer && sharedRenderer.windows || {});
    const layer = windows.map(win => win && win._dxFrameLayer)
      .find(item => item && item.canvas && item.canvas.width === 640 &&
        item.canvas.height === 480);
    if (!layer) return null;
    const canvas = layer.canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, 640, 480).data;
    let labels = 0;
    for (const [y0, y1] of [
      [86, 101], [168, 184], [214, 230],
      [258, 274], [342, 358], [386, 402],
    ]) {
      for (let y = y0; y < y1; y++) {
        for (let x = 420; x < 548; x++) {
          const i = (y * 640 + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (Math.min(r, g, b) > 150 &&
              Math.max(r, g, b) - Math.min(r, g, b) < 60) labels++;
        }
      }
    }
    const vfs = runningApps[0] && runningApps[0].wine.hostCtx.vfs;
    const size = name => {
      const entry = vfs && vfs.files.get(name);
      return entry && entry.data ? entry.data.length : 0;
    };
    return {
      labels,
      dialog: size('c:\\dialog.tlk'),
      guiFont: size('c:\\data\\guifont.bif'),
      files: vfs ? vfs.files.size : 0,
      pixels: Array.from(data),
    };
  });
}

(async () => {
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-iwd-menu-'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
  const problems = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', error => problems.push((error && error.stack) || String(error)));
    page.on('console', message => {
      const text = message.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(text)) {
        problems.push(text);
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&no-log&iwd-menu=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('#app-select option[value="icewind_dale_demo"]'),
    { timeout: 30000 });
    await page.select('#app-select', 'icewind_dale_demo');
    await page.click('button[onclick="launchApp()"]');
    await page.waitForFunction(() => runningApps.length === 1 &&
      runningApps[0].name === 'icewind_dale_demo' && runningApps[0].wine.running &&
      runningApps[0].wine.hostCtx && runningApps[0].wine.hostCtx.vfs,
    { timeout: 90000 });

    let frame = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, attempt ? 4000 : 8000));
      await page.evaluate(() => {
        sharedRenderer.handleKeyDown(0x1B);
        sharedRenderer.handleKeyUp(0x1B);
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
      frame = await menuFrame(page);
      if (frame && frame.labels > 500) break;
    }

    assert(frame, 'Icewind Dale did not create its 640x480 DirectDraw layer');
    assert.strictEqual(frame.dialog, 2942485,
      `browser VFS has the wrong Dialog.tlk (${frame.dialog} bytes)`);
    assert(frame.guiFont > 0, 'browser VFS is missing Data/GUIfont.bif');
    assert(frame.labels > 500,
      `browser menu button labels are missing (${frame.labels} light glyph pixels)`);

    const firstLabels = frame.labels;
    const stableUntil = Date.now() + STABILITY_MS;
    while (Date.now() < stableUntil) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      frame = await menuFrame(page);
      assert(frame && frame.labels > 500,
        `browser menu labels disappeared after first rendering (${frame && frame.labels} light glyph pixels)`);
    }
    assert.strictEqual(problems.length, 0, `browser runtime failures:\n${problems.join('\n')}`);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const png = new PNG({ width: 640, height: 480 });
    png.data.set(frame.pixels);
    fs.writeFileSync(OUT, PNG.sync.write(png));
    console.log(`PASS  Icewind Dale browser menu remains painted for ${STABILITY_MS}ms (${firstLabels} -> ${frame.labels} label glyph pixels, ${frame.files} VFS paths)`);
    console.log(`Screenshot: ${OUT}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
