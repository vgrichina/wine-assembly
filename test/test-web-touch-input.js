#!/usr/bin/env node
// Static browser-input coverage: mobile browsers must be able to drive the
// canvas through touch events without scrolling/zooming the page or relying on
// synthetic mouse compatibility events.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 760b79f moved the DOM input bridge out of the page template into
// lib/browser-input.js. Read both: the CSS that disables touch gestures is
// still page markup, the listeners are not.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8') +
  fs.readFileSync(path.join(__dirname, '..', 'lib', 'browser-input.js'), 'utf8');

assert(html.includes('touch-action: none'), 'canvas should disable browser touch gestures');
assert(html.includes('-webkit-user-select: none'), 'canvas should disable iOS text selection');
assert(html.includes('function eventPointFromClient(clientX, clientY)'), 'touch and mouse should share client-coordinate mapping');
assert(html.includes('return { x, y };'), 'browser events should pass backing-canvas coords to renderer handlers');
assert(!html.includes('return renderer.mapCanvasPoint ? renderer.mapCanvasPoint(x, y) : { x, y };'), 'exclusive fullscreen input should not be mapped twice');
assert(html.includes("canvas.addEventListener('touchstart'"), 'canvas should handle touchstart');
assert(html.includes("window.addEventListener('touchmove', windowTouchMove, { capture: true, passive: false })"), 'touchmove should be captured and non-passive');
assert(html.includes("window.addEventListener('touchend', windowTouchEnd, { capture: true, passive: false })"), 'touchend should be captured and non-passive');
assert(html.includes("window.addEventListener('touchcancel', windowTouchCancel, { capture: true, passive: false })"), 'touchcancel should be captured and non-passive');
assert(html.includes('renderer.handleMouseDown(cx, cy, 0)'), 'touchstart should map to left-button mouse down');
assert(html.includes('renderer.handleMouseMove(x, y)'), 'touchmove should map to mouse move');
assert(html.includes('renderer.handleMouseUp(p.x, p.y, 0)'), 'touchend/cancel should release left-button mouse up');
assert(html.includes('forwardEmptyDesktopClick(t.clientX, t.clientY, cx, cy)'), 'touch should launch desktop icons when tapping empty canvas overlay');
assert(html.includes("cv.addEventListener('touchstart'"), 'pre-launch canvas overlay should forward mobile taps to icons');
assert(html.includes('e.preventDefault();'), 'touch handlers should prevent browser scroll/zoom defaults');
assert(html.includes('name="viewport" content="width=device-width, initial-scale=1"'), 'mobile layout viewport should match the browser viewport');
assert(!html.includes('viewport-fit=cover'), 'page should not render under iOS safe-area browser chrome');
assert(!html.includes('MIN_VIEWPORT_WIDTH'), '640px minimum should apply to the emulated backing store, not the DOM layout viewport');
// A narrow *browser window* still emulates a 640px-wide screen. Only a phone,
// which runs single-app mode, reports a phone-sized screen instead — see
// test/test-single-app-mode.js.
assert(html.includes('const MIN_BACKING_WIDTH = SINGLE_APP_MODE ? 400 : 640'),
  'small screens should still get at least a 640px emulated backing width unless single-app mode');
assert(html.includes('displayW') && html.includes('displayH'), 'canvas backing size should be separate from CSS display size');
assert(html.includes('Math.max(1, MIN_BACKING_WIDTH / displayW)'), 'narrow viewports should scale backing height proportionally');
assert(html.includes("canvas.style.width = displayW + 'px'"), 'fullscreen CSS width should use physical display width, not minimum backing width');
assert(html.includes("desktopIcons.style.width = w + 'px'"), 'desktop icon overlay should use guest backing width');
assert(html.includes('desktopIcons.style.transform = `scale(${sx}, ${sy})`'), 'desktop icon overlay should scale with the canvas');
assert(html.includes("window.visualViewport.addEventListener('resize', resizeCanvas)"), 'mobile browser chrome viewport changes should resize the canvas');
assert(html.includes('requestAnimationFrame(resizeCanvas)'), 'desktop icon overlay should be scaled on initial paint');
assert(html.includes('@media (max-width: 760px)'), 'narrow browser layouts should have a responsive debug breakpoint');
assert(html.includes('body:not(.no-debug) #content { flex-direction: column; }'),
  'narrow debug mode should stack the runtime log below the emulator');
