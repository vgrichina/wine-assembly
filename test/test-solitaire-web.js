#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'solitaire-web');
const PNG = path.join(OUT, 'initial.png');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Solitaire browser test');
  process.exit(0);
}

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
      const types = {
        '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
        '.json': 'application/json', '.wasm': 'application/wasm',
      };
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&sol-web=${Date.now()}`, {
      waitUntil: 'load', timeout: 30000,
    });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('#app-select option[value="sol"]'), { timeout: 15000 });
    await page.evaluate(async () => {
      document.getElementById('app-select').value = 'sol';
      await launchApp();
      const app = runningApps.find(item => item && item.name === 'sol');
      if (app) app.wine.stepsPerSlice = 100000;
    });
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'sol');
      const main = Object.values((sharedRenderer && sharedRenderer.windows) || {})
        .find(win => win && win.visible && win.title === 'Solitaire');
      return !!(app && app.wine.running && app.wine._runSliceCount >= 80 && main);
    }, { timeout: 30000 });

    const result = await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'sol');
      const main = Object.values(sharedRenderer.windows)
        .find(win => win && win.visible && win.title === 'Solitaire');
      const presentations = app.wine.hostCtx.sharedGdi.surfacePresentations;
      const presentation = [...presentations.values()]
        .find(item => item && item.targetHwnd === main.hwnd);
      if (presentation) presentation.flush(true);
      sharedRenderer.repaint();
      const isRed = (r, g, b) => r > 150 && r > g * 1.5 && r > b * 1.5;
      const screen = document.getElementById('screen');
      const screenPixels = screen.getContext('2d').getImageData(0, 0, screen.width, screen.height).data;
      let screenRed = 0;
      for (let i = 0; i < screenPixels.length; i += 4) {
        if (isRed(screenPixels[i], screenPixels[i + 1], screenPixels[i + 2])) screenRed++;
      }
      let surfaceRed = 0;
      if (presentation) {
        const rgba = presentation.surface.rgbaRect(0, 0, presentation.width, presentation.height);
        for (let i = 0; i < rgba.length; i += 4) {
          if (isRed(rgba[i], rgba[i + 1], rgba[i + 2])) surfaceRed++;
        }
      }
      return {
        screenRed, surfaceRed, hasPresentation: !!presentation,
        slices: app.wine._runSliceCount,
        log: document.getElementById('log').textContent,
        png: screen.toDataURL('image/png'),
      };
    });

    fs.writeFileSync(PNG, Buffer.from(result.png.split(',')[1], 'base64'));
    assert(result.hasPresentation, 'Solitaire window must use a canonical WAT surface');
    assert(result.surfaceRed >= 1000,
      `canonical Solitaire surface lost red card pixels: ${result.surfaceRed}`);
    assert(result.screenRed >= 1000,
      `browser compositor lost red card pixels: ${result.screenRed}`);
    assert(!/ERROR:|LinkError|UNIMPLEMENTED API:/.test(result.log), result.log.slice(-3000));
    console.log(`PASS  canonical surface preserves red card pixels (${result.surfaceRed})`);
    console.log(`PASS  browser compositor preserves red card pixels (${result.screenRed})`);
    console.log(`PASS  Solitaire remained live through ${result.slices} browser slices`);
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
