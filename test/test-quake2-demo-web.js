#!/usr/bin/env node
'use strict';

// Browser regression for the localhost-only Quake II candidate. The CLI can
// prove that ref_soft.dll rendered a surface, but the reported failure was a
// black *web dropdown* launch on a phone. Drive the selector, take the real
// page-fullscreen path, and inspect both Quake's DirectDraw layer and the
// centre of the pixels actually visible in the browser viewport.

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
const OUT = path.join(ROOT, 'scratch', 'quake2-demo-web');
const SCREENSHOT = path.join(OUT, 'phone-viewport.png');
const GAMEPLAY_BEFORE = path.join(OUT, 'gameplay-before.png');
const GAMEPLAY_AFTER = path.join(OUT, 'gameplay-after.png');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP Chrome not found for Quake II browser test');
  process.exit(0);
}
if (!fs.existsSync(EXE)) {
  console.log('SKIP Quake II local candidate payload is not present');
  process.exit(0);
}

function mimeType(file) {
  return ({
    '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function startStaticServer() {
  return startSharedStaticServer({ root: ROOT, mimeType });
}

function pixelMetrics(png, x0, y0, x1, y1) {
  const colors = new Set();
  let black = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r < 8 && g < 8 && b < 8) black++;
      total++;
    }
  }
  return { colors: colors.size, black, total };
}

function changedPixels(before, after) {
  assert.deepStrictEqual([before.width, before.height], [after.width, after.height]);
  let changed = 0;
  let largeChange = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta = Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta > 12) changed++;
    if (delta > 60) largeChange++;
  }
  return { changed, largeChange, total: before.width * before.height };
}

