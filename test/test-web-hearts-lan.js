#!/usr/bin/env node

// Two copies of Hearts in one browser tab, on the tab's own virtual LAN.
//
//   node test/test-web-hearts-lan.js [--timeout=300] [--headful] [--keep]
//
// test-win16-hearts-vlan.js proves the game across two OS processes. That path
// shares no code with the browser above the wire: the page has its own lobby,
// its own segment, and its own run loop, and none of it was exercised by
// anything. This test is the browser half -- index.html's "Both players here"
// button, lib/vlan-lobby.js, and the LoopbackSegment that stands in for the
// network when both players are the same person.
//
// WHY A BROWSER TEST AND NOT A CLI ONE: what is under test only exists in a
// page. test/run.js and tools/headless-run.js are the same host without a DOM,
// so neither can reach launchApp(), the lobby, or a second instance sharing one
// renderer. tools/profile-web-frames.js drives a page but launches one app and
// measures frame timings, not correctness.
//
// The two instances land on top of each other -- same guest, same window
// coordinates -- so every assertion reads the per-window back-canvas rather
// than the composited screen. A person can drag the top window aside; a script
// cannot click a window that is completely covered, so input goes to whichever
// instance was launched last and the dealer's New Game is posted to its own
// message queue directly.
//
// A failure here that also fails in test-win16-hearts-vlan.js is a DDE bug and
// belongs to that test. A failure here alone is the page's: the wire it handed
// the guest, the address it claimed, or the run loop that never pumped it.

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');
const OUT = path.join(ROOT, 'test', 'output', 'web-hearts-lan');
const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const flag = name => process.argv.includes(`--${name}`);
const BUDGET_MS = arg('timeout', 300) * 1000;
const MILESTONE_MS = arg('milestone-timeout', 90) * 1000;
const DEADLINE = Date.now() + BUDGET_MS;

