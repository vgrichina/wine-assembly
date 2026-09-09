#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const GAME = path.join(ROOT, 'test/binaries/win98-games-a-d',
  'Aotmic BOMBMAN demo-SW/BMANDEMO');
const EXE = path.join(GAME, '_BOMB.EXE');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.ATOMIC_BOMBERMAN_CAPTURE_DIR ||
  path.join(ROOT, 'build/local-candidate-smoke/atomic-bomberman');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function mimeType(filename) {
  if (filename.endsWith('.html')) return 'text/html';
  if (filename.endsWith('.js')) return 'text/javascript';
  if (filename.endsWith('.css')) return 'text/css';
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.wasm')) return 'application/wasm';
  if (filename.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function startServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (_) { res.writeHead(400); res.end('bad url'); return; }
    if (pathname === '/') pathname = '/index.html';
    const filename = path.normalize(path.join(root, pathname));
    if (filename !== root && !filename.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(filename, (error, data) => {
      if (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 500);
        res.end(error.code || 'read error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': mimeType(filename),
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function readFrame(filename) {
  return PNG.sync.read(fs.readFileSync(filename));
}

function frameStats(png) {
  const colors = new Set();
  let red = 0;
  let green = 0;
  let blue = 0;
  let orange = 0;
  let bright = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
    if (r > 70 && r > g * 1.5 && r > b * 1.4) red++;
    if (g > 60 && g > r * 1.5 && g > b * 1.4) green++;
    if (b > 70 && b > r * 1.4 && b > g * 1.3) blue++;
    if (r > 180 && g > 70 && g < 190 && b < 80) orange++;
    if (r + g + b > 500) bright++;
  }
  return { colors: colors.size, red, green, blue, orange, bright };
}

function changedPixels(a, b) {
  assert.strictEqual(a.width, b.width);
  assert.strictEqual(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 20) changed++;
  }
  return changed;
}

async function press(page, vk, holdMs = 100) {
  await page.evaluate(code => sharedRenderer.handleKeyDown(code), vk);
  await sleep(holdMs);
  await page.evaluate(code => sharedRenderer.handleKeyUp(code), vk);
}

async function capture(page, name) {
  const filename = path.join(OUT, `${name}.png`);
  const screen = await page.$('#screen');
  assert(screen, 'browser screen canvas is missing');
  await screen.screenshot({ path: filename });
  return filename;
}

async function waitForFrame(page, name, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let stats;
  while (Date.now() < deadline) {
    const filename = await capture(page, 'probe');
    stats = frameStats(readFrame(filename));
    if (predicate(stats)) return stats;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${name}; last=${JSON.stringify(stats)}`);
}

async function reachTitle(page) {
  const deadline = Date.now() + 45000;
  let stats;
  let lastSkip = 0;
  while (Date.now() < deadline) {
    stats = frameStats(readFrame(await capture(page, 'probe')));
    if (stats.red > 5000 && stats.green > 12000 && stats.bright < 6000) return stats;
    const publisherLogo =
      (stats.green < 1000 && stats.blue < 1000 && stats.bright > 1000) ||
      (stats.blue > 10000 && stats.bright > 100000);
    if (publisherLogo && Date.now() - lastSkip > 750) {
      await press(page, 27);
      lastSkip = Date.now();
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for the title screen; last=${JSON.stringify(stats)}`);
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log('SKIP Atomic Bomberman gameplay: Chrome is not installed');
    return;
  }
  if (!fs.existsSync(EXE)) {
    console.log('SKIP Atomic Bomberman gameplay: local A-D demo tree is absent');
    return;
  }
  assert.strictEqual(sha256(EXE),
    '0ff14a352d6626660ceb66ea0e6743cd33c457e754cfd5705120bacae0530638');
  assert.strictEqual(sha256(path.join(GAME, 'LEVELS.DAT')),
    '7f647eb426f93799e190b5697bec20c81d350cc5cc23b0adc9a29e2d814ad796');
  assert.strictEqual(sha256(path.join(GAME, 'README.BM')),
    '8cf26bf5541592dae04769eb3e50a90b506214dd1941ab84b15f445faadf3433');

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-gpu'],
  });
  const problems = [];
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
    page.on('pageerror', error => problems.push(String(error)));
    page.on('console', message => {
      const text = message.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH|FATAL:/i.test(text)) {
        problems.push(text);
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&no-log`, {
      waitUntil: 'load', timeout: 60000,
    });
    await page.waitForFunction('typeof launchApp === "function"', { timeout: 60000 });
    await page.evaluate(async () => {
      stopAllApps();
      document.getElementById('app-select').value = 'atomic_bomberman_demo';
      await launchApp();
    });
    await page.waitForFunction(
      'typeof runningApps !== "undefined" && runningApps.length && typeof sharedRenderer !== "undefined" && sharedRenderer',
      { timeout: 120000 });

    // Skip each publisher logo only after it is visibly rendered, then
    // synchronize every menu action on the resulting frame. This avoids
    // assuming how much work a loaded host completes per second.
    await reachTitle(page);
    await press(page, 13);
    await waitForFrame(page, 'the main menu',
      s => s.red < 2000 && s.green > 12000 && s.bright > 10000);
    await press(page, 13);
    await waitForFrame(page, 'keyboard input selection',
      s => s.red > 80000 && s.blue > 40000);
    await press(page, 13);
    await waitForFrame(page, 'the level options',
      s => s.red > 100000 && s.blue < 2000);
    await press(page, 13);
    await waitForFrame(page, 'the live arena',
      s => s.red < 5000 && s.green > 25000);
    const arenaPath = await capture(page, 'arena-start');

    await press(page, 39, 1000);
    await sleep(500);
    const movedPath = await capture(page, 'arena-moved');
    await press(page, 32);
    await sleep(1500);
    const bombPath = await capture(page, 'bomb-placed');
    await sleep(1700);
    const explosionPath = await capture(page, 'bomb-explosion');

    const arena = readFrame(arenaPath);
    const moved = readFrame(movedPath);
    const bomb = readFrame(bombPath);
    const explosion = readFrame(explosionPath);
    const arenaStats = frameStats(arena);
    const explosionStats = frameStats(explosion);
    const movement = changedPixels(arena, moved);
    const placement = changedPixels(moved, bomb);

    assert(arena.width >= 500 && arena.height >= 400,
      `arena capture is unexpectedly small (${arena.width}x${arena.height})`);
    assert(arenaStats.colors > 40 && arenaStats.green > 25000,
      `arena art is missing (${JSON.stringify(arenaStats)})`);
    assert(movement > 1000,
      `held Right did not visibly move the arena (${movement} changed pixels)`);
    assert(placement > 1200,
      `Space did not visibly place a bomb (${placement} changed pixels)`);
    assert(explosionStats.orange > 100 && changedPixels(bomb, explosion) > 5000,
      `placed bombs did not produce a visible explosion (${JSON.stringify(explosionStats)})`);
    assert.strictEqual(problems.length, 0, `browser compatibility failures:\n${problems.join('\n')}`);
    assert(await page.evaluate(() => !!(runningApps[0] && runningApps[0].wine)),
      'Atomic Bomberman stopped during gameplay');

    console.log(`PASS Atomic Bomberman arena: ${arenaStats.colors} colors, ${arenaStats.green} green pixels`);
    console.log(`PASS Atomic Bomberman input: movement=${movement}, bomb=${placement}, explosion=${explosionStats.orange}`);
    console.log(`PASS Atomic Bomberman screenshots: ${OUT}`);
  } finally {
    const child = browser.process();
    const closed = await Promise.race([
      browser.close().then(() => true, () => true),
      sleep(5000).then(() => false),
    ]);
    if (!closed && child && child.exitCode === null) child.kill('SIGTERM');
    server.closeAllConnections?.();
    server.close();
  }
}

main().catch(error => {
  console.error(`FAIL Atomic Bomberman gameplay: ${error.stack || error.message}`);
  process.exit(1);
});
