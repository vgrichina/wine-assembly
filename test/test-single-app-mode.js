#!/usr/bin/env node
// Single-app mode: on a phone-sized screen the page runs exactly one guest,
// shows no taskbar, hides the desktop icons while it runs, and presents the
// app scaled to fill the screen.
//
// The zoom is a presentation crop, not a second drawing path: the desktop
// canvas is composited exactly as always and only the rectangle the app
// occupies is scaled out to the display, so a dialog that overhangs its owner
// widens the crop instead of replacing the window underneath it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shellSource = fs.readFileSync(path.join(root, 'lib', 'browser-shell.js'), 'utf8');

// --- The page: detection, chrome, and the reported screen size ---
assert(html.includes('function detectSingleAppMode()'), 'page should decide single-app mode explicitly');
// Size is necessary but not sufficient. visualViewport is CSS pixels, so a
// desktop browser at 175% zoom reports a phone-sized page; handing that the
// phone layout takes away the taskbar and the icons on a machine with a mouse.
assert(html.includes("matchMedia('(pointer: coarse)')"),
  'a zoomed or narrowed desktop window is still a desktop: it has a fine pointer');
assert(html.includes('const phoneScreen ='),
  'a phone-sized physical screen also qualifies, for a browser that reports no pointer type');
assert(html.includes('const vv = window.visualViewport'),
  'the page, not window.screen, is what a device simulator scales down');
assert(html.includes('const phoneSized = sw < 640 || sh < 520'),
  'the threshold is whether a 640x480 guest screen and its taskbar fit at 1:1 — '
  + '800x600 was a comfortable desktop in 1998 and is still a desktop here');
assert(html.includes('function applySingleAppMode()') && html.includes('applySingleAppMode();\n      const canvas'),
  'resizing across the threshold should switch the mode, not require a reload');
assert(html.includes("params.has('single-app')"), 'single-app mode should be forceable for testing');
assert(!/function detectSingleAppMode\(\)[\s\S]{0,400}if \(DEBUG_MODE\) return false;/.test(html),
  '?debug is when you most need the phone layout: it must not turn the zoom off');
assert(html.includes('body.single-app #taskbar { display: none; }'),
  'single-app mode should never show the taskbar');
assert(html.includes('body.single-app.app-running #desktop-icons { display: none; }'),
  'desktop icons should hide only while an app is running, so they come back on exit');
assert(html.includes('const MIN_BACKING_WIDTH = SINGLE_APP_MODE ? 400 : 640'),
  'a phone should report a phone-sized screen to the guest');
assert(html.includes('singleApp: () => SINGLE_APP_MODE'),
  'the shell should read the mode live, since a resize can change it');
// ?debug keeps the zoom, so the debug panels have to get out of the way once
// an app runs — but only then: the toolbar is the only launcher in debug mode.
assert(html.includes('body.single-app.app-running:not(.no-debug):not(.debug-open) #toolbar'),
  'a running app in debug mode should get the screen back from the toolbar');
assert(html.includes('body.single-app.app-running:not(.no-debug) #debug-peek'),
  'the collapsed debug panels need a way back');
assert(html.includes('function toggleDebugPanels()') && html.includes("classList.toggle('debug-open')"),
  'the peek button should toggle the panels');
assert(/function toggleDebugPanels\(\)[\s\S]{0,400}resizeCanvas\(\);/.test(html),
  'showing or hiding the panels changes how much screen is left: resize the canvas');
assert(html.includes("document.body.classList.toggle('app-running', !!running)"),
  'the page should track whether a guest is running');
assert(shellSource.includes('function clearUnownedDisplayMode()'),
  'a fresh launch should clear stale fullscreen/page state that no live app owns');
assert(shellSource.includes("document.body.classList.remove('exclusive-fullscreen', 'page-fullscreen')"),
  'stale display ownership must not make ordinary apps inherit a black fullscreen shell');

// --- The shell: one app, maximized when it can be ---
assert(shellSource.includes('if (SINGLE_APP() && runningApps.length)'),
  'single-app mode should refuse a second launch');
assert(shellSource.includes('sharedRenderer.singleAppMode = SINGLE_APP()'),
  'the renderer needs to know to zoom');
assert(shellSource.includes('const resizable = !!(style & (WS_MAXIMIZEBOX | WS_THICKFRAME))'),
  'only a window Windows would let you maximize should be maximized');