let passed = 0;
let failed = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ` -- ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

if (!fs.existsSync(EXE)) {
  console.log('SKIP  MSHEARTS.EXE not found');
  process.exit(0);
}
if (!fs.existsSync(CHROME)) {
  console.log(`SKIP  no Chrome at ${CHROME} (set CHROME=)`);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) {
  if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
}

// The same points the CLI Hearts tests click. The dialogs come up at the same
// place in the browser -- the guest chooses the coordinates, not the host.
const NAME_FIELD = [200, 122];
const DEALER_RADIO = [55, 210];      // "I want to be dealer"
const CONNECT_RADIO = [55, 190];     // "I want to connect to another game"
const OK_BUTTON = [319, 92];
const LOCATE_FIELD = [80, 132];
const LOCATE_OK = [284, 90];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.wat': 'text/plain', '.exe': 'application/octet-stream',
};

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
      if (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 500);
        res.end(error.code || 'read error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll a page-side predicate. Bounded twice over: by its own milestone and by
// the whole run's budget, so a stuck emulator ends the test instead of the
// harness waiting out its parent's patience.
async function until(page, label, fn, argument, ms = MILESTONE_MS) {
  const limit = Math.min(Date.now() + ms, DEADLINE);
  let complained = false;
  while (Date.now() < limit) {
    let value = null;
    try {
      value = await page.evaluate(fn, argument);
    } catch (error) {
      // A polling predicate that throws every time looks exactly like a
      // milestone that never arrives, and cost this test a whole debugging
      // round the first time -- the page-side helpers are injected by name,
      // and a callback that closes over the Node-side copy is a ReferenceError
      // in the tab. Say it once and keep polling.
      if (!complained) {
        complained = true;
        console.log(`  [poll] ${label}: ${String(error).split('\n')[0]}`);
      }
    }
    if (value) return value;
    await sleep(500);
  }
  console.log(`[timeout] ${label}`);
  return null;
}

// ---- page-side helpers -----------------------------------------------------
//
// These run in the tab, not here. Puppeteer serializes the function it is
// handed and evaluates it there, so a callback cannot close over one of these
// -- it has to call it by name off `window`, and installHelpers() is what puts
// the names there. (A predicate that closes over the Node-side copy raises a
// ReferenceError on every poll, which reads as a milestone that never came.)

// Every window of one instance, by its hwnd base: the browser gives each app a
// 0x10000-wide range, which is the only thing that says which of two identical
// Hearts a window belongs to.
const instanceWindows = (index) => {
  const app = runningApps[index];
  if (!app) return null;
  const base = app.wine._hwndBase >>> 0;
  return Object.values(sharedRenderer.windows || {})
    .filter(w => w && ((w.hwnd >>> 0) & 0xFFFF0000) === (base & 0xFFFF0000))
    .map(w => ({
      hwnd: w.hwnd >>> 0, title: w.title || '', x: w.x, y: w.y, w: w.w, h: w.h,
      visible: !!w.visible, dialog: !!w.isDialog, z: w.zOrder || 0,
    }));
};

// The table is green baize and the cards on it are white -- the same two
// fractions the CLI test reads out of its PNGs, measured here on the window's
// own back-canvas so a covered window is still readable.
const tallyWindow = ({ index, wantTitle }) => {
  const app = runningApps[index];
  if (!app) return null;
  const base = (app.wine._hwndBase >>> 0) & 0xFFFF0000;
  const win = Object.values(sharedRenderer.windows || {}).find(w =>
    w && w.visible && !w.isDialog && ((w.hwnd >>> 0) & 0xFFFF0000) === base
    && (!wantTitle || String(w.title || '').includes(wantTitle))
    && w.w > 300 && w.h > 300);
  if (!win) return null;
  // getWindowCanvas hands back {canvas, ctx}: the surface is an OffscreenCanvas
  // in the browser, so it has no toDataURL and the context has to come from
  // there rather than be asked for again.
  const surface = sharedRenderer.getWindowCanvas(win.hwnd);
  if (!surface || !surface.canvas) return null;
  const canvas = surface.canvas;
  const ctx = surface.ctx;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let green = 0, white = 0, total = 0;
  for (let y = 30; y < canvas.height - 20; y++) {
    for (let x = 20; x < canvas.width - 20; x++) {
      const i = (y * canvas.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      if (g > 90 && r < 60 && b < 60) green++;
      else if (r > 230 && g > 230 && b > 230) white++;
    }
  }
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d').drawImage(canvas, 0, 0);
  return {
    hwnd: win.hwnd >>> 0, w: canvas.width, h: canvas.height,
    green: green / total, white: white / total,
    png: copy.toDataURL('image/png'),
  };
};

const wireStats = () => runningApps.map(a => ({
  name: a.name,
  ip: a.wine.vlanLocalIp >>> 0,
  sent: a.wine.vlanWire ? a.wine.vlanWire.sentFrames : -1,
  recv: a.wine.vlanWire ? a.wine.vlanWire.recvFrames : -1,
  pending: a.wine.vlanWire ? a.wine.vlanWire.pending : -1,
}));

// Hearts deals from its File menu. The dealer is the covered window by the time
// this is wanted, and a menu command is a message either way -- the CLI harness
// posts it to the same queue at 0x400 for exactly this reason.
const postCommand = ({ index, id }) => {
  const app = runningApps[index];
  if (!app) return false;
  const e = app.wine.instance.exports;
  const count = e.get_post_queue_count ? e.get_post_queue_count() : 0;
  if (count >= 8) return false;
  const dv = new DataView(app.wine.memory.buffer);
  const off = 0x400 + count * 16;
  dv.setUint32(off, e.get_main_hwnd(), true);
  dv.setUint32(off + 4, 0x111, true);          // WM_COMMAND
  dv.setUint32(off + 8, id, true);
  dv.setUint32(off + 12, 0, true);
  e.set_post_queue_count(count + 1);
  return true;
};

async function installHelpers(page) {
  await page.evaluate(`
    window.instanceWindows = ${instanceWindows.toString()};
    window.tallyWindow = ${tallyWindow.toString()};
    window.wireStats = ${wireStats.toString()};
    window.postCommand = ${postCommand.toString()};
  `);
}

// ---- driving ---------------------------------------------------------------

// One line per instance, at every milestone. Two identical Hearts stacked on
// one another is a state no screenshot can describe, and "which window is up"
// is the question every step here turns on.
async function dump(page, label) {
  const all = await page.evaluate(() => runningApps.map((_, i) => instanceWindows(i)));
  for (let i = 0; i < all.length; i++) {
    const windows = (all[i] || []).filter(w => w.visible)
      .map(w => `0x${w.hwnd.toString(16)}${w.dialog ? '(dlg)' : ''}@${w.x},${w.y} ${w.w}x${w.h}`);
    console.log(`  [${label}] instance ${i}: ${windows.join('  ') || 'nothing visible'}`);
  }
}

async function click(page, [x, y]) {
  await page.evaluate(({ x, y }) => {
    sharedRenderer.handleMouseDown(x, y, 0);
    sharedRenderer.handleMouseUp(x, y, 0);
  }, { x, y });
  await sleep(600);
}

// Both instances share one tab's localStorage, so the second player's name box
// comes up pre-filled with the first player's name -- correct for two people on
// one Windows machine, and confusing in a screenshot. Clear it first so the
// seat labels read "D" and "C".
async function retype(page, where, text) {
  await click(page, where);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => sharedRenderer.handleKeyPress(8));   // backspace
  }
  await sleep(300);
  await type(page, text);
}

async function type(page, text) {
  for (const ch of text) {
    await page.evaluate(code => sharedRenderer.handleKeyPress(code), ch.charCodeAt(0));
    await sleep(250);
  }
}

async function launchLocal(page, label) {
  const before = await page.evaluate(() => runningApps.length);
  await page.evaluate(() => {
    document.getElementById('app-select').value = 'mshearts16';
    launchApp();
  });
  const lobby = await until(page, `${label}: lobby did not open`, () =>
    [...document.querySelectorAll('.vln-lobby button')]
      .some(b => b.textContent === 'Both players here'));
  if (!lobby) return null;
  await page.evaluate(() => {
    [...document.querySelectorAll('.vln-lobby button')]
      .find(b => b.textContent === 'Both players here').click();
  });
  const started = await until(page, `${label}: instance never started`,
    n => runningApps.length > n, before);
  if (!started) return null;
  const index = before;
  const up = await until(page, `${label}: welcome dialog never appeared`, i => {
    const app = runningApps[i];
    if (!app || !app.wine._hwndBase) return false;
    const base = (app.wine._hwndBase >>> 0) & 0xFFFF0000;
    return Object.values(sharedRenderer.windows || {}).some(w =>
      w && w.visible && w.isDialog && ((w.hwnd >>> 0) & 0xFFFF0000) === base);
  }, index);
  return up ? index : null;
}

function savePng(name, dataUrl) {
  if (!dataUrl) return;
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(base64, 'base64'));
}

(async () => {
  const server = await startStaticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'web-hearts-lan-'));
  const browser = await puppeteer.launch({
    headless: !flag('headful'),
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  const problems = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', e => problems.push(String(e)));
    page.on('console', m => {
      const t = m.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|crashed|FATAL:/i.test(t)) {
        problems.push(t.slice(0, 300));
      }
    });
    await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('typeof launchApp === "function"', { timeout: 60000 });
    await installHelpers(page);

    // initDesktop() drops every <option> it does not also put on the desktop,
    // so an app can be fully wired in `apps` and unreachable from the page.
    // Hearts spent its whole life in that state.
    const reachable = await page.evaluate(() => ({
      option: [...document.getElementById('app-select').options].some(o => o.value === 'mshearts16'),
      icon: !!document.querySelector('.desktop-icon[data-app="mshearts16"]'),
    }));
    check('Hearts is reachable from the page (list and desktop)',
      reachable.option && reachable.icon, JSON.stringify(reachable));

    // The desktop shows each app's own icon, read out of the executable. For a
    // 16-bit NE that means the flat resource table -- until it was read, Hearts
    // sat there as the fallback emoji.
    const drawn = await until(page, 'the Hearts desktop icon stayed a fallback glyph', () => {
      const img = document.querySelector('.desktop-icon[data-app="mshearts16"] .icon-img img');
      return img && img.src.startsWith('data:image/png') ? img.src.length : null;
    }, null, 20000);
    check('the desktop shows Hearts\' own icon from the NE resources', !!drawn,
      'still the emoji fallback');

    // ---- the dealer ------------------------------------------------------
    const dealer = await launchLocal(page, 'dealer');
    check('the dealer launched onto the tab segment', dealer !== null, 'no welcome dialog');
    if (dealer === null) throw new Error('dealer never started');

    await retype(page, NAME_FIELD, 'D');
    await click(page, DEALER_RADIO);
    await click(page, OK_BUTTON);

    // Leaving the dialog is what puts the dealer at a table, and the table is
    // where it registers its DDE service. Until then there is nothing for the
    // other player to find.
    const atTable = await until(page, 'the dealer never reached its table',
      i => instanceWindows(i) && instanceWindows(i).every(w => !w.visible || !w.dialog),
      dealer);
    check('the dealer left its welcome dialog', !!atTable, 'dialog still up');

    // ---- the client ------------------------------------------------------
    const client = await launchLocal(page, 'client');
    check('a second Hearts started without stopping the first', client !== null
      && await page.evaluate(() => runningApps.length) === 2,
      'the relaunch cleanup took the dealer down');
    if (client === null) throw new Error('client never started');

    const addresses = await page.evaluate(wireStats);
    check(`the two instances hold different room addresses (${addresses.map(a =>
      [24, 16, 8, 0].map(s => (a.ip >>> s) & 255).join('.')).join(', ')})`,
      addresses.length === 2 && addresses[0].ip !== addresses[1].ip
      && addresses[0].ip !== 0 && addresses[1].ip !== 0,
      JSON.stringify(addresses));

    await retype(page, NAME_FIELD, 'C');
    await click(page, CONNECT_RADIO);
    await click(page, OK_BUTTON);

    // "Locate dealer" wants a computer name and any name will do: what Hearts
    // connects to is the NetDDE agent \\NAME\NDDE$ with topic "Hearts$", and
    // the share is what resolves to the local (MSHearts, Hearts) pair.
    const locate = await until(page, 'the "Locate dealer" box never appeared', i => {
      const app = runningApps[i];
      const b = (app.wine._hwndBase >>> 0) & 0xFFFF0000;
      return Object.values(sharedRenderer.windows || {}).some(w =>
        w && w.visible && w.isDialog && ((w.hwnd >>> 0) & 0xFFFF0000) === b);
    }, client);
    check('the client was asked which computer to find', !!locate, 'no dialog');
    await click(page, LOCATE_FIELD);
    await type(page, 'DEAL');
    await click(page, LOCATE_OK);

    // The wire is the evidence that the two instances are on one segment at
    // all. "Nothing was asked" and "nobody answered" are different bugs.
    const crossed = await until(page, 'no frames crossed the tab segment', () => {
      const s = runningApps.map(a => a.wine.vlanWire);
      return s.length === 2 && s.every(w => w && w.sentFrames > 0 && w.recvFrames > 0);
    });
    check('DDE frames crossed the tab segment both ways', !!crossed,
      JSON.stringify(await page.evaluate(wireStats)));

    const joined = await until(page, 'the client never reached a table',
      i => instanceWindows(i) && instanceWindows(i).every(w => !w.visible || !w.dialog),
      client);
    check('the client reached a table', !!joined,
      'a refused connect leaves "Unable to connect with dealer"');

    // Seating the player is a poke, a request and the advise loops that follow
    // it; dealing in the middle of those gets the rest refused with "the game
    // is already in progress". Wait for the wire to go quiet instead of
    // guessing at a delay.
    let last = null;
    await until(page, 'the wire never settled', () => {
      const now = runningApps.map(a => a.wine.vlanWire.recvFrames).join(',');
      const settled = now === window.__lastWire;
      window.__lastWire = now;
      return settled;
    }, null, 30000);
    last = await page.evaluate(wireStats);

    // ---- the deal --------------------------------------------------------
    const dealt = await page.evaluate(postCommand, { index: dealer, id: 102 });
    check('New Game reached the dealer', dealt, 'post queue was full');

    const dealerTable = await until(page, 'the dealer never drew a hand',
      i => { const t = tallyWindow({ index: i, wantTitle: 'Hearts' }); return t && t.white > 0.1 ? t : null; },
      dealer);
    check(`the dealer has cards on its table (${dealerTable
      ? (dealerTable.white * 100).toFixed(0) : '0'}% white)`, !!dealerTable,
      JSON.stringify(await page.evaluate(tallyWindow, { index: dealer, wantTitle: 'Hearts' })));
    savePng('dealer-dealt', dealerTable && dealerTable.png);

    // The assertion the whole test exists for: the other instance is looking at
    // a table with thirteen cards of its own on it, and the only place those can
    // have come from is the dealer, across the tab's segment.
    const clientTable = await until(page, 'the client never drew a hand',
      i => { const t = tallyWindow({ index: i, wantTitle: 'Hearts' }); return t && t.white > 0.1 ? t : null; },
      client);
    check(`the client was dealt a hand too (${clientTable
      ? `${(clientTable.green * 100).toFixed(0)}% baize, ${(clientTable.white * 100).toFixed(0)}% cards`
      : 'nothing drawn'})`,
      !!clientTable && clientTable.green > 0.2,
      JSON.stringify(await page.evaluate(tallyWindow, { index: client, wantTitle: 'Hearts' })));
    savePng('client-dealt', clientTable && clientTable.png);

    // Both tables are stacked at the same coordinates, so switching between
    // them is how one person actually plays this. The taskbar is the way --
    // there is no exposed edge of the covered window to click.
    const raised = await page.evaluate(index => {
      const app = runningApps[index];
      const base = (app.wine._hwndBase >>> 0) & 0xFFFF0000;
      const buttons = [...document.querySelectorAll('#task-buttons .task-btn')];
      if (buttons.length < 2) return null;
      buttons[index].click();
      const mine = Object.values(sharedRenderer.windows)
        .filter(w => w.visible && !w.isChild && ((w.hwnd >>> 0) & 0xFFFF0000) === base);
      const others = Object.values(sharedRenderer.windows)
        .filter(w => w.visible && !w.isChild && ((w.hwnd >>> 0) & 0xFFFF0000) !== base);
      const top = a => a.reduce((m, w) => Math.max(m, w.zOrder || 0), -1);
      return { buttons: buttons.length, mine: top(mine), others: top(others) };
    }, dealer);
    check('the taskbar brings the covered player to the front',
      !!raised && raised.buttons >= 2 && raised.mine > raised.others,
      JSON.stringify(raised));

    await page.screenshot({ path: path.join(OUT, 'page.png') });
    check('the page reported no errors', problems.length === 0, problems.join(' | '));

    console.log(`\nwire at the deal: ${JSON.stringify(last)}`);
    console.log(`final: ${JSON.stringify(await page.evaluate(wireStats))}`);
    console.log(`Screenshots: ${OUT}`);
  } finally {
    if (!flag('keep')) await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
