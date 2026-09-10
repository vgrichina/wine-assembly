#!/usr/bin/env node
// Single-app mode, aspect-preserving expansion (`keepAspect` in lib/apps.js).
//
// Maximizing normally means "the whole canvas", and that is right for an app
// that answers a bigger client rect by showing more of its document. It is
// wrong for one that relays its artwork out to whatever it is given, per axis:
// Taipei stretches its 144 tiles and Pegged its holes, so a portrait phone
// hands them a distorted board rather than a bigger one. Nothing in the
// presentation path stretches — the distortion is the guest's own layout, so
// the only thing that can fix it is the rect the guest is handed.
//
// `keepAspect` makes maximize mean "the largest rect that fits the canvas at
// this window's own aspect ratio" instead, and the existing single-app fit
// letterboxes what is left. What this test pins down:
//   * the aspect that is preserved is the CLIENT one, because caption + menu
//     are a fixed pixel band and fitting the outer rect distorts the client by
//     exactly the chrome's worth,
//   * the source it is taken from is the window's PRE-expansion size, which
//     survives in _restoreRect once the window is maximized,
//   * an unflagged app still gets the whole canvas, unchanged,
//   * the resulting presentation letterboxes rather than stretches, and the
//     touch overlay's bottom inset still comes off the top of it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { Win98Renderer } = require('../lib/renderer');

const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_VISIBLE = 0x10000000;

function makeRenderer(canvasW, canvasH, keepAspect) {
  const renderer = new Win98Renderer({
    width: canvasW,
    height: canvasH,
    getContext() { return {}; },
  });
  renderer.singleAppMode = true;
  renderer.singleAppKeepAspect = !!keepAspect;
  renderer.presentationCanvas = { width: canvasW, height: canvasH };
  return renderer;
}

// A window as the renderer holds it, with the chrome band its client rect
// implies. Taipei's real numbers: a 400x300 outer frame with a 392x254 client,
// so 8px of border and 46px of caption + menu.
function win(x, y, w, h, chromeW, chromeH) {
  return {
    hwnd: 0x10001,
    x, y, w, h,
    style: WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX | WS_VISIBLE,
    visible: true,
    isChild: false,
    className: 'app',
    clientRect: { x: x + chromeW / 2, y: y + chromeH, w: w - chromeW, h: h - chromeH },
  };
}

const aspect = rect => rect.w / rect.h;

// --- The fit itself ---------------------------------------------------------

// Taipei on a 400x681 portrait canvas. Its client is 392x254 (1.543); the
// widest rect that keeps that on a 400px canvas is the 400x300 it started at,
// so the window does not grow and the picture is letterboxed instead of
// stretched to 2.5x its natural height.
{
  const renderer = makeRenderer(400, 681, true);
  const natural = { x: 20, y: 20, w: 400, h: 300 };
  const fitted = renderer._singleAppMaximizeRect(win(20, 20, 400, 300, 8, 46), natural);
  assert.ok(fitted, 'a keepAspect app should get a fitted rect');
  assert.strictEqual(fitted.w, 400, 'the fit is limited by the canvas width here');
  assert.strictEqual(fitted.h, 300, 'so the height follows the client aspect, not the canvas');
  const clientBefore = { w: 392, h: 254 };
  const clientAfter = { w: fitted.w - 8, h: fitted.h - 46 };
  assert.ok(Math.abs(aspect(clientAfter) - aspect(clientBefore)) < 0.01,
    `client aspect should survive the expansion (${aspect(clientAfter)} vs ${aspect(clientBefore)})`);
}

// The same window on a canvas that is roomy in both directions grows to fill
// the tighter axis — the point is the largest rect that fits, not "never
// resize".
{
  const renderer = makeRenderer(1200, 700, true);
  const fitted = renderer._singleAppMaximizeRect(
    win(20, 20, 400, 300, 8, 46), { x: 20, y: 20, w: 400, h: 300 });
  assert.strictEqual(fitted.h, 700, 'height is the tighter axis on this canvas');
  assert.ok(fitted.w > 400 && fitted.w <= 1200, 'and the width grows with it');
  const clientAfter = { w: fitted.w - 8, h: fitted.h - 46 };
  assert.ok(Math.abs(aspect(clientAfter) - 392 / 254) < 0.01,
    'the client aspect is what is held constant');
}

