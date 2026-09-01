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
  const relativeMoves = [];
  const renderer = {
    windows: {}, _mouseX: 400, _mouseY: 250,
    wantsRelativeMouse: () => true,
    _unmapExclusiveInputPoint: () => ({ x: 320, y: 200 }),
    handleMouseDown() {},
    handleMouseUp: (x, y, button) => releases.push({ x, y, button }),
    handleMouseMove() {}, handleMenuHover() {},
    handleRelativeMouseMove: (x, y) => relativeMoves.push({ x, y }),
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

  // Acquiring pointer lock can itself emit a synthetic movement event on
  // Safari and some Chromium versions. It must not move the guest software
  // cursor between the acquisition DOWN and its matching UP.
  canvas.onmousedown(event);
  global.document.pointerLockElement = canvas;
  documentListeners.get('pointerlockchange')();
  (listeners.get('mousemove') || []).at(-1)({
    ...event, buttons: 1, movementX: 13, movementY: -7,
  });
  assert.deepStrictEqual(relativeMoves, [],
    'pointer-lock acquisition movement should not displace a held click');
  (listeners.get('mouseup') || []).at(-1)({ ...event, clientX: 0, clientY: 0 });
  canvas.onmousemove({ ...event, movementX: 4, movementY: -2 });
  assert.deepStrictEqual(relativeMoves, [{ x: 4, y: -2 }],
    'relative movement should resume immediately after the acquisition click');

  // Pinch to switch presentation modes. A Win98 guest has no use for a second
  // finger, so a second concurrent canvas touch is unambiguously the page's --
  // and it must take the first finger's press with it, or the guest is left
  // with a button held down for the length of the gesture.
  const touchStart = canvasListeners.get('touchstart');
  assert(touchStart, 'the canvas should take touchstart');
  const modes = [];
  global.window.TouchControls = {
    installed: true,
    setViewMode: (mode) => modes.push(mode),
  };
  const tev = (touches, changed) => ({
    touches, changedTouches: changed || touches,
    preventDefault() {}, stopPropagation() {},
  });
  const finger = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });

  releases.length = 0;
  const f1 = finger(1, 100, 100);
  const f2 = finger(2, 140, 100);
  touchStart(tev([f1], [f1]));
  touchStart(tev([f1, f2], [f2]));
  assert.strictEqual(releases.length, 1,
    'the second finger retires the guest button the first one pressed');

  const pinchMoves = listeners.get('touchmove') || [];
  // Fingers apart past the threshold: fill the screen.
  pinchMoves.at(-1)(tev([f1, finger(2, 200, 100)]));
  assert.deepStrictEqual(modes, ['zoom'], 'pinching out switches to zoom');
  // And the rest of the gesture is inert: one flip per pinch.
  pinchMoves.at(-1)(tev([f1, finger(2, 300, 100)]));
  assert.deepStrictEqual(modes, ['zoom'], 'a wobbling pinch must not oscillate the mode');

  // No mouse leaks to the guest while the gesture owns the screen, including
  // the touch that starts after the pinch began.
  const beforeDown = releases.length;
  touchStart(tev([f1, finger(2, 300, 100), finger(3, 50, 50)], [finger(3, 50, 50)]));
  assert.strictEqual(releases.length, beforeDown,
    'a third finger during a pinch reaches the guest as nothing at all');

  // The gesture holds until every finger of it is off the glass.
  const pinchEnds = listeners.get('touchend') || [];
  pinchEnds.at(-1)(tev([f1], [finger(2, 300, 100)]));
  pinchEnds.at(-1)(tev([], [f1]));
  // A fresh single touch is an ordinary click again.
  const downs = [];
  renderer.handleMouseDown = (x, y, b) => downs.push([x, y, b]);
  touchStart(tev([finger(4, 100, 100)], [finger(4, 100, 100)]));
  assert.strictEqual(downs.length, 1,
    'once the pinch is over the canvas takes single touches as clicks again');
  delete global.window.TouchControls;

  // --- the manual keyboard -------------------------------------------------
  // Every fullscreen DirectDraw game that takes text -- Diablo II's character
  // name, StarCraft chat, a Half-Life console -- paints its own field and
  // never creates a Win32 caret, so the caret-driven keyboard above can never
  // fire for it. The on-screen pill calls these entry points instead, and the
  // characters have to come back out as a full keystroke: a soft keyboard
  // reports keyCode 229 on iOS, so WM_CHAR alone leaves a guest that reads
  // WM_KEYDOWN with nothing.
  {
    const proxyListeners = new Map();
    const proxy = {
      tagName: 'TEXTAREA', value: '',
      focus() { global.document.activeElement = proxy; },
      blur() {
        global.document.activeElement = canvas;
        const fn = proxyListeners.get('blur');
        if (fn) fn({ target: proxy });
      },
      addEventListener(type, fn) { proxyListeners.set(type, fn); },
    };
    global.document.getElementById = (id) =>
      (id === 'mobile-keyboard-proxy' ? proxy : null);
    delete require.cache[require.resolve('../lib/browser-input')];
    delete require.cache[require.resolve('../lib/mobile-keyboard')];
    global.window.MobileKeyboard = require('../lib/mobile-keyboard');
    const bi = require('../lib/browser-input');
    const seen = [];
    const kbRenderer = {
      windows: {},
      caretRect: () => null,          // the whole point: no caret, ever
      handleKeyDown: (vk) => seen.push(['down', vk]),
      handleKeyUp: (vk) => seen.push(['up', vk]),
      handleKeyPress: (c) => seen.push(['char', c]),
      handleMouseDown() {}, handleMouseUp() {}, handleMouseMove() {},
      handleMenuHover() {},
    };
    bi.wireCanvasInput(canvas, kbRenderer, { runningApps: [{ id: 'diablo2_demo' }] });

    assert.strictEqual(typeof global.window.__wineToggleKeyboard, 'function',
      'the page publishes a manual keyboard toggle for the overlay pill to call');
    assert.strictEqual(global.window.__wineKeyboardOpen(), false, 'closed to start with');
    assert.strictEqual(global.window.__wineToggleKeyboard(), true, 'one tap opens it');
    assert.strictEqual(global.document.activeElement, proxy,
      'which means focusing the hidden textarea -- the only thing iOS opens a keyboard for');
    // The resync runs twice a second and used to close it again immediately,
    // because there is no caret behind a game that draws its own field.
    global.window.__wineSetKeyboard(true);
    assert.strictEqual(global.document.activeElement, proxy,
      'and it survives the resync that has no caret to point at');

    // Typing. A soft keyboard delivers the character through `input`.
    proxy.value = 'Ab7,';
    proxyListeners.get('input')({ target: proxy });
    assert.deepStrictEqual(seen, [
      ['down', 0x41], ['char', 65], ['up', 0x41],
      ['down', 0x42], ['char', 98], ['up', 0x42],
      ['down', 0x37], ['char', 55], ['up', 0x37],
      ['char', 44],
    ], 'each character arrives as keydown + WM_CHAR + keyup, punctuation as WM_CHAR only');
    assert.strictEqual(proxy.value, '', 'and the proxy is emptied so the next key is not a repeat');

    assert.strictEqual(global.window.__wineToggleKeyboard(), false, 'a second tap closes it');
    assert.notStrictEqual(global.document.activeElement, proxy, 'and drops the focus with it');

    // iOS closes its own keyboard from the Done key; all the page sees is the
    // blur, and the flag has to follow or the resync puts it straight back up.
    global.window.__wineSetKeyboard(true);
    proxy.blur();
    assert.strictEqual(global.window.__wineKeyboardOpen(), false,
      'dismissing the keyboard from iOS clears the manual flag');
    delete global.window.MobileKeyboard;
  }
} finally {
  global.window = originalWindow;
  global.document = originalDocument;
  global.setInterval = originalSetInterval;
  global.clearInterval = originalClearInterval;
}

console.log('PASS  web canvas supports mobile touch input');