assert(shellSource.includes('e.send_message(win.hwnd | 0, 0x0112, 0xF030, 0)'),
  'maximizing should go through WM_SYSCOMMAND/SC_MAXIMIZE, not a renderer-side resize');

// --- The zoom itself ---
const { Win98Renderer } = require('../lib/renderer');

function makeRenderer(canvasW, canvasH, outputW, outputH) {
  const renderer = new Win98Renderer({
    width: canvasW,
    height: canvasH,
    getContext() { return {}; },
  });
  renderer.singleAppMode = true;
  renderer.presentationCanvas = { width: outputW, height: outputH };
  return renderer;
}

function win(x, y, w, h, extra) {
  return Object.assign({ hwnd: 0x10001, x, y, w, h, visible: true, className: 'app' }, extra);
}

// A fixed-size app (Minesweeper's board) on a 390x844 phone: cropped to the
// window and scaled to the full width, letterboxed top and bottom.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  const zoom = renderer._computeSingleAppZoom([win(0, 0, 320, 400)]);
  assert(zoom && zoom.viewport, 'a window smaller than the screen should be zoomed');
  const v = zoom.viewport;
  assert.deepStrictEqual(
    { cropX: v.cropX, cropY: v.cropY, cropW: v.cropW, cropH: v.cropH },
    { cropX: 0, cropY: 0, cropW: 320, cropH: 400 },
    'the crop should be the window rectangle on the desktop canvas');
  assert.strictEqual(v.dstW, 390, 'the zoom should fill the screen width');
  assert.strictEqual(v.dstH, 488, 'the zoom should keep the window aspect ratio');
  assert.strictEqual(v.dstX, 0, 'no horizontal letterbox when the width is filled');
  assert.strictEqual(v.dstY, 178, 'the window should be centred vertically');
  assert.strictEqual(v.background, '#008080',
    'a zoomed *windowed* app is still on the desktop: letterbox in desktop colour');

  // Input has to come back the same way it went out.
  renderer._exclusiveTransform = zoom.transform;
  renderer._exclusivePresentationViewport = v;
  assert.deepStrictEqual(renderer._mapExclusiveInputPoint(195, 422), { x: 160, y: 200 },
    'a tap in the middle of the screen should land in the middle of the window');
  assert.deepStrictEqual(renderer._mapExclusiveInputPoint(195, 10), { x: 160, y: 0 },
    'a tap in the letterbox should clamp to the nearest guest edge');
}

// A window the guest placed away from the origin keeps its position in the
// crop, so the zoom shows the window and not the desktop beside it.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  const v = renderer._computeSingleAppZoom([win(30, 50, 320, 400)]).viewport;
  assert.strictEqual(v.cropX, 30, 'crop should start at the window position');
  assert.strictEqual(v.cropY, 50, 'crop should start at the window position');
  assert.strictEqual(v.nativeX, 30, 'guest coordinates should be recovered from the crop origin');
}

// A maximized app already owns the screen: presenting it must stay a plain
// 1:1 blit, with no crop and no scaling stage at all.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  assert.strictEqual(renderer._computeSingleAppZoom([win(0, 0, 390, 844)]), null,
    'a full-screen window should not be zoomed');
}

// A dialog hanging off the side of its owner widens the crop instead of
// taking the screen for itself.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  const v = renderer._computeSingleAppZoom([
    win(0, 0, 320, 400),
    win(300, 380, 200, 150, { hwnd: 0x10002, isDialog: true }),
  ]).viewport;
  assert.strictEqual(v.cropW, 390, 'the crop should span both windows, clamped to the desktop');
  assert.strictEqual(v.cropH, 530, 'the crop should span both windows');
}

// A dropdown is painted onto the desktop canvas, not into the window's back
// canvas, so it has to widen the crop too — otherwise the menu is cut off at
// the window edge (Minesweeper's Game menu is wider than its board).
{
  const renderer = makeRenderer(390, 844, 390, 844);
  const exports = {
    menu_open_top: () => 0,
    menu_open_hover: () => -1,
    menu_open_x: () => -1,
    menu_open_y: () => -1,
    menu_bar_item_x: () => 0,
    menu_bar_screen_x: () => 81,
    menu_bar_screen_y: () => 58,
    menu_bar_screen_h: () => 18,
    menu_dropdown_height: () => 120,
  };
  const board = win(78, 40, 154, 235, { wasm: { exports } });
  renderer.windows[board.hwnd] = board;
  renderer._openMenuContext = () => ({ wasm: board.wasm, exports, hwnd: board.hwnd });
  const v = renderer._computeSingleAppZoom([board]).viewport;
  assert.strictEqual(v.cropX, 78, 'the crop should still start at the window');
  assert.strictEqual(v.cropW, 183, 'the crop should reach the right edge of the open dropdown');
  assert.strictEqual(v.cropH, 235, 'a dropdown inside the window height should not grow the crop');
}

