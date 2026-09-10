#!/usr/bin/env node
// Start > Shut Down... has to actually turn the machine off.
//
// The page half of shutdown (lib/shutdown.js): the Start menu's last item
// opens the "Shut Down Windows" dialog, OK on its default option shows the
// shutting-down screen, every guest is stopped underneath it, and the screen
// ends on the orange "It's now safe to turn off your computer." -- which a
// moment later grows a painted footer offering Restart (the power button:
// reloads the page) and berrry.app, and nothing else wakes it. Stand by is the
// opposite contract and is checked too: a dark screen, nothing stopped, the
// first key wakes it and never reaches the guest.
//
// Notepad is the guest because it is the cheapest one that reaches a message
// loop; stopping a guest that is pumping is the path a visitor exercises.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { startStaticServer: startSharedStaticServer } = require('./static-server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'web-shutdown');
const VIEWPORT = { width: 1024, height: 768, deviceScaleFactor: 1 };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for shutdown test');
  process.exit(0);
}

function startStaticServer() {
  return startSharedStaticServer({ root: ROOT });
}

const notepadPumping = () => {
  const app = runningApps.find(item => item && item.name === 'notepad');
  if (!app || !app.wine.running) return false;
  const base = app.wine._hwndBase || 0;
  return Object.keys(sharedRenderer.windows)
    .some(hwnd => Number(hwnd) >= base && Number(hwnd) < base + 0x10000);
};

