#!/usr/bin/env node
// The emulated cursor a touch device gets instead of a pointer.
//
// WHY: cursor shape is real guest state -- lib/host-window.js turns every
// SetCursor into canvas.style.cursor, and renderer-input sets its own for
// window edges -- but a CSS cursor only exists under a mouse. On a phone that
// state is dropped on the floor, so an app grinding through a long operation
// is indistinguishable from an app that has died: no hourglass, no I-beam, no
// resize arrows. lib/touch-cursor.js draws it.
//
// Three things have to hold, and each is a way this has failed:
//   - it follows the shape the shell/guest actually set, not a guess;
//   - the hourglass is up during a launch, when there is no guest yet to ask
//     and the wait is longest;
//   - the sprite never takes a tap. A cursor that ate the input it is drawn
//     to describe would be worse than no cursor at all.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'notepad';
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for touch-cursor test');
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
  const server = process.env.BASE_URL ? null : await startStaticServer();
  const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(`${base}/index.html?single-app=1&touch-cursor=1&cursor-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.desktop-icon'), { timeout: 60000 });

    const installed = await page.evaluate(() => !!(window.TouchCursor && window.TouchCursor.installed));
    assert(installed, 'touch-cursor=1 must install the emulated cursor');

    // A boot outlasts many poll ticks, but not predictably many, so record
    // what the poll saw instead of sampling it from here and hoping.
    await page.evaluate(() => {
      window.__cursorSeen = [];
      const real = TouchCursor.tick.bind(TouchCursor);
      TouchCursor.tick = function () {
        real();
        if (TouchCursor._visible) window.__cursorSeen.push(TouchCursor._shape);
      };
    });

    await page.evaluate(app => {
      const icon = [...document.querySelectorAll('.desktop-icon')].find(el => el.dataset.app === app);
      if (!icon) throw new Error(`no ${app} icon on the desktop`);
      icon.click();
    }, APP);

    await page.waitForFunction(app => {
      const entry = runningApps.find(item => item && item.name === app);
      if (!entry || !entry.wine.running) return false;
      const lo = entry.wine._hwndBase || 0;
      return Object.keys(sharedRenderer.windows)
        .some(hwnd => Number(hwnd) >= lo && Number(hwnd) < lo + 0x10000);
    }, { timeout: 120000 }, APP);

    const seen = await page.evaluate(() => window.__cursorSeen);
    assert(seen.includes('wait'),
      `no hourglass during the launch; the cursor showed ${JSON.stringify([...new Set(seen)])}`);

    // The shape the guest asks for. host-window.js's set_cursor writes exactly
    // this for IDC_IBEAM, so this is the path a text field takes.
    const shaped = await page.evaluate(async () => {
      document.getElementById('screen').style.cursor = 'text';
      await new Promise(resolve => setTimeout(resolve, 300));
      return TouchCursor._shape;
    });
    assert.strictEqual(shaped, 'text', 'the cursor must follow canvas.style.cursor');

    // A cursor the guest BUILT. Heroes of Might & Magic II draws its own
    // pointer and hands it to CreateIconIndirect, which host-window.js turns
    // into `url(data:image/x-icon;...) hx hy` -- and no keyword in the pixel
    // art is a hand. If the sprite falls back to its own arrow here, the phone
    // shows a cursor the game never drew.
    const custom = await page.evaluate(async () => {
      const art = document.createElement('canvas');
      art.width = 8; art.height = 8;
      const g = art.getContext('2d');
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 8, 8);
      const url = art.toDataURL('image/png');
      const canvas = document.getElementById('screen');
      const zoom = canvas.getBoundingClientRect().width / canvas.width;
      canvas.style.cursor = `url(${url}) 3 5, default`;
      await new Promise(resolve => setTimeout(resolve, 500));
      const el = document.getElementById('touch-cursor');
      const ctx = el.getContext('2d');
      const mid = ctx.getImageData(Math.floor(el.width / 2), Math.floor(el.height / 2), 1, 1).data;
      return {
        zoom,
        red: [mid[0], mid[1], mid[2], mid[3]],
        hotX: TouchCursor._hotX,
        hotY: TouchCursor._hotY,
        width: el.getBoundingClientRect().width,
      };
    });
    assert(custom.red[3] > 200 && custom.red[0] > 200 && custom.red[1] < 60 && custom.red[2] < 60,
      `the sprite drew ${JSON.stringify(custom.red)} where the guest's own art should be`);
    assert(Math.abs(custom.hotX - 3 * custom.zoom) < 0.51
        && Math.abs(custom.hotY - 5 * custom.zoom) < 0.51,
      `the guest's hotspot (3,5) became ${custom.hotX},${custom.hotY} at zoom ${custom.zoom}`);
    // 8 art pixels plus the one-pixel shadow pad, at the app's zoom.
    assert(Math.abs(custom.width - 9 * custom.zoom) / (9 * custom.zoom) < 0.05,
      `a 8x8 cursor came out ${custom.width}px wide at zoom ${custom.zoom}`);

    // ... and it goes back to the pixel art when the guest drops the image.
    const reverted = await page.evaluate(async () => {
      document.getElementById('screen').style.cursor = 'wait';
      await new Promise(resolve => setTimeout(resolve, 400));
      const el = document.getElementById('touch-cursor');
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60) red++;
      return { shape: TouchCursor._shape, red };
    });
    assert.strictEqual(reverted.shape, 'wait', 'the keyword cursor must take over again');
    assert.strictEqual(reverted.red, 0, 'the guest bitmap is still on the sprite');

    // The sprite belongs to the picture, not to the page: the shell blows the
    // screen canvas up to fill the phone, and a cursor drawn at a fixed size
    // is a sticker on top of that -- a 2x arrow over a 320x240 game scaled
    // 1.2x is nearly twice the size of the buttons it points at. One guest
    // pixel of cursor art must be one guest pixel on screen.
    const zoomed = await page.evaluate(async () => {
      const canvas = document.getElementById('screen');
      const rect = canvas.getBoundingClientRect();
      const appZoom = rect.width / canvas.width;
      canvas.style.cursor = 'wait';
      await new Promise(resolve => setTimeout(resolve, 300));
      const el = document.getElementById('touch-cursor');
      // The hourglass art is 13 cursor pixels wide plus one of shadow pad.
      return { appZoom, cursorZoom: el.getBoundingClientRect().width / 14 };
    });
    assert(zoomed.appZoom > 0, 'the screen canvas should have a measurable zoom');
    assert(Math.abs(zoomed.cursorZoom - zoomed.appZoom) / zoomed.appZoom < 0.05,
      `the cursor is drawn at ${zoomed.cursorZoom.toFixed(3)}x while the app is at ` +
      `${zoomed.appZoom.toFixed(3)}x`);

    // Track a finger, and stay put when it lifts: the hourglass that matters
    // is the one that appears after the tap that started the work.
    const tracked = await page.evaluate(async () => {
      const at = (type, x, y) => {
        const touch = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
        document.body.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
        }));
      };
      at('touchstart', 200, 300);
      at('touchmove', 220, 320);
      at('touchend', 220, 320);
      await new Promise(resolve => setTimeout(resolve, 200));
      const el = document.getElementById('touch-cursor');
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        // The hotspot, not the sprite's corner.
        x: rect.left + TouchCursor._hotX,
        y: rect.top + TouchCursor._hotY,
        pointerEvents: style.pointerEvents,
        // The one check that matters for input: a tap where the sprite is has
        // to reach whatever is underneath it.
        hitsCanvas: document.elementFromPoint(220, 320) !== el,
        display: style.display,
        // A sprite that is positioned, sized and invisible would pass every
        // other check here.
        inked: (() => {
          const ctx = el.getContext('2d');
          const data = ctx.getImageData(0, 0, el.width, el.height).data;
          let n = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
          return n;
        })(),
      };
    });
    assert(Math.abs(tracked.x - 220) <= 2 && Math.abs(tracked.y - 320) <= 2,
      `the cursor hotspot should sit where the finger left it, got ${tracked.x},${tracked.y}`);
    assert(tracked.inked > 50,
      `the cursor sprite drew ${tracked.inked} opaque pixels -- nothing a visitor could see`);
    assert.strictEqual(tracked.display, 'block', 'the cursor must be visible while an app runs');
    assert.strictEqual(tracked.pointerEvents, 'none', 'the cursor sprite must never take input');
    assert(tracked.hitsCanvas, 'a tap under the cursor sprite must reach the guest');

    // With a touch-control overlay up, the sprite stops being sticky. A dpad
    // game is played with the pad -- there is no pointer in it to describe --
    // and an arrow left sitting on the board after the one tap that reached a
    // menu is just litter. So: only while a finger is on the game surface,
    // never for a touch that lands on the overlay itself.
    const policy = await page.evaluate(async () => {
      const canvas = document.getElementById('screen');
      const overlay = document.createElement('div');
      overlay.id = 'touch-controls';
      const button = document.createElement('button');
      button.className = 'tc-btn';
      overlay.appendChild(button);
      document.body.appendChild(overlay);
      window.TouchControls = { isVisible: () => true };

      const at = (type, target, x, y) => {
        const touch = new Touch({ identifier: 7, target, clientX: x, clientY: y });
        target.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
        }));
      };
      const shown = () => getComputedStyle(document.getElementById('touch-cursor')).display;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      TouchCursor.tick();
      await wait(50);
      const atRest = shown();

      at('touchstart', canvas, 200, 300);
      await wait(50);
      const duringCanvasTouch = shown();

      at('touchend', canvas, 200, 300);
      await wait(400);
      const afterRelease = shown();

      at('touchstart', button, 30, 600);
      at('touchend', button, 30, 600);
      await wait(300);
      const afterOverlayTouch = shown();

      // And the policy is per-app: an app with no overlay keeps the sticky
      // sprite it has always had.
      window.TouchControls = { isVisible: () => false };
      TouchCursor.tick();
      await wait(50);
      const withoutOverlay = shown();

      overlay.remove();
      delete window.TouchControls;
      TouchCursor.tick();
      return { atRest, duringCanvasTouch, afterRelease, afterOverlayTouch, withoutOverlay };
    });
    assert.strictEqual(policy.atRest, 'none',
      'with an overlay up the sprite must not linger between touches');
    assert.strictEqual(policy.duringCanvasTouch, 'block',
      'a finger on the game surface still gets a cursor -- that is how a menu is tapped');
    assert.strictEqual(policy.afterRelease, 'none',
      'and it goes away promptly when the finger lifts');
    assert.strictEqual(policy.afterOverlayTouch, 'none',
      'a touch on a dpad or a button is a key press, not a pointer gesture');
    assert.strictEqual(policy.withoutOverlay, 'block',
      'an app that declares no touch controls keeps the sticky sprite');

    // And nothing at all under a mouse, where the browser draws a real one.
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1024, height: 768 });
    await page2.goto(`${base}/index.html?touch-cursor=0&cursor-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    const off = await page2.evaluate(() => ({
      installed: !!(window.TouchCursor && window.TouchCursor.installed),
      sprite: !!document.getElementById('touch-cursor'),
    }));
    assert(!off.installed && !off.sprite, 'touch-cursor=0 must leave the page untouched');

    console.log('PASS  touch devices get an emulated cursor, hourglass included');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
