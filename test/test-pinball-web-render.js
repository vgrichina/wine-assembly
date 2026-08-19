#!/usr/bin/env node

'use strict';

// Browser presentation regression for Pinball. The gameplay CLI captures the
// canonical WAT window surface directly; this test additionally proves that
// the browser-facing derived Canvas and desktop compositor show those pixels.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXE = path.join(ROOT, 'binaries', 'pinball', 'pinball.exe');
const OUT = path.join(ROOT, 'scratch', 'pinball-web-render');
const SCREENSHOT = path.join(OUT, 'composed.png');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Pinball browser render test');
  process.exit(0);
}
if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  if (ext === '.fon') return 'application/octet-stream';
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  try { fs.unlinkSync(SCREENSHOT); } catch (_) {}
  const server = await startStaticServer();
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-pinball-web-'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  const failures = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', error => failures.push(String(error)));
    page.on('console', message => {
      const text = message.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(text)) failures.push(text);
    });
    await page.goto(`http://127.0.0.1:${port}/index.html?pinball-web-render=${Date.now()}`, {
      waitUntil: 'networkidle0', timeout: 30000,
    });
    await page.waitForFunction(() =>
      document.readyState === 'complete' && typeof launchApp === 'function' && typeof sharedRenderer !== 'undefined',
    { timeout: 20000 });
    await page.evaluate(() => {
      document.getElementById('app-select').value = 'pinball';
      return launchApp();
    });
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'pinball');
      const win = Object.values(sharedRenderer.windows || {}).find(item =>
        item && item.visible && /3D Pinball for Windows/i.test(item.title || ''));
      const presentations = app && app.wine && app.wine.hostCtx && app.wine.hostCtx.sharedGdi &&
        app.wine.hostCtx.sharedGdi.surfacePresentations;
      const surface = presentations && [...presentations.values()].find(item =>
        item && win && item.targetHwnd === win.hwnd);
      return !!(app && app.wine.running && win && surface && surface.flushCount >= 20);
    }, { timeout: 90000, polling: 100 });
    await new Promise(resolve => setTimeout(resolve, 2500));

    const result = await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'pinball');
      const win = Object.values(sharedRenderer.windows || {}).find(item =>
        item && item.visible && /3D Pinball for Windows/i.test(item.title || ''));
      const presentations = app.wine.hostCtx.sharedGdi.surfacePresentations;
      const presentation = [...presentations.values()].find(item => item && item.targetHwnd === win.hwnd);
      presentation.flush(true);
      sharedRenderer.repaint();

      const screen = document.getElementById('screen');
      const localX = Math.max(0, -win.x);
      const localY = Math.max(0, -win.y);
      const width = Math.max(0, Math.min(win.w - localX, screen.width - win.x - localX));
      const height = Math.max(0, Math.min(win.h - localY, screen.height - win.y - localY));
      const screenData = screen.getContext('2d').getImageData(
        win.x + localX, win.y + localY, width, height).data;
      const surfaceData = presentation.canvasContext.getImageData(localX, localY, width, height).data;
      let different = 0;
      let black = 0;
      const colors = new Set();
      for (let i = 0; i < screenData.length; i += 4) {
        if (screenData[i] !== surfaceData[i] || screenData[i + 1] !== surfaceData[i + 1] ||
            screenData[i + 2] !== surfaceData[i + 2] || screenData[i + 3] !== surfaceData[i + 3]) different++;
        if (screenData[i] < 8 && screenData[i + 1] < 8 && screenData[i + 2] < 8) black++;
        colors.add((screenData[i] << 16) | (screenData[i + 1] << 8) | screenData[i + 2]);
      }
      const crop = document.createElement('canvas');
      crop.width = width;
      crop.height = height;
      crop.getContext('2d').drawImage(screen,
        win.x + localX, win.y + localY, width, height, 0, 0, width, height);
      return {
        hwnd: win.hwnd, width, height,
        flushCount: presentation.flushCount,
        flushedPixels: presentation.flushedPixels,
        different, total: width * height,
        colors: colors.size, black,
        png: crop.toDataURL('image/png'),
        running: app.wine.running,
      };
    });

    fs.writeFileSync(SCREENSHOT,
      Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
    delete result.png;
    assert(result.running, 'Pinball should remain running after presentation capture');
    assert(result.width >= 590 && result.height >= 440,
      `Pinball composed window should be full size: ${JSON.stringify(result)}`);
    assert(result.flushCount >= 20 && result.flushedPixels >= 100000,
      `canonical surface should have uploaded substantial table pixels: ${JSON.stringify(result)}`);
    assert(result.colors >= 300,
      `composed Pinball table should retain indexed sprite color diversity: ${JSON.stringify(result)}`);
    assert(result.black < result.total * 0.55,
      `composed Pinball table should not collapse into black rectangles: ${JSON.stringify(result)}`);
    assert(result.different <= Math.max(64, result.total * 0.002),
      `compositor should reproduce the canonical derived surface: ${JSON.stringify(result)}`);
    assert.strictEqual(failures.length, 0, `browser runtime failures:\n${failures.join('\n')}`);
    assert(fs.statSync(SCREENSHOT).size > 100000,
      `Pinball screenshot should contain the complete detailed table: ${SCREENSHOT}`);

    console.log(`PASS  browser Pinball composes canonical WAT pixels (${result.colors} colors)`);
    console.log(`PASS  browser Pinball surface/compositor mismatch is ${result.different}/${result.total} pixels`);
    console.log(`PASS  browser Pinball remains live after ${result.flushCount} surface flushes`);
    console.log(`Screenshot: ${SCREENSHOT}`);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
