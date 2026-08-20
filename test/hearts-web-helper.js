// Shared driving for the two browser Hearts tests: test-web-hearts-lan.js
// (two instances in one tab, on a page-local segment) and
// test-web-hearts-rtc.js (two browsers, over a real DataChannel). The game and
// its dialogs are identical; only what the two instances are connected by
// differs, which is exactly what each test should be left saying.
//
// PAGE SIDE VS NODE SIDE. Puppeteer serializes each callback and evaluates it
// in the tab, so a predicate cannot close over anything here -- it has to call
// a helper by name off `window`, and installHelpers() is what puts the names
// there. A callback that closes over the Node-side copy raises a
// ReferenceError on every poll, which reads exactly like a milestone that
// never arrives. That mistake cost a debugging round; hence this note.

'use strict';

const fs = require('fs');
const path = require('path');

// Points on the welcome dialog and on the "Locate dealer" box behind the
// client's radio button -- the same coordinates the CLI Hearts tests click.
// The guest chooses where its dialogs go, not the host, so they are the same
// in a browser.
const NAME_FIELD = [200, 122];
const DEALER_RADIO = [55, 210];      // "I want to be dealer"
const CONNECT_RADIO = [55, 190];     // "I want to connect to another game"
const OK_BUTTON = [319, 92];
const LOCATE_FIELD = [80, 132];
const LOCATE_OK = [284, 90];

const CHROME_CANDIDATES = [
  process.env.CHROME,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES.filter(Boolean)) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
  }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- page-side helpers -----------------------------------------------------

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

// True once the instance has no dialog up: it has answered the welcome box and
// is sitting at a table. That is also where a dealer registers its DDE
// service, so nothing can find it before this.
const atTable = (index) => {
  const windows = instanceWindows(index);
  return !!windows && windows.length > 0 && windows.every(w => !w.visible || !w.dialog);
};

const hasDialog = (index) => {
  const windows = instanceWindows(index);
  return !!windows && windows.some(w => w.visible && w.dialog);
};

// The table is green baize and the cards on it are white -- the same two
// fractions the CLI test reads out of its PNGs, measured on the window's own
// back-canvas so a covered window is still readable.
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
  const data = surface.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
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

// Hearts deals from its File menu. A menu command is a message either way, and
// the CLI harness posts it into the same queue at 0x400 for the same reason:
// the dealer's window may well be covered by the time it is wanted.
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
    window.atTable = ${atTable.toString()};
    window.hasDialog = ${hasDialog.toString()};
    window.tallyWindow = ${tallyWindow.toString()};
    window.wireStats = ${wireStats.toString()};
    window.postCommand = ${postCommand.toString()};
  `);
}

// ---- polling ---------------------------------------------------------------

// A whole-run budget, so one stuck milestone cannot spend the time the rest of
// the test needs. Set once at the top of a run.
let DEADLINE = Infinity;
function budget(ms) { DEADLINE = Date.now() + ms; }
function outOfTime() { return Date.now() >= DEADLINE; }

async function until(page, label, fn, argument, ms = 90000) {
  const limit = Math.min(Date.now() + ms, DEADLINE);
  let complained = false;
  while (Date.now() < limit) {
    let value = null;
    try {
      value = await page.evaluate(fn, argument);
    } catch (error) {
      // Say it once and keep polling: a predicate that throws every time is
      // indistinguishable from a milestone that never comes.
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

// ---- driving ---------------------------------------------------------------

async function click(page, [x, y]) {
  await page.evaluate(({ x, y }) => {
    sharedRenderer.handleMouseDown(x, y, 0);
    sharedRenderer.handleMouseUp(x, y, 0);
  }, { x, y });
  await sleep(600);
}

async function type(page, text) {
  for (const ch of text) {
    await page.evaluate(code => sharedRenderer.handleKeyPress(code), ch.charCodeAt(0));
    await sleep(250);
  }
}

// Hearts remembers the last player name, so the box may come up pre-filled --
// with the other player's name, when both instances share one tab's storage.
// Clear it so the seat labels are unambiguous.
async function retype(page, where, text) {
  await click(page, where);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => sharedRenderer.handleKeyPress(8));   // backspace
  }
  await sleep(300);
  await type(page, text);
}

// The welcome dialog: name, which side of the game to be on, OK.
async function answerWelcome(page, { name, role }) {
  await retype(page, NAME_FIELD, name);
  await click(page, role === 'dealer' ? DEALER_RADIO : CONNECT_RADIO);
  await click(page, OK_BUTTON);
}

// "Locate dealer" wants a computer name and any name will do: what Hearts
// connects to is the NetDDE agent \\NAME\NDDE$ with topic "Hearts$", and the
// share is what resolves to the local (MSHearts, Hearts) pair. Nothing ever
// compares the name against a machine.
async function answerLocate(page, name = 'DEAL') {
  await click(page, LOCATE_FIELD);
  await type(page, name);
  await click(page, LOCATE_OK);
}

// One line per instance. "Which window is up" is the question every step turns
// on, and with two identical Hearts no screenshot can answer it.
async function dumpWindows(page, label) {
  const all = await page.evaluate(() => runningApps.map((_, i) => instanceWindows(i)));
  for (let i = 0; i < all.length; i++) {
    const windows = (all[i] || []).filter(w => w.visible)
      .map(w => `0x${w.hwnd.toString(16)}${w.dialog ? '(dlg)' : ''}@${w.x},${w.y} ${w.w}x${w.h}`);
    console.log(`  [${label}] instance ${i}: ${windows.join('  ') || 'nothing visible'}`);
  }
}

function savePng(dir, name, dataUrl) {
  if (!dataUrl) return;
  fs.mkdirSync(dir, { recursive: true });
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(base64, 'base64'));
}

// Screenshots are the evidence a run is read from, and one left over from a
// previous run does not merely confuse -- it answers a wait instantly.
function clearPngs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.png')) fs.unlinkSync(path.join(dir, f));
  }
}

module.exports = {
  NAME_FIELD, DEALER_RADIO, CONNECT_RADIO, OK_BUTTON, LOCATE_FIELD, LOCATE_OK,
  findChrome, sleep, budget, outOfTime, until, installHelpers,
  click, type, retype, answerWelcome, answerLocate, dumpWindows,
  savePng, clearPngs,
  pageHelpers: { instanceWindows, tallyWindow, wireStats, postCommand },
};
