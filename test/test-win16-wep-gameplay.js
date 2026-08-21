#!/usr/bin/env node
'use strict';

// Gameplay coverage beyond the launch-only WEP sweep:
//   * Pipe Dream places its first tile through Win16 GDI.22.
//   * Dr. Black Jack's disabled main-window buttons reject browser input.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PIPE = path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP2', 'PIPE.EXE');
const BLACKJACK = path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP4', 'BLAKJAK.EXE');

function changedPixels(beforePath, afterPath, x0, y0, x1, y1) {
  const before = PNG.sync.read(fs.readFileSync(beforePath));
  const after = PNG.sync.read(fs.readFileSync(afterPath));
  assert.strictEqual(after.width, before.width);
  assert.strictEqual(after.height, before.height);
  let changed = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * before.width + x) * 4;
    if (before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] ||
        before.data[i + 2] !== after.data[i + 2] || before.data[i + 3] !== after.data[i + 3]) changed++;
  }
  return changed;
}

function testPipeDream() {
  if (!fs.existsSync(PIPE)) {
    console.log('SKIP  Pipe Dream gameplay corpus is not installed');
    return;
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-pipe-gameplay-'));
  try {
    const before = path.join(outDir, 'before.png');
    const after = path.join(outDir, 'after.png');
    const output = execFileSync(process.execPath, [
      path.join(ROOT, 'test', 'run.js'), '--app=wep16_pipe', '--no-close',
      '--batch-size=20000', '--max-batches=130', '--quiet-api', '--quiet-blocks',
      `--input=40:mousedown:320:220,41:mouseup:320:220,70:png:${before},` +
        `80:mousedown:100:90,81:mouseup:100:90,100:png:${after},120:stop`,
    ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError/);
    assert(changedPixels(before, after, 74, 69, 124, 119) > 100,
      'the first board cell should visibly change after tile placement');
    console.log('PASS  Win16 Pipe Dream places its first tile without crashing');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
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
      const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
        '.json': 'application/json', '.wasm': 'application/wasm' };
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store' });
      response.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function testBlackjack() {
  if (!fs.existsSync(BLACKJACK) || !fs.existsSync(CHROME)) {
    console.log('SKIP  Win16 Blackjack browser corpus or Chrome is not installed');
    return;
  }
  const server = await startStaticServer();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 480, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&bj-disabled=${Date.now()}`,
      { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('#app-select option[value="wep16_blakjak"]'), { timeout: 15000 });
    await page.evaluate(async () => {
      document.getElementById('app-select').value = 'wep16_blakjak';
      await launchApp();
    });
    await page.waitForFunction(() => {
      const app = runningApps.find(a => a && a.name === 'wep16_blakjak');
      return !!(app && app.wine && app.wine.instance && app.wine.instance.exports &&
        Object.values(sharedRenderer.windows).some(w => w && w.visible && w.isDialog));
    }, { timeout: 30000 });

    await page.evaluate(() => {
      const app = runningApps.find(a => a && a.name === 'wep16_blakjak');
      const e = app.wine.instance.exports;
      const dialogs = Object.values(sharedRenderer.windows).filter(w => w && w.visible && w.isDialog)
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
      let ok = 0;
      for (const dlg of dialogs) {
        let slot = 0;
        while ((slot = e.wnd_next_child_slot(dlg.hwnd, slot)) !== -1) {
          const child = e.wnd_slot_hwnd(slot);
          slot++;
          if (child && e.ctrl_get_id(child) === 1) { ok = child; break; }
        }
        if (ok) break;
      }
      if (!ok) throw new Error('player-name OK button not found');
      e.send_message(ok, 0x0201, 0, 0);
      e.send_message(ok, 0x0202, 0, 0);
    });
    await page.waitForFunction(() => !Object.values(sharedRenderer.windows)
      .some(w => w && w.visible && w.isDialog), { timeout: 15000 });

    const result = await page.evaluate(() => {
      const app = runningApps.find(a => a && a.name === 'wep16_blakjak');
      const e = app.wine.instance.exports;
      const main = e.get_main_hwnd() >>> 0;
      let split = 0;
      let slot = 0;
      while ((slot = e.wnd_next_child_slot(main, slot)) !== -1) {
        const child = e.wnd_slot_hwnd(slot);
        slot++;
        if (child && e.ctrl_get_class(child) === 1 && e.ctrl_get_id(child) === 0) {
          split = child;
          break;
        }
      }
      if (!split) throw new Error('Split button not found');
      const style = e.wnd_get_style_export(split) >>> 0;
      const x = (e.wnd_window_screen_x(split) | 0) + 8;
      const y = (e.wnd_window_screen_y(split) | 0) + 8;
      const before = sharedRenderer.inputQueue.length;
      sharedRenderer.handleMouseDown(x, y, 0);
      sharedRenderer.handleMouseUp(x, y, 0);
      return {
        style,
        flags: e.button_get_flags(split) | 0,
        events: sharedRenderer.inputQueue.slice(before)
          .filter(evt => evt && (evt.hwnd >>> 0) === split)
          .map(evt => evt.msg >>> 0),
      };
    });
    assert(result.style & 0x08000000, 'Split must begin WS_DISABLED');
    assert.deepStrictEqual(result.events, [], 'disabled Split must receive no browser mouse messages');
    assert.strictEqual(result.flags & 1, 0, 'disabled Split must not enter pressed state');
    console.log('PASS  Win16 Blackjack rejects clicks on disabled action buttons');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  testPipeDream();
  await testBlackjack();
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