assert(html.includes('body:not(.no-debug) #screen-wrap'),
  'narrow debug mode should preserve a full-width emulator surface');
assert(html.includes('body:not(.no-debug) #log'),
  'narrow debug mode should size the log independently below the emulator');

// Pointer-locked mouseup may report clientX/clientY at zero. Exercise the
// actual DOM bridge and ensure it releases at the guest's virtual cursor,
// rather than feeding an outside-letterbox point that drops WM_LBUTTONUP.
const originalWindow = global.window;
const originalDocument = global.document;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const listeners = new Map();
const documentListeners = new Map();
const canvasListeners = new Map();
const canvas = {
  width: 640, height: 480, style: {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  focus() {}, setAttribute() {}, requestPointerLock() {},
  addEventListener(type, fn) { canvasListeners.set(type, fn); },
};
global.window = {
  addEventListener(type, fn) {
    const entries = listeners.get(type) || [];
    entries.push(fn);
    listeners.set(type, entries);
  },
  removeEventListener(type, fn) {
    listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== fn));
  },
};
global.document = {
  pointerLockElement: canvas,
  activeElement: canvas,
  getElementById: () => null,
  querySelectorAll: () => [],
  elementFromPoint: () => null,
  visibilityState: 'visible',
  addEventListener(type, fn) { documentListeners.set(type, fn); },
};
global.setInterval = () => 1;
global.clearInterval = () => {};
try {
  delete require.cache[require.resolve('../lib/browser-input')];
  const browserInput = require('../lib/browser-input');
  const releases = [];
  const renderer = {
    windows: {}, _mouseX: 400, _mouseY: 250,
    wantsRelativeMouse: () => true,
    _unmapExclusiveInputPoint: () => ({ x: 320, y: 200 }),
    handleMouseDown() {},
    handleMouseUp: (x, y, button) => releases.push({ x, y, button }),
    handleMouseMove() {}, handleMenuHover() {},
  };
  browserInput.wireCanvasInput(canvas, renderer, { runningApps: [], debugMode: true });
  const event = {
    clientX: 320, clientY: 240, button: 0, ctrlKey: false, shiftKey: false,
    preventDefault() {}, stopPropagation() {},
  };
  canvas.onmousedown(event);
  const mouseups = listeners.get('mouseup') || [];
  assert(mouseups.length, 'mousedown should install window mouseup capture');
  mouseups.at(-1)({ ...event, clientX: 0, clientY: 0 });
  assert.deepStrictEqual(releases, [{ x: 320, y: 200, button: 0 }],
    'pointer-lock release should use the current guest cursor, not unusable DOM coordinates');

  canvas.onmousedown(event);
  const mousemoves = listeners.get('mousemove') || [];
  mousemoves.at(-1)({ ...event, buttons: 0, clientX: 0, clientY: 0 });
  assert.deepStrictEqual(releases.at(-1), { x: 320, y: 200, button: 0 },
    'a pointer-lock move with no physical buttons should recover a missing mouseup');

  canvas.onmousedown(event);
  global.document.pointerLockElement = null;
  documentListeners.get('pointerlockchange')();
  assert.deepStrictEqual(releases.at(-1), { x: 320, y: 200, button: 0 },
    'losing pointer lock should release any guest button still held');
} finally {
  global.window = originalWindow;
  global.document = originalDocument;
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
}

console.log('PASS  web canvas supports mobile touch input');