async function launchNotepad(page) {
  await page.evaluate(() => {
    const icon = [...document.querySelectorAll('.desktop-icon')]
      .find(el => el.dataset.app === 'notepad');
    if (!icon) throw new Error('no Notepad icon on the desktop');
    // The desktop (not single-app) opens on a double-click: two clicks
    // inside 500ms.
    icon.click();
    icon.click();
  });
  await page.waitForFunction(notepadPumping, { timeout: 120000 });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = process.env.BASE_URL ? null : await startStaticServer();
  const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  let failed = 0;
  const check = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failed++; };
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('pageerror', error => console.log('  [pageerror]', error.message));
    await page.goto(`${base}/index.html?shutdown-test=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('.desktop-icon') && window.wineShutdown, { timeout: 60000 });

    // ---- Stand by: dark, nothing stopped, a key wakes it ----
    await launchNotepad(page);
    await page.evaluate(() => window.wineShutdown.run('standby'));
    let state = await page.evaluate(() => ({
      phase: window.wineShutdown.phase(),
      screen: !!document.getElementById('wine-power-screen'),
      running: runningApps.length,
      focusTrapped: document.activeElement && document.activeElement.classList.contains('keys'),
    }));
    check(state.phase === 'standby' && state.screen, 'stand by puts up the dark screen');
    check(state.running === 1, 'stand by stops nothing');
    check(state.focusTrapped, 'the key trap holds focus so the guest does not see the wake key');
    await page.screenshot({ path: path.join(OUT, 'standby.png') });
    await page.keyboard.press('Space');
    state = await page.evaluate(() => ({
      phase: window.wineShutdown.phase(),
      screen: !!document.getElementById('wine-power-screen'),
      running: runningApps.length,
    }));
    check(state.phase === 'on' && !state.screen, 'a key wakes from stand by');
    check(state.running === 1, 'Notepad is still running after the wake');

    // ---- Start > Shut Down... > OK ----
    await page.click('#start-btn');
    const item = await page.$('#start-shutdown-item');
    check(!!item, 'the Start menu has a Shut Down... item');
    const menuItems = await page.$$eval('#start-menu .item', els => els.map(el => el.textContent.trim()));
    check(menuItems[menuItems.length - 1] === 'Shut Down...', 'Shut Down... is the last item, where Windows puts it');
    await item.click();
    let dialog = await page.evaluate(() => {
      const dlg = document.getElementById('wine-shutdown-dialog');
      if (!dlg) return null;
      return {
        title: dlg.querySelector('.title span').textContent,
        prompt: dlg.querySelector('.prompt').textContent,
        options: [...dlg.querySelectorAll('label span')].map(el => el.textContent),
        checked: dlg.querySelector('input[type=radio]:checked').value,
        startMenuOpen: document.getElementById('start-menu').classList.contains('open'),
      };
    });
    check(!!dialog, 'Shut Down Windows dialog opened');
    if (dialog) {
      check(dialog.title === 'Shut Down Windows' && dialog.prompt === 'What do you want the computer to do?',
        'dialog carries the Windows 98 title and prompt');
      check(dialog.options.join('|') === 'Stand by|Shut down|Restart',
        'Stand by, Shut down, Restart, in order');
      check(dialog.checked === 'shutdown', 'Shut down is preselected');
      check(!dialog.startMenuOpen, 'the Start menu closed behind the dialog');
    }
    await page.screenshot({ path: path.join(OUT, 'dialog.png') });

    // Cancel first: the dialog goes, the guest stays.
    await page.click('#wine-shutdown-dialog button[data-action=cancel]');
    state = await page.evaluate(() => ({
      dialog: !!document.getElementById('wine-shutdown-dialog'), running: runningApps.length,
    }));
    check(!state.dialog && state.running === 1, 'Cancel closes the dialog and stops nothing');

    await page.click('#start-btn');
    await page.click('#start-shutdown-item');
    await page.click('#wine-shutdown-dialog button[data-action=ok]');
    // The screens are 320x400 bitmaps the emulator's GDI painted
    // (paint_power_screen); the page only shows them. So the checks read the
    // pixels: a colour census of the canvas, plus the 4:3 stretch.
    const logoStats = () => {
      const canvas = document.querySelector('#wine-power-screen canvas.logo');
      if (!canvas) return null;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const counts = {};
      let orange = 0, black = 0, blue = 0, white = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 200 && g > 120 && g < 200 && b < 100) orange++;
        else if (r < 16 && g < 16 && b < 16) black++;
        else if (b > r + 40 && b > g) blue++;
        else if (r > 240 && g > 240 && b > 240) white++;
        counts[(r << 16) | (g << 8) | b] = 1;
      }
      const rect = canvas.getBoundingClientRect();
      const dx = (rect.left + rect.width / 2) - innerWidth / 2;
      const dy = (rect.top + rect.height / 2) - innerHeight / 2;
      return {
        painted: canvas.dataset.painted === '1', kind: canvas.dataset.kind,
        width: canvas.width, height: canvas.height, colours: Object.keys(counts).length,
        orange, black, blue, white, total: data.length / 4,
        aspect: rect.width / rect.height,
        centred: Math.abs(dx) <= 2 && Math.abs(dy) <= 2 && rect.height >= innerHeight - 2,
        offset: `${dx.toFixed(1)},${dy.toFixed(1)} at ${rect.width}x${rect.height} in ${innerWidth}x${innerHeight}`,
        smoothing: getComputedStyle(canvas).imageRendering,
      };
    };
    state = await page.evaluate(logoStats);
    check(!!state && state.painted && state.kind === '0', 'OK shows the shutting-down screen, painted by the emulator');
    if (state) {
      check(state.width === 320 && state.height === 400, `the bitmap is 320x400 like LOGOW.SYS (${state.width}x${state.height})`);
      check(Math.abs(state.aspect - 4 / 3) < 0.02, `shown stretched to 4:3 (${state.aspect.toFixed(3)})`);
      check(state.centred, `centred and as tall as the viewport (${state.offset})`);
      check(state.smoothing === 'pixelated' || state.smoothing === 'crisp-edges', `no smoothing (${state.smoothing})`);
      check(state.blue > state.total * 0.6 && state.colours > 40 && state.white > 200,
        `a blue sky with the logo and white text on it (${state.colours} colours, ${state.blue} sky px, ${state.white} white px)`);
    }
    check(await page.evaluate(() => window.wineShutdown.phase()) === 'wait', 'phase is wait');
    await page.screenshot({ path: path.join(OUT, 'shutting-down.png') });

    await page.waitForFunction(() => window.wineShutdown.phase() === 'off', { timeout: 15000 });
    state = await page.evaluate(() => ({
      running: runningApps.length,
      windows: Object.keys(sharedRenderer.windows).length,
      logo: null,
    }));
    state.logo = await page.evaluate(logoStats);
    check(state.running === 0 && state.windows === 0, 'every guest was stopped on the way down');
    check(!!state.logo && state.logo.painted && (state.logo.kind === '1' || state.logo.kind === '2'),
      'the final screen is the emulator-painted safe-to-turn-off bitmap');
    if (state.logo) {
      check(state.logo.colours <= 3 && state.logo.orange > 300 && state.logo.black > state.logo.total * 0.9,
        `orange text on black, nothing else (${state.logo.colours} colours, ${state.logo.orange} orange px)`);
    }
    await page.screenshot({ path: path.join(OUT, 'safe-to-turn-off.png') });
    // A moment later the picture grows its footer: same GDI, same orange,
    // two boxed choices. Painted, not HTML -- so it scales with the bitmap.
    const plainOrange = state.logo ? state.logo.orange : 0;
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#wine-power-screen canvas.logo');
      return canvas && canvas.dataset.kind === '2' && canvas.dataset.painted === '1';
    }, { timeout: 10000 });
    state = await page.evaluate(logoStats);
    check(!!state && state.colours === 3 && state.orange > plainOrange + 400,
      `the footer is painted into the bitmap (${state && state.colours} colours, ${state && state.orange} orange px, was ${plainOrange})`);
    await page.screenshot({ path: path.join(OUT, 'safe-to-turn-off-footer.png') });

    // The machine is off. A stray click or key must NOT restart it: only the
    // painted Restart box reloads the page, and the berrry.app box opens a
    // new tab and leaves the screen alone.
    await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 400));
    state = await page.evaluate(() => ({ phase: window.wineShutdown.phase() }));
    check(state.phase === 'off', 'a click on the dead screen and a key press leave the machine off');
    // Where the boxes are on screen: bitmap pixels through the canvas scale.
    const boxCentre = await page.evaluate(() => {
      const canvas = document.querySelector('#wine-power-screen canvas.logo');
      const rect = canvas.getBoundingClientRect();
      const out = {};
      for (const h of window.wineShutdown.footerHits()) {
        out[h.name] = {
          x: rect.left + (h.left + h.right) / 2 * rect.width / canvas.width,
          y: rect.top + (h.top + h.bottom) / 2 * rect.height / canvas.height,
        };
      }
      return out;
    });
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (url, target, features) => { window.__opened.push([url, target, features]); return null; };
    });
    await page.mouse.click(boxCentre.visit.x, boxCentre.visit.y);
    state = await page.evaluate(() => ({ phase: window.wineShutdown.phase(), opened: window.__opened }));
    check(state.phase === 'off' && state.opened.length === 1 && state.opened[0][0] === 'https://berrry.app' &&
      state.opened[0][1] === '_blank' && /noopener/.test(state.opened[0][2]),
      `the berrry.app box opens the site in a new tab and leaves the screen (${JSON.stringify(state.opened)})`);
    // Restart is the power button: the page reloads to a fresh desktop.
    const navigation = page.waitForNavigation({ waitUntil: 'load', timeout: 60000 });
    await page.mouse.click(boxCentre.restart.x, boxCentre.restart.y);
    await navigation;
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('.desktop-icon'), { timeout: 60000 });
    state = await page.evaluate(() => ({
      screen: !!document.getElementById('wine-power-screen'), running: runningApps.length,
    }));
    check(!state.screen && state.running === 0, 'Restart powers the machine back on');

    // ---- Shut down from a fresh desktop, nothing running ----
    // No instance is up to paint, so lib/shutdown.js boots a bare emulator
    // (fonts and GDI, no exe) just to paint the bitmap. The screen is black
    // until it arrives.
    await page.waitForFunction(() => window.wineShutdown, { timeout: 60000 });
    await page.evaluate(() => window.wineShutdown.run('shutdown'));
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#wine-power-screen canvas.logo');
      return canvas && canvas.dataset.painted === '1';
    }, { timeout: 120000 });
    state = await page.evaluate(logoStats);
    check(!!state && state.painted && state.blue > state.total * 0.6 && state.white > 200,
      `with nothing running, a bare instance paints the shutting-down screen (${state && state.colours} colours)`);
    check(!!state && state.centred, `and it sits centred in the viewport (${state && state.offset})`);
    // The bare instance is thrown away once it has painted; the second
    // screen must already be in hand, or it comes up black.
    await page.waitForFunction(() => window.wineShutdown.phase() === 'off', { timeout: 15000 });
    state = await page.evaluate(logoStats);
    check(!!state && state.painted && (state.kind === '1' || state.kind === '2') && state.colours <= 3 && state.orange > 300,
      `and the safe-to-turn-off screen is painted too (${state && state.colours} colours, ${state && state.orange} orange px)`);
    await page.screenshot({ path: path.join(OUT, 'bare-safe-to-turn-off.png') });
    await page.evaluate(() => window.wineShutdown.wake());

    // ---- Shut down while an app has the display (element fullscreen) ----
    // index.html puts #screen-wrap into element fullscreen for a game; a
    // browser paints nothing outside that element, so an overlay on <body>
    // is invisible there. The screen has to live inside the fullscreen
    // element, and survive the renderer leaving fullscreen when the last
    // guest window goes.
    await launchNotepad(page);
    await page.evaluate(() => {
      document.addEventListener('click', () => {
        document.getElementById('screen-wrap').requestFullscreen();
      }, { once: true });
    });
    await page.mouse.click(VIEWPORT.width - 5, VIEWPORT.height - 5);   // a trusted gesture
    await page.waitForFunction(() => document.fullscreenElement &&
      document.fullscreenElement.id === 'screen-wrap', { timeout: 10000 });
    await page.evaluate(() => window.wineShutdown.run('shutdown'));
    const visibleScreen = () => {
      const screen = document.getElementById('wine-power-screen');
      const canvas = screen && screen.querySelector('canvas.logo');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      const dx = (rect.left + rect.width / 2) - innerWidth / 2;
      const dy = (rect.top + rect.height / 2) - innerHeight / 2;
      return {
        inFullscreen: !!document.fullscreenElement && document.fullscreenElement.contains(screen),
        fullscreen: !!document.fullscreenElement,
        parent: screen.parentNode && (screen.parentNode.id || screen.parentNode.tagName),
        hitIsCanvas: hit === canvas,
        width: rect.width, height: rect.height,
        centred: Math.abs(dx) <= 2 && Math.abs(dy) <= 2 && rect.height >= innerHeight - 2,
        offset: `${dx.toFixed(1)},${dy.toFixed(1)} at ${rect.width}x${rect.height} in ${innerWidth}x${innerHeight}`,
      };
    };
    state = await page.evaluate(visibleScreen);
    check(!!state && state.inFullscreen && state.hitIsCanvas,
      `in fullscreen the screen mounts inside the fullscreen element (parent ${state && state.parent}, centre hits ${state && state.hitIsCanvas})`);
    check(!!state && state.centred, `and is centred there (${state && state.offset})`);
    await page.waitForFunction(() => window.wineShutdown.phase() === 'off', { timeout: 15000 });
    state = await page.evaluate(visibleScreen);
    check(!!state && state.hitIsCanvas && state.width > 0,
      `the final screen is still in front after the renderer left fullscreen (fullscreen=${state && state.fullscreen}, parent ${state && state.parent})`);
    await page.screenshot({ path: path.join(OUT, 'fullscreen-off.png') });
    await page.evaluate(() => window.wineShutdown.wake());

    // ---- Viewports that are not 4:3 ----
    // index.html styles every <canvas> as the app display (absolute at 0,0,
    // 100% x 100%, !important in its fullscreen states); on the 4:3 viewport
    // above that is indistinguishable from centred. A wide viewport must
    // pillarbox and a phone must letterbox, and a resize must refit.
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => window.wineShutdown.run('shutdown'));
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#wine-power-screen canvas.logo');
      return canvas && canvas.dataset.painted === '1';
    }, { timeout: 120000 });
    const box = () => {
      const canvas = document.querySelector('#wine-power-screen canvas.logo');
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
    };
    state = await page.evaluate(box);
    check(!!state && state.left === 120 && state.top === 0 && state.width === 1200 && state.height === 900,
      `a 1440x900 viewport pillarboxes the bitmap at x=120, 1200x900 (got ${JSON.stringify(state)})`);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#wine-power-screen canvas.logo');
      return canvas && canvas.getBoundingClientRect().width === 390;
    }, { timeout: 5000 });
    state = await page.evaluate(box);
    check(!!state && state.left === 0 && Math.abs(state.top - 276) <= 1 && state.width === 390 && Math.abs(state.height - 292) <= 1,
      `resized to 390x844 it letterboxes at y=276, 390x292 (got ${JSON.stringify(state)})`);
    await page.evaluate(() => window.wineShutdown.wake());
  } finally {
    await browser.close();
    if (server) server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
