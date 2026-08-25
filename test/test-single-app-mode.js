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

// Without a presentation canvas (the CLI harness) there is nothing to crop
// against, so single-app mode must leave presentation alone.
{
  const renderer = makeRenderer(390, 844, 390, 844);
  renderer.presentationCanvas = null;
  assert.strictEqual(renderer._computeSingleAppZoom([win(0, 0, 320, 400)]), null,
    'headless rendering should not enter the zoom path');
}

console.log('PASS  single-app mode: phone detection, chrome, and window zoom');