// The desktop shell window is the background, not content: it must not pin the
// crop to the whole screen and cancel the zoom.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  const zoom = renderer._computeSingleAppZoom([
    win(0, 0, 390, 844, { hwnd: 0x10003, className: 'Progman' }),
    win(0, 0, 320, 400),
  ]);
  assert(zoom && zoom.viewport.cropW === 320, 'Progman should be excluded from the zoom rectangle');
}

// --- The touch-control bottom inset ---
//
// A square game on a tall phone was getting the dpad drawn on top of it while
// a third of the screen sat empty underneath. The inset reserves the band the
// overlay occupies; the picture moves up into the space instead.

// Enough letterbox to absorb the band: the picture keeps every pixel of its
// scale and is simply re-centred higher.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.touchOverlay = { getOccupiedFraction: () => 200 / 844 };
  const v = renderer._computeSingleAppZoom([win(0, 0, 320, 400)]).viewport;
  assert.strictEqual(v.dstW, 390, 'a game that fits above the band keeps its width');
  assert.strictEqual(v.dstH, 488, 'and every pixel of its scale');
  assert.strictEqual(v.bottomInset, 200, 'the band is reserved');
  assert.strictEqual(v.dstY, 78, 'the picture is centred in what is left, not on the screen');
  assert.ok(v.dstY + v.dstH <= 844 - 200,
    'and clears the band entirely — nothing to draw the dpad over');

  // Input still round-trips: the mapping reads the same viewport.
  renderer._exclusiveTransform = renderer._computeExclusiveTransform(
    { hwnd: 0, x: 0, y: 0, w: 320, h: 400 });
  renderer._exclusivePresentationViewport = v;
  assert.deepStrictEqual(renderer._mapExclusiveInputPoint(195, 78 + 244), { x: 160, y: 200 },
    'a tap in the middle of the moved picture still lands in the middle of the window');
}

// Not enough room to absorb it: the picture shrinks to fit above the band.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.touchOverlay = { getOccupiedFraction: () => 200 / 844 };
  const v = renderer._computeSingleAppZoom([win(0, 0, 320, 700)]).viewport;
  assert.strictEqual(v.dstH, 644, 'the picture is fitted into the height that is left');
  assert.strictEqual(v.dstW, 294, 'keeping its aspect ratio');
  assert.strictEqual(v.dstY, 0, 'and sits at the top of the remaining space');
}

// The floor: past 35% of the height, giving the game away costs more than the
// overlap does, so the reservation is capped and the overlay goes back over
// the picture. 0.35 * 844 = 295.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.touchOverlay = { getOccupiedFraction: () => 0.6 };
  const v = renderer._computeSingleAppZoom([win(0, 0, 320, 700)]).viewport;
  assert.strictEqual(v.bottomInset, 295, 'the inset is capped at 35% of the output height');
}

// An overlay that is down reserves nothing, and neither does an app that never
// declared one: every app on a phone would otherwise shrink for no reason.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.touchOverlay = { getOccupiedFraction: () => 0 };
  const v = renderer._computeSingleAppZoom([win(0, 0, 320, 400)]).viewport;
  assert.strictEqual(v.bottomInset, 0, 'a hidden overlay reserves nothing');
  assert.strictEqual(v.dstY, 178, 'and the picture stays centred on the screen');
}

// The exclusive-fullscreen path must not inherit any of this: a game that owns
// the display owns all of it.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.touchOverlay = { getOccupiedFraction: () => 0.3 };
  const v = renderer._computeExclusivePresentationViewport(
    renderer._computeExclusiveTransform({ hwnd: 1, x: 0, y: 0, w: 320, h: 400 }));
  assert.strictEqual(v.bottomInset, 0, 'fullscreen presentation reserves no band');
  assert.strictEqual(v.dstY, 178, 'and stays centred on the whole display');
}