// Client, not outer. Fitting the OUTER 4:3 of a 400x300 Taipei window into a
// 400-wide canvas would give the same 400x300 here, so the two rules have to be
// separated on a canvas where they disagree: 380x900 leaves the height free.
{
  const renderer = makeRenderer(380, 900, true);
  const fitted = renderer._singleAppMaximizeRect(
    win(20, 20, 400, 300, 8, 46), { x: 20, y: 20, w: 400, h: 300 });
  const clientAfter = { w: fitted.w - 8, h: fitted.h - 46 };
  assert.ok(Math.abs(aspect(clientAfter) - 392 / 254) < 0.01,
    'the client aspect is preserved exactly');
  const outerFitH = Math.round(380 * 300 / 400);
  assert.notStrictEqual(fitted.h, outerFitH,
    'an outer-rect fit would land somewhere else — this must not be that rule');
}

// A window that already fills the canvas has nothing to fit into, and the
// clamp must not produce something bigger than the screen.
{
  const renderer = makeRenderer(400, 681, true);
  const fitted = renderer._singleAppMaximizeRect(
    win(0, 0, 800, 600, 8, 46), { x: 0, y: 0, w: 800, h: 600 });
  assert.ok(fitted.w <= 400 && fitted.h <= 681, 'the fit never exceeds the canvas');
  assert.ok(fitted.x >= 0 && fitted.y >= 0, 'and never starts off-screen');
}

// --- When it does NOT apply -------------------------------------------------

{
  const renderer = makeRenderer(400, 681, false);
  assert.strictEqual(
    renderer._singleAppMaximizeRect(win(20, 20, 400, 300, 8, 46), { w: 400, h: 300 }),
    null, 'an app without keepAspect gets the ordinary full-canvas maximize');
}
{
  const renderer = makeRenderer(400, 681, true);
  renderer.singleAppMode = false;
  assert.strictEqual(
    renderer._singleAppMaximizeRect(win(20, 20, 400, 300, 8, 46), { w: 400, h: 300 }),
    null, 'on a desktop screen the app manages its own window as always');
}
{
  const renderer = makeRenderer(400, 681, true);
  assert.strictEqual(
    renderer._singleAppMaximizeRect(win(20, 20, 400, 300, 8, 46), null),
    null, 'with no pre-expansion size to preserve there is no aspect to keep');
}

// --- Through showWindow, which is the path SC_MAXIMIZE actually takes --------

function maximize(renderer, w) {
  renderer.windows[w.hwnd] = w;
  renderer.showWindow(w.hwnd, 3); // SW_SHOWMAXIMIZED
  return w;
}

{
  const renderer = makeRenderer(400, 681, true);
  const w = maximize(renderer, win(20, 20, 400, 300, 8, 46));
  assert.strictEqual(w._maximized, true, 'the window is still maximized');
  assert.deepStrictEqual({ w: w.w, h: w.h }, { w: 400, h: 300 },
    'but to the fitted rect, not the canvas');
  assert.deepStrictEqual(w._restoreRect, { x: 20, y: 20, w: 400, h: 300 },
    'and the pre-expansion rect is still what SC_RESTORE puts back');
}
{
  const renderer = makeRenderer(400, 681, false);
  const w = maximize(renderer, win(20, 20, 400, 300, 8, 46));
  assert.deepStrictEqual({ x: w.x, y: w.y, w: w.w, h: w.h },
    { x: 0, y: 0, w: 400, h: 681 },
    'an unflagged app still takes the whole canvas — this is the common case');
}

// A second maximize (an app that maximizes itself after the shell already did)
// must keep reading the natural size out of _restoreRect, not re-derive it from
// the rect the first maximize produced.
{
  const renderer = makeRenderer(400, 681, true);
  const w = maximize(renderer, win(20, 20, 400, 300, 8, 46));
  const first = { w: w.w, h: w.h };
  renderer.showWindow(w.hwnd, 3);
  assert.deepStrictEqual({ w: w.w, h: w.h }, first, 'maximizing twice is idempotent');
}

