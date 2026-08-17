#!/usr/bin/env node

// The four original 16-bit (NE) games, launched from the browser shell's
// "16-bit (Win16 / NE)" group. The CLI harness already covers the emulator
// core for these; what is only reachable here is the browser's own DLL path --
// host.js has to notice the task is 16-bit and fetch CARDS.DLL over HTTP,
// because a Win16 DLL is an NE image and cannot go through `dlls` (which loads
// 32-bit PEs). FreeCell draws nothing recognizable without it.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'win16-web');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Win16 browser test');
  process.exit(0);
}

// Every app in the dropdown group, with the window title each one titles its
// main window with once it is up.
// `deal` is the app's own "new game" menu command, read out of its NE
// RT_MENU with tools/ne-dump.js --resources. FreeCell opens on an empty board
// by design, so dealing is the only way to see whether CARDS.DLL works.
const APPS = [
  { key: 'winmine16', title: 'Minesweeper' },
  { key: 'freecell16', title: 'FreeCell', deal: 102 },
  { key: 'sol16', title: 'Solitaire' },
  { key: 'mshearts16', title: 'The Microsoft Hearts Network' },
];

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

async function runApp(page, port, app) {
  await page.goto(`http://127.0.0.1:${port}/index.html?debug&win16-web=${app.key}`, {
    waitUntil: 'load', timeout: 60000,
  });
  await page.waitForFunction((key) => typeof launchApp === 'function' &&
    document.querySelector(`#app-select option[value="${key}"]`), { timeout: 30000 }, app.key);

  await page.evaluate(async (key) => {
    document.getElementById('app-select').value = key;
    await launchApp();
    const app = runningApps.find(item => item && item.name === key);
    if (app) app.wine.stepsPerSlice = 100000;
  }, app.key);

  await page.waitForFunction((key, title) => {
    const app = runningApps.find(item => item && item.name === key);
    const main = Object.values((sharedRenderer && sharedRenderer.windows) || {})
      .find(win => win && win.visible && win.title === title);
    return !!(app && app.wine._runSliceCount >= 40 && main);
  }, { timeout: 60000 }, app.key, app.title);

  if (app.deal) {
    // Straight into the post queue at 0x400, the way test/run.js --input
    // post-cmd does it: a menu command needs no menu interaction to arrive.
    await page.evaluate((key, cmd) => {
      const wine = runningApps.find(item => item && item.name === key).wine;
      const we = wine.instance.exports;
      const count = we.get_post_queue_count();
      if (count >= 8) throw new Error('post queue full');
      const dv = new DataView(wine.memory.buffer);
      const off = 0x400 + count * 16;
      dv.setUint32(off, we.get_main_hwnd(), true);
      dv.setUint32(off + 4, 0x111, true);          // WM_COMMAND
      dv.setUint32(off + 8, cmd, true);
      dv.setUint32(off + 12, 0, true);
      we.set_post_queue_count(count + 1);
    }, app.key, app.deal);
    await page.waitForFunction((key, target) => {
      const item = runningApps.find(a => a && a.name === key);
      return !!(item && item.wine._runSliceCount >= target);
    }, { timeout: 60000 }, app.key, 400);
  }

  return page.evaluate((key) => {
    const app = runningApps.find(item => item && item.name === key);
    sharedRenderer.repaint();
    const screen = document.getElementById('screen');
    const pixels = screen.getContext('2d')
      .getImageData(0, 0, screen.width, screen.height).data;
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 150 && pixels[i] > pixels[i + 1] * 2 && pixels[i] > pixels[i + 2] * 2) red++;
    }
    return {
      slices: app.wine._runSliceCount,
      running: app.wine.running,
      red,
      log: document.getElementById('log').textContent,
      png: screen.toDataURL('image/png'),
    };
  }, app.key);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  let pass = 0;
  const consoleByApp = new Map();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    // The NE loader reports through console.log, not the on-page log element,
    // and each launch navigates afresh — so keep the lines per app.
    let current = null;
    page.on('console', msg => {
      if (current) consoleByApp.get(current).push(msg.text());
    });
    for (const app of APPS) {
      current = app.key;
      consoleByApp.set(app.key, []);
      const result = await runApp(page, port, app);
      const png = path.join(OUT, `${app.key}.png`);
      fs.writeFileSync(png, Buffer.from(result.png.split(',')[1], 'base64'));
      assert(result.running, `${app.key} stopped running before its window settled`);
      assert(!/ERROR:|LinkError|UNIMPLEMENTED API:/.test(result.log), result.log.slice(-3000));
      console.log(`PASS  ${app.key} reached its "${app.title}" window in ${result.slices} browser slices`);
      pass++;
      // Minesweeper picks between its colour and monochrome art from
      // GetDeviceCaps(NUMCOLORS). Its red LED counters are the visible proof it
      // took the colour path; when NUMCOLORS reads as -1 the whole board is
      // 1-bit and there is not a red pixel on screen.
      if (app.key === 'winmine16') {
        assert(result.red >= 200,
          `Minesweeper fell back to monochrome art: only ${result.red} red pixels`);
        console.log(`PASS  winmine16 drew its colour art (${result.red} red pixels)`);
        pass++;
      }
      // Solitaire deals only if its window is as wide as it asked for. When
      // AdjustWindowRectEx forgets the WS_EX_CLIENTEDGE border the client comes
      // back four pixels narrow, Solitaire decides seven columns will not fit
      // and lays nothing out — leaving an empty green table with no red suit
      // anywhere on it.
      // FreeCell's cards come out of CARDS.DLL, whose exports read their
      // bitmap cache from the DLL's own data segment — which is only theirs
      // once the loader patches each exported prologue. Without that it draws
      // from FreeCell's variables and stops on a bogus bitmap handle.
      if (app.key === 'freecell16') {
        assert(result.red >= 200,
          `FreeCell dealt no cards from CARDS.DLL: only ${result.red} red pixels`);
        console.log(`PASS  freecell16 dealt a game from CARDS.DLL (${result.red} red pixels)`);
        pass++;
      }
      if (app.key === 'sol16') {
        assert(result.red >= 200,
          `Solitaire dealt no cards: only ${result.red} red pixels on the table`);
        console.log(`PASS  sol16 dealt a hand (${result.red} red pixels)`);
        pass++;
      }
    }

    // CARDS.DLL is an NE image fetched by host.js, not by the `dlls` list. If
    // that fetch stops happening the card games still open a window, so the
    // loader's own line is what actually proves the browser found it.
    const cards = consoleByApp.get('freecell16') || [];
    assert(cards.some(line => /^\[win16\] loaded CARDS$/.test(line)),
      'browser did not load CARDS.DLL for the 16-bit card games:\n' +
        cards.filter(line => line.startsWith('[win16]')).join('\n'));
    console.log('PASS  browser loaded CARDS.DLL for the 16-bit card games');
    pass++;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