// Fit/Fill is a presentation choice even for an exclusive DirectDraw game.
// Broken Sword owns a 640x480 display, so Fit keeps all of it; Fill on a
// portrait phone keeps the centre strip and maps taps through that crop.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  const game = win(10, 20, 640, 480);
  const fit = renderer._computeExclusiveView(game);
  assert.deepStrictEqual(
    { cropX: fit.viewport.cropX, cropY: fit.viewport.cropY,
      cropW: fit.viewport.cropW, cropH: fit.viewport.cropH },
    { cropX: 0, cropY: 0, cropW: 640, cropH: 480 },
    'Fit should present the complete exclusive display from its local origin');
  assert.strictEqual(fit.viewport.dstH, 293,
    'Fit should preserve 4:3 and letterbox it on a portrait phone');

  renderer.setViewMode('zoom');
  const fill = renderer._computeExclusiveView(game);
  assert.strictEqual(fill.viewport.dstW, 390, 'Fill should cover the output width');
  assert.strictEqual(fill.viewport.dstH, 844, 'Fill should cover the output height');
  assert.strictEqual(fill.viewport.cropW, 222,
    'Fill should retain only the source width matching the phone aspect');
  assert.strictEqual(fill.viewport.cropH, 480, 'the full source height should survive');
  assert.strictEqual(fill.viewport.cropX, 209,
    'the presentation crop is local to the exclusive window');
  assert.strictEqual(fill.transform.srcX, 219,
    'input coordinates retain the exclusive window screen origin');

  renderer._exclusiveTransform = fill.transform;
  renderer._exclusivePresentationViewport = fill.viewport;
  assert.deepStrictEqual(renderer._mapExclusiveInputPoint(195, 422), { x: 330, y: 260 },
    'the output centre should map to the centre of the cropped guest display');
}

// The presented rectangle the touch zones are laid out against follows the
// viewport, inset and all.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844,
  });
  renderer.presentationCanvas.getBoundingClientRect = () => ({
    left: 0, top: 20, right: 390, bottom: 864, width: 390, height: 844,
  });
  renderer.touchOverlay = { getOccupiedFraction: () => 200 / 844 };
  renderer._exclusivePresentationViewport =
    renderer._computeSingleAppZoom([win(0, 0, 320, 400)]).viewport;
  const r = renderer.getPresentedRectClient();
  assert.deepStrictEqual({ x: r.x, y: r.y, w: r.w, h: r.h },
    { x: 0, y: 98, w: 390, h: 488 },
    'the presented rect is the viewport in page coordinates');
}

// --- Fit vs zoom ---
//
// 'fit' shows the whole window letterboxed; 'zoom' fills the screen and crops.
// Both go through ONE presentation path -- zoom only chooses a different
// source rectangle -- so input mapping and the touch zones need to know
// nothing about modes.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  assert.strictEqual(renderer.viewMode, 'fit', 'apps start fitted: nothing is hidden');
  assert.strictEqual(renderer.setViewMode('zoom'), true, 'switching modes reports the change');
  assert.strictEqual(renderer.setViewMode('zoom'), false, 'and a no-op reports none');

  const v = renderer._computeSingleAppZoom([win(0, 0, 320, 400)]).viewport;
  assert.strictEqual(v.dstW, 390, 'zoom fills the width');
  assert.strictEqual(v.dstH, 844, 'and the height: nothing is letterboxed');
  // A 320x400 window on a 390x844 screen is far too wide to fill it, so what
  // gets cropped is the sides, not the top and bottom.
  assert.strictEqual(v.cropH, 400, 'the crop keeps the full height of the window');
  assert.strictEqual(v.cropW, 185, 'and only as much width as the screen aspect allows');
  assert.strictEqual(v.cropX, 68, 'taken from the middle of the window');
}

