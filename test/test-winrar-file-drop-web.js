#!/usr/bin/env node

// A real browser/Worker seam test for the legacy Shell file-drop path.
// Unit coverage proves the WAT structure parser. This proves the other half:
// a browser File is mounted lazily, delivered to the HWND WinRAR registered,
// and arrives as a queued WM_DROPFILES rather than opening the media importer.

'use strict';

const assert = require('assert');
const fs = require('fs');
const { startStaticServer: startSharedStaticServer } = require('./static-server');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WINRAR = path.join(ROOT,
  'test/binaries/candidates/winrar-310/installed/WinRAR.exe');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for WinRAR file-drop browser test');
  process.exit(0);
}
if (!fs.existsSync(WINRAR)) {
  console.log('SKIP  installed WinRAR candidate is missing');
  process.exit(0);
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.json') return 'application/json';
  if (ext === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

function startServer() {
  return startSharedStaticServer({ root: ROOT, mimeType, crossOriginIsolated: true });
}

(async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 });
  const problems = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (/UNIMPLEMENTED API:|RuntimeError|LinkError|trapped|worker start failed/i.test(message.text())) {
      const problem = `console: ${message.text()}`;
      problems.push(problem);
      console.error(problem);
    }
  });

  try {
    await page.goto(`${base}/?debug`, { waitUntil: 'load', timeout: 90000 });
    assert.strictEqual(await page.evaluate(() => crossOriginIsolated), true,
      'the test must exercise the SharedArrayBuffer Worker path');
    await page.evaluate(async () => {
      const box = document.getElementById('threads-toggle');
      box.checked = true;
      await setThreads(true);
    });
    await page.select('#app-select', 'winrar_310');
    await page.evaluate(() => launchApp());
    await page.waitForFunction(() => {
      const running = window.wineShell && window.wineShell.runningApps &&
        window.wineShell.runningApps.find(item => item && item.name === 'winrar_310');
      return !!(running && running.wine);
    }, { timeout: 90000 });
    assert.strictEqual(await page.evaluate(() => {
      const running = window.wineShell.runningApps.find(item => item.name === 'winrar_310');
      return !!(running && running.wine && running.wine.guestWorker);
    }), true, 'WinRAR must run in the Worker-backed guest');
    await page.waitForFunction(() => {
      const running = window.wineShell && window.wineShell.runningApps &&
        window.wineShell.runningApps.find(item => item && item.name === 'winrar_310');
      if (!running || !running.wine) return false;
      return Object.values(window.sharedRenderer.windows || {}).some(win =>
        win && win.visible && !win.isChild && /WinRAR/i.test(win.title || ''));
    }, { timeout: 180000 });

    // WinRAR may show its evaluation reminder above the main frame. Close it
    // through the guest's own dialog button so the browser point below lands
    // on the application window that registered for drops.
    await page.evaluate(async () => {
      const running = window.wineShell.runningApps.find(item => item.name === 'winrar_310');
      const dialog = Object.values(window.sharedRenderer.windows || {})
        .filter(win => win && win.visible && win.isDialog && win.processId === running.wine.processId)
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
      if (dialog) {
        await running.wine.callGuest('click_dialog_control', dialog.hwnd | 0, 1);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    });

    const report = await page.evaluate(async () => {
      const running = window.wineShell.runningApps.find(item => item.name === 'winrar_310');
      const wine = running.wine;
      const renderer = window.sharedRenderer;
      const main = Object.values(renderer.windows || {})
        .filter(win => win && win.visible && !win.isChild && win.processId === wine.processId &&
          /WinRAR/i.test(win.title || ''))
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
      if (!main) throw new Error('WinRAR main window disappeared');
      // Use the exposed lower-left frame edge: the evaluation reminder may
      // still be centered over the main window, and correctly wins hit-test
      // there because that dialog did not register for file drops.
      const guestX = main.x + Math.min(10, Math.max(3, main.w - 3));
      const guestY = main.y + Math.max(3, main.h - 10);
      const target = main.wasm.exports.drop_target_at(main.hwnd, guestX, guestY) >>> 0;
      if (!target) throw new Error('WinRAR did not call DragAcceptFiles');

      window.WineFrozen.setEnabled(true);
      if (!wine._frozen) throw new Error('WinRAR did not enter frozen mode');
      await new Promise(resolve => setTimeout(resolve, 100));
      const canvas = document.getElementById('screen');
      const rect = canvas.getBoundingClientRect();
      const event = {
        clientX: rect.left + guestX * rect.width / canvas.width,
        clientY: rect.top + guestY * rect.height / canvas.height,
      };
      const transfer = new DataTransfer();
      transfer.items.add(new File([
        new Uint8Array([0x57, 0x69, 0x6e, 0x39, 0x38]),
      ], 'Browser drop?.txt', { type: 'text/plain' }));
      const depthBefore = (await wine.callGuest('post_queue_depth')) >>> 0;
      document.getElementById('screen-wrap').dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: event.clientX,
        clientY: event.clientY,
      }));
      let depth = depthBefore;
      let dropIndex = -1;
      for (let attempt = 0; attempt < 50 && dropIndex < 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        depth = (await wine.callGuest('post_queue_depth')) >>> 0;
        for (let index = depthBefore; index < depth; index++) {
          if (((await wine.callGuest('post_queue_peek', index, 1)) >>> 0) === 0x0233) {
            dropIndex = index;
            break;
          }
        }
      }
      const message = dropIndex >= 0
        ? (await wine.callGuest('post_queue_peek', dropIndex, 1)) >>> 0 : 0;
      const hwnd = dropIndex >= 0
        ? (await wine.callGuest('post_queue_peek', dropIndex, 0)) >>> 0 : 0;
      const hdrop = dropIndex >= 0
        ? (await wine.callGuest('post_queue_peek', dropIndex, 2)) >>> 0 : 0;
      const wa = hdrop ? (await wine.callGuest('guest_to_wasm', hdrop)) >>> 0 : 0;
      const bytes = new Uint8Array(wine.memory.buffer);
      const dv = new DataView(wine.memory.buffer);
      const pFiles = hdrop ? dv.getUint32(wa, true) : 0;
      let droppedPath = '';
      for (let p = wa + pFiles; hdrop && bytes[p]; p++) droppedPath += String.fromCharCode(bytes[p]);
      const entry = wine._helpCtx.vfs.files.get(wine._helpCtx.vfs._normPath(droppedPath));
      return {
        delivered: dropIndex >= 0,
        target,
        worker: !!wine.guestWorker,
        depth,
        message,
        hwnd,
        hdrop,
        droppedPath,
        lazy: !!(entry && entry._provider),
        size: entry && entry._size,
        mediaModal: !!document.querySelector('.wa-media-modal'),
      };
    });

    assert.strictEqual(report.delivered, true);
    assert.strictEqual(report.worker, true);
    assert(report.depth > 0, 'frozen guest retains the posted drop message');
    assert.strictEqual(report.message, 0x0233, 'the browser posts WM_DROPFILES');
    assert.strictEqual(report.hwnd, report.target, 'message reaches WinRAR\'s registered HWND');
    assert(report.hdrop > 0, 'WM_DROPFILES wParam is a live HDROP');
    assert.strictEqual(report.droppedPath,
      'C:\\WINDOWS\\TEMP\\Dropped Files\\Browser drop_.txt');
    assert.strictEqual(report.lazy, true, 'the browser File remains provider-backed');
    assert.strictEqual(report.size, 5);
    assert.strictEqual(report.mediaModal, false,
      'an application-owned file drop does not open the game-media importer');
    assert.deepStrictEqual(problems, [], problems.join('\n'));
    console.log('PASS  browser File reaches WinRAR as lazy Worker-mode WM_DROPFILES');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