// Rotating the phone re-fits rather than snapping back to the full screen.
{
  const renderer = makeRenderer(400, 681, true);
  const w = maximize(renderer, win(20, 20, 400, 300, 8, 46));
  renderer.canvas.width = 681;
  renderer.canvas.height = 400;
  renderer.handleScreenResize(400, 681, 681, 400);
  assert.ok(w.h <= 400 && w.w <= 681, 'the re-fit stays inside the rotated canvas');
  // Chrome is re-measured from the window as it stands, so read it back rather
  // than assuming the numbers the window was built with: what must hold is that
  // the natural rect and the fitted one have the same CLIENT aspect under one
  // and the same chrome band.
  const chromeW = w.w - w.clientRect.w;
  const chromeH = w.h - w.clientRect.h;
  const want = (400 - chromeW) / (300 - chromeH);
  assert.ok(Math.abs(aspect(w.clientRect) - want) < 0.02,
    `the re-fit still holds the client aspect (${aspect(w.clientRect)} vs ${want})`);
}

// --- What reaches the screen ------------------------------------------------

// The fitted window then goes through the ordinary single-app fit: the source
// rectangle and the destination rectangle have the same aspect ratio, which is
// the definition of "letterboxed, not stretched".
{
  const renderer = makeRenderer(400, 681, true);
  const w = maximize(renderer, win(20, 20, 400, 300, 8, 46));
  const zoom = renderer._computeSingleAppZoom([w]);
  assert.ok(zoom && zoom.viewport, 'a fitted window is smaller than the canvas, so it is zoomed');
  const v = zoom.viewport;
  assert.ok(Math.abs((v.cropW / v.cropH) - (v.dstW / v.dstH)) < 0.01,
    `presentation must not stretch (${v.cropW}x${v.cropH} -> ${v.dstW}x${v.dstH})`);
  assert.strictEqual(v.dstW, 400, 'it fills the width it can');
  assert.ok(v.dstY > 0, 'and letterboxes the rest');
}

// The touch overlay's reserved band comes off the same presentation, so a
// keepAspect app with on-screen controls still keeps its buttons in clear space.
{
  const renderer = makeRenderer(400, 681, true);
  const w = maximize(renderer, win(20, 20, 400, 300, 8, 46));
  renderer.touchOverlay = { getOccupiedFraction: () => 150 / 681 };
  const v = renderer._computeSingleAppZoom([w]).viewport;
  assert.strictEqual(v.bottomInset, 150, 'the band is still reserved');
  assert.ok(v.dstY + v.dstH <= 681 - 150 + 1, 'and the picture stays above it');
  assert.ok(Math.abs((v.cropW / v.cropH) - (v.dstW / v.dstH)) < 0.01,
    'the inset must not stretch the picture either');
}

// --- The registry and the shell --------------------------------------------

const apps = require('../lib/apps.js');
const registry = apps.APPS || (apps.WineApps && apps.WineApps.APPS) || apps;
for (const id of ['taipei', 'pegged', 'cwordzap']) {
  assert.strictEqual(registry[id] && registry[id].keepAspect, true,
    `${id} stretches its board to the client rect and must be flagged`);
}
// Reversi is the negative control from the same pack: same WS_THICKFRAME, same
// single-app maximize, but it draws a fixed-size board centred in whatever it
// is given, so full-canvas is already correct for it. Notepad likewise shows
// more text rather than bigger text, and the card games spread fixed-size card
// bitmaps out rather than scaling them. All measured on a 400x681 canvas.
for (const id of ['reversi', 'notepad', 'mspaint98', 'sol', 'spider', 'cruel',
                  'golf', 'freecell', 'fourstones', 'funtris']) {
  assert.ok(!registry[id] || !registry[id].keepAspect,
    `${id} answers a bigger client rect with more content, so it must NOT be flagged`);
}

const shellSource = fs.readFileSync(path.join(root, 'lib', 'browser-shell.js'), 'utf8');
const { hasPageScript } = require('./browser-runtime-scripts');
assert(shellSource.includes('keepAspect: app.keepAspect === true'),
  'the shell should carry the registry flag onto the running app');
assert(shellSource.includes('sharedRenderer.singleAppKeepAspect = !!(last && last.keepAspect)'),
  'and hand it to the renderer, which is what decides the maximize rect');
assert(/const alreadyFull = !keepAspect &&/.test(shellSource),
  'the "already full-screen, nothing to do" shortcut must not skip the fitted resize');

for (const file of ['lib/renderer.js', 'lib/apps.js', 'lib/browser-shell.js']) {
  assert(hasPageScript(file), `${file} should stay centrally versioned`);
}

console.log('PASS  single-app keepAspect: fitted maximize, client aspect, letterboxed present');