async function saveGameLayer(page, output) {
  const frame = await page.evaluate(() => {
    const win = Object.values(sharedRenderer.windows || {}).find(item =>
      item && item.visible && /Quake 2/i.test(item.title || '') &&
      item._dxFrameLayer && item._dxFrameLayer.canvas);
    if (!win) throw new Error('Quake DirectDraw layer disappeared');
    const canvas = win._dxFrameLayer.canvas;
    const data = canvas.getContext('2d').getImageData(
      0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height, data: Array.from(data) };
  });
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data.set(frame.data);
  fs.writeFileSync(output, PNG.sync.write(png));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-q2-web-'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    userDataDir: profile,
    args: [
      '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    ],
  });
  const problems = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: 390, height: 844, deviceScaleFactor: 1,
      hasTouch: true, isMobile: true,
    });
    // iPhone Safari has no element Fullscreen API. Removing it makes the page
    // use the same page-fullscreen/letterbox path instead of Chrome's prompt.
    await page.evaluateOnNewDocument(() => {
      for (const name of ['requestFullscreen', 'webkitRequestFullscreen',
                          'mozRequestFullScreen', 'msRequestFullscreen']) {
        delete Element.prototype[name];
      }
    });
    page.on('pageerror', error => problems.push((error && error.stack) || String(error)));
    page.on('console', message => {
      const text = message.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(text)) {
        problems.push(text);
      }
    });
    const url = `http://127.0.0.1:${server.address().port}/index.html?debug&no-log&q2-web=${Date.now()}`;
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('#app-select option[value="quake2_demo"]'),
    { timeout: 30000 });

    await page.select('#app-select', 'quake2_demo');
    const menuArgs = await page.evaluate(() => apps.quake2_demo.args);
    assert(/\+set\s+vid_ref\s+gl/i.test(menuArgs), `OpenGL renderer missing from dropdown args: ${menuArgs}`);
    assert(/\+menu_main/i.test(menuArgs), `dropdown should start Quake's normal menu: ${menuArgs}`);
    const args = await page.evaluate(() => {
      // Keep the user's dropdown on its normal OpenGL menu. This separate
      // DirectDraw regression explicitly selects software + demo1 so its
      // acceptance frame remains deterministic software gameplay.
      apps.quake2_demo.args = '+set vid_ref soft +map demo1';
      return apps.quake2_demo.args;
    });
    assert(/\+map\s+demo1/i.test(args), `test must explicitly enter demo1: ${args}`);
    await page.click('button[onclick="launchApp()"]');

    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'quake2_demo');
      const win = Object.values(sharedRenderer.windows || {}).find(item =>
        item && item.visible && /Quake 2/i.test(item.title || '') &&
        item._dxFrameLayer && item._dxFrameLayer.canvas);
      if (!app || !app.wine.running || !win) return false;
      const canvas = win._dxFrameLayer.canvas;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      let black = 0;
      for (let i = 0; i < data.length; i += 4) {
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) black++;
      }
      return colors.size >= 48 && black < canvas.width * canvas.height * 0.75;
    }, { timeout: 120000, polling: 200 });

    // A coloured frame can still be a menu, loading plaque, or frozen first
    // frame. The forced demo1 map has a moving viewpoint: preserve two raw
    // 320x240 game-layer frames and require broad world motion between them.
    await saveGameLayer(page, GAMEPLAY_BEFORE);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await saveGameLayer(page, GAMEPLAY_AFTER);
    const gameplayMotion = changedPixels(
      PNG.sync.read(fs.readFileSync(GAMEPLAY_BEFORE)),
      PNG.sync.read(fs.readFileSync(GAMEPLAY_AFTER)));

    const result = await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'quake2_demo');
      const win = Object.values(sharedRenderer.windows || {}).find(item =>
        item && item.visible && /Quake 2/i.test(item.title || '') && item._dxFrameLayer);
      const frame = win._dxFrameLayer.canvas;
      const data = frame.getContext('2d').getImageData(0, 0, frame.width, frame.height).data;
      const colors = new Set();
      let black = 0;
      for (let i = 0; i < data.length; i += 4) {
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) black++;
      }
      sharedRenderer.repaint();
      const screen = document.getElementById('screen');
      const rect = screen.getBoundingClientRect();
      return {
        running: app.wine.running,
        frame: { width: frame.width, height: frame.height,
          colors: colors.size, black, total: frame.width * frame.height },
        layout: {
          innerWidth, innerHeight, scrollX, scrollY,
          visualWidth: visualViewport && visualViewport.width,
          visualHeight: visualViewport && visualViewport.height,
          canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          pageFullscreen: document.body.classList.contains('page-fullscreen'),
        },
      };
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: SCREENSHOT, captureBeyondViewport: false });

    const png = PNG.sync.read(fs.readFileSync(SCREENSHOT));
    // The 4:3 game is letterboxed on a portrait phone. The browser viewport's
    // centre must nevertheless land inside the game, not in a black bar or a
    // canvas shifted below the fold.
    const centre = pixelMetrics(png,
      Math.floor(png.width * 0.20), Math.floor(png.height * 0.42),
      Math.ceil(png.width * 0.80), Math.ceil(png.height * 0.58));

    assert(result.running, 'Quake II should remain running after the first gameplay frame');
    assert.deepStrictEqual([result.frame.width, result.frame.height], [320, 240]);
    assert(result.frame.colors >= 48 && result.frame.black < result.frame.total * 0.75,
      `Quake DirectDraw layer is black: ${JSON.stringify(result.frame)}`);
    assert(gameplayMotion.changed > gameplayMotion.total * 0.08 &&
      gameplayMotion.largeChange > gameplayMotion.total * 0.02,
    `Quake demo world did not move: ${JSON.stringify(gameplayMotion)}`);
    assert(result.layout.pageFullscreen, `phone launch missed page fullscreen: ${JSON.stringify(result.layout)}`);
    assert(result.layout.canvas.top <= 1 && result.layout.canvas.height >= result.layout.innerHeight - 1,
      `game canvas is shifted below the visible viewport: ${JSON.stringify(result.layout)}`);
    assert(centre.colors >= 32 && centre.black < centre.total * 0.65,
      `visible viewport centre is black: ${JSON.stringify({ centre, layout: result.layout })}`);
    assert.strictEqual(problems.length, 0, `browser runtime failures:\n${problems.join('\n')}`);

    console.log(`PASS Quake II dropdown renders ${result.frame.colors} DirectDraw colors`);
    console.log(`PASS Quake II demo world moves across ${gameplayMotion.changed}/${gameplayMotion.total} pixels`);
    console.log(`PASS phone viewport centre renders ${centre.colors} colors (${centre.black}/${centre.total} black)`);
    console.log(`Screenshots: ${GAMEPLAY_BEFORE}, ${GAMEPLAY_AFTER}, ${SCREENSHOT}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