// A registry `mobileCrop` names the part of the window worth filling with --
// Space Cadet's table, not the score panel beside it.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.setViewMode('zoom');
  renderer.mobileCrop = { x: 0.2, y: 0.0, w: 0.5, h: 1.0 };
  // The window is wider than the desktop canvas, so the union rect is clamped
  // to 390 first and the crop fractions are taken of THAT.
  const v = renderer._computeSingleAppZoom([win(0, 0, 400, 400)]).viewport;
  assert.strictEqual(v.cropH, 400, 'the named crop is full height, so it stays full height');
  assert.strictEqual(v.cropW, 185, 'and is trimmed from half the width to the screen aspect');
  assert.strictEqual(v.cropX, 83,
    'starting inside the named crop (0.2 of 390 = 78) plus half the trim');

  // Input still round-trips through the same viewport in zoom mode.
  renderer._exclusiveTransform = renderer._computeExclusiveTransform(
    { hwnd: 0, x: v.cropX, y: v.cropY, w: v.cropW, h: v.cropH });
  renderer._exclusivePresentationViewport = v;
  const mid = renderer._mapExclusiveInputPoint(195, 422);
  assert.ok(Math.abs(mid.x - (v.cropX + v.cropW / 2)) <= 1 &&
            Math.abs(mid.y - (v.cropY + v.cropH / 2)) <= 1,
    'the middle of the screen is the middle of the crop');
}

// Fill is literal even with controls: it covers the whole output and lets the
// translucent overlay sit above the crop. Only Fit reserves clear space.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.setViewMode('zoom');
  renderer.touchOverlay = { getOccupiedFraction: () => 200 / 844 };
  const v = renderer._computeSingleAppZoom([win(0, 0, 320, 400)]).viewport;
  assert.strictEqual(v.bottomInset, 0, 'Fill does not shorten the output for controls');
  assert.strictEqual(v.dstW, 390, 'Fill covers the full output width');
  assert.strictEqual(v.dstH, 844, 'Fill covers the full output height');
  assert.strictEqual(v.dstY, 0, 'starting at the top');
}

// Without a presentation canvas (the CLI harness) there is nothing to crop
// against, so single-app mode must leave presentation alone.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.presentationCanvas = null;
  assert.strictEqual(renderer._computeSingleAppZoom([win(0, 0, 320, 400)]), null,
    'headless rendering should not enter the zoom path');
}

// A square board keeps its complete one-tile perimeter in either orientation.
for (const [width, height, area, side] of [
  [390, 664, { x: 0, y: 0, w: 1, h: 460 / 664 }, 390],
  [844, 390, { x: 204 / 844, y: 0, w: 436 / 844, h: 1 }, 390],
]) {
  const renderer = makeRenderer(844, 664, width, height);
  renderer.mobileCrop = { x: 3 / 282, y: 78 / 357, w: 276 / 282, h: 276 / 357, contain: true };
  renderer.touchOverlay = { getBoardArea: () => area };
  renderer.setViewMode('zoom');
  const v = renderer._computeSingleAppZoom([win(56, 108, 282, 357)]).viewport;
  assert.deepStrictEqual([v.cropX, v.cropY, v.cropW, v.cropH], [59, 186, 276, 276]);
  assert.deepStrictEqual([v.dstW, v.dstH], [side, side], 'board remains square with all wall pixels visible');
  assert(v.dstX >= Math.round(area.x * width));
  assert(v.dstY + v.dstH <= Math.round(area.h * height));
}

console.log('PASS  single-app mode: phone detection, chrome, and window zoom');

{
  const renderer = makeRenderer(844, 664, 390, 664);
  renderer.mobileCrop = { x: 3 / 282, y: 78 / 357, w: 276 / 282, h: 276 / 357, contain: true, portraitTrimX: 12 };
  renderer.touchOverlay = { getBoardArea: () => ({ x: 0, y: 0, w: 1, h: 460 / 664 }) };
  const windows = [win(56, 108, 282, 357)];
  renderer.setViewMode('zoom');
  const board = renderer._computeSingleAppZoom(windows).viewport;
  assert.deepStrictEqual([board.cropX, board.cropY, board.cropW, board.cropH], [71, 186, 252, 276]);
  renderer.setViewMode('fit');
  renderer.beginViewPinch();
  renderer.updateViewPinch(Math.sqrt(1.5));
  const middle = renderer._computeSingleAppZoom(windows).viewport;
  assert(middle.cropW > board.cropW && middle.cropW < 282, 'pinch produces an intermediate crop');
  renderer.updateViewPinch(1.4);
  renderer.endViewPinch();
  assert.strictEqual(renderer.viewMode, 'zoom', 'release snaps to the nearer board view');
  renderer.beginViewPinch();
  renderer.updateViewPinch(0.7);
  renderer.endViewPinch(true);
  assert.strictEqual(renderer.viewMode, 'zoom', 'cancel restores the starting view');
}
