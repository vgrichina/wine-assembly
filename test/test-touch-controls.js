#!/usr/bin/env node
// The on-screen touch controls overlay (lib/touch-controls.js) is the only way
// a phone can press a key, so what is checked here is the key pairing itself:
// a press produces exactly one keydown and its release exactly one keyup, two
// fingers hold two keys independently, a thumb sliding across the dpad swaps
// which arrow is held without ever leaving both down, and teardown puts every
// held key up and unhooks every listener.
//
// It runs against a minimal fake DOM rather than a headless browser because
// the property under test is bookkeeping, not layout: which vk is down after
// which sequence of TouchEvents.

'use strict';

const assert = require('assert');

// --- minimal DOM ------------------------------------------------------------

let liveListeners = 0;

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    className: '',
    _classes: new Set(),
    _handlers: new Map(),
    classList: {
      add: (n) => el._classes.add(n),
      remove: (n) => el._classes.delete(n),
      contains: (n) => el._classes.has(n),
    },
    setAttribute() {},
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) {
      if (!el._handlers.has(type)) el._handlers.set(type, []);
      el._handlers.get(type).push(fn);
      liveListeners++;
    },
    removeEventListener(type, fn) {
      const list = el._handlers.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) { list.splice(i, 1); liveListeners--; }
    },
    // The dpad reads its own centre out of layout, so a rect is mandatory.
    getBoundingClientRect: () => el._rect || { left: 0, top: 0, width: 0, height: 0 },
    dispatch(type, event) {
      for (const fn of (el._handlers.get(type) || []).slice()) fn(event);
    },
    get firstChild() { return el.children[0] || null; },
  };
  return el;
}

const body = makeEl('body');
const head = makeEl('head');
const wrap = makeEl('div');

global.document = {
  head,
  body,
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => (id === 'screen-wrap' ? wrap : null),
};
global.window = { addEventListener() {}, removeEventListener() {}, innerHeight: 844 };
global.location = { search: '' };

const touchEvent = (changed, active = changed) => ({
  changedTouches: changed,
  touches: active,
  preventDefault() {},
  stopPropagation() {},
});
const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });

// --- the module under test --------------------------------------------------

const TouchControls = require('../lib/touch-controls');

const keys = [];
const renderer = {
  handleKeyDown: (vk) => keys.push(['down', vk]),
  handleKeyUp: (vk) => keys.push(['up', vk]),
};

const LAYOUT = {
  dpad: { pos: 'bl' },
  buttons: [
    { vk: 0x5A, label: 'Z', pos: 'bl' },      // left flipper
    { vk: 0xBF, label: '/', pos: 'br' },      // right flipper
    { vk: 0x71, label: 'F2', pos: 'tr', hold: false },
  ],
};

TouchControls.install({ document: global.document, renderer });
assert.ok(TouchControls.installed, 'overlay installs against the fake document');
assert.strictEqual(wrap.children.length, 1, 'overlay mounts inside #screen-wrap');
assert.strictEqual(TouchControls.el.style.pointerEvents, undefined,
  'the container takes its pointer-events from the stylesheet, not an inline override');

TouchControls.setLayout(LAYOUT);

// Collect the widgets by walking what was built, the way a finger finds them.
const flat = [];
(function walk(node) {
  for (const child of node.children) { flat.push(child); walk(child); }
})(TouchControls.el);
const buttons = flat.filter(el => el.className === 'tc-btn');
const dpad = flat.find(el => el.className === 'tc-dpad');
assert.strictEqual(buttons.length, 3, 'three buttons rendered');
assert.ok(dpad, 'dpad rendered');
const [btnZ, btnSlash, btnF2] = buttons;
dpad._rect = { left: 100, top: 300, width: 132, height: 132 };

// 1. One press, one matching release.
keys.length = 0;
btnZ.dispatch('touchstart', touchEvent([touch(1, 0, 0)]));
assert.deepStrictEqual(keys, [['down', 0x5A]], 'touchstart presses the button vk once');
assert.ok(btnZ.classList.contains('tc-down'), 'a held button shows its pressed state');
btnZ.dispatch('touchend', touchEvent([touch(1, 0, 0)]));
assert.deepStrictEqual(keys, [['down', 0x5A], ['up', 0x5A]],
  'touchend releases the same vk exactly once');
assert.ok(!btnZ.classList.contains('tc-down'), 'the pressed state clears on release');

// 2. Two fingers hold two flippers; releasing one leaves the other down.
keys.length = 0;
btnZ.dispatch('touchstart', touchEvent([touch(10, 0, 0)]));
btnSlash.dispatch('touchstart', touchEvent([touch(11, 0, 0)]));
assert.deepStrictEqual(keys, [['down', 0x5A], ['down', 0xBF]],
  'simultaneous touches hold both flipper keys');
btnZ.dispatch('touchend', touchEvent([touch(10, 0, 0)]));
assert.deepStrictEqual(keys.slice(2), [['up', 0x5A]],
  'releasing one finger must not release the other flipper');
assert.ok(btnSlash.classList.contains('tc-down'), 'the still-held flipper stays down');
btnSlash.dispatch('touchcancel', touchEvent([touch(11, 0, 0)]));
assert.deepStrictEqual(keys.slice(3), [['up', 0xBF]],
  'touchcancel releases the key too — iOS cancels touches on its own');

// 3. hold:false is a tap: down and up inside touchstart.
keys.length = 0;
btnF2.dispatch('touchstart', touchEvent([touch(20, 0, 0)]));
assert.deepStrictEqual(keys, [['down', 0x71], ['up', 0x71]],
  'a hold:false button fires a complete keystroke on press');
btnF2.dispatch('touchend', touchEvent([touch(20, 0, 0)]));
assert.deepStrictEqual(keys.length, 2, 'releasing a hold:false button emits nothing further');

// 4. The dpad swaps the held arrow as the thumb moves. Centre is (166, 366).
const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
keys.length = 0;
dpad.dispatch('touchstart', touchEvent([touch(30, 166 + 50, 366)]));
assert.deepStrictEqual(keys, [['down', VK_RIGHT]], 'thumb right of centre holds RIGHT');
dpad.dispatch('touchmove', touchEvent([touch(30, 166, 366 - 50)]));
assert.deepStrictEqual(keys.slice(1), [['up', VK_RIGHT], ['down', VK_UP]],
  'sliding to the top of the pad releases RIGHT and holds UP');
dpad.dispatch('touchmove', touchEvent([touch(30, 166 - 50, 366 - 50)]));
assert.deepStrictEqual(keys.slice(3), [['down', VK_LEFT]],
  'a diagonal adds the second arrow and keeps the first');
dpad.dispatch('touchmove', touchEvent([touch(30, 166 + 2, 366 + 2)]));
assert.deepStrictEqual(keys.slice(4).sort(), [['up', VK_LEFT], ['up', VK_UP]].sort(),
  'inside the dead zone the pad holds nothing');
dpad.dispatch('touchmove', touchEvent([touch(30, 166, 366 + 50)]));
dpad.dispatch('touchend', touchEvent([touch(30, 166, 366 + 50)]));
assert.deepStrictEqual(keys.slice(6), [['down', VK_DOWN], ['up', VK_DOWN]],
  'lifting the thumb releases the direction it was holding');

// A touch that started on the dpad but whose identifier is unknown to it must
// be ignored rather than releasing somebody else's key.
keys.length = 0;
dpad.dispatch('touchend', touchEvent([touch(999, 0, 0)]));
assert.deepStrictEqual(keys, [], 'an unknown touch identifier changes nothing');

// 5. Teardown: every held key goes up and every listener comes off.
keys.length = 0;
btnZ.dispatch('touchstart', touchEvent([touch(40, 0, 0)]));
dpad.dispatch('touchstart', touchEvent([touch(41, 166 + 60, 366)]));
assert.deepStrictEqual(keys, [['down', 0x5A], ['down', VK_RIGHT]],
  'two widgets holding keys at teardown time');
TouchControls.destroy();
assert.deepStrictEqual(keys.slice(2).map(k => k[0]), ['up', 'up'],
  'destroy releases every key still held');
assert.strictEqual(liveListeners, 0, 'destroy removes every listener it added');
assert.strictEqual(wrap.children.length, 0, 'destroy removes the overlay from the DOM');
assert.strictEqual(TouchControls.installed, false, 'destroy marks the overlay uninstalled');

// 6. sync() picks the newest running app that declares a layout, and takes the
//    overlay down when no such app is left.
TouchControls.install({ document: global.document, renderer });
TouchControls.sync([{ name: 'notepad' }, { name: 'pinball', touchControls: LAYOUT }], renderer);
assert.strictEqual(TouchControls.layout, LAYOUT, 'sync adopts the running app layout');
assert.strictEqual(TouchControls.el.style.display, 'block', 'a layout shows the overlay');
// A running app with no declared layout keeps the bare chrome (the keyboard
// pill) but no game controls, so isVisible() -- which the renderer's inset and
// the cursor policy both read as "the game controls are up" -- goes false.
TouchControls.sync([{ name: 'notepad' }], renderer);
assert.notStrictEqual(TouchControls.layout, LAYOUT, 'sync drops the layout when the app closes');
assert.strictEqual(TouchControls.layout.chrome, true, 'and falls back to the bare chrome');
assert.strictEqual(TouchControls.isVisible(), false, 'which is not "game controls up"');
// And with nothing running at all, the overlay goes away entirely.
TouchControls.sync([], renderer);
assert.strictEqual(TouchControls.layout, null, 'no app, no layout');
assert.strictEqual(TouchControls.el.style.display, 'none', 'no layout hides the overlay');
assert.strictEqual(TouchControls.isVisible(), false, 'a hidden overlay is not visible');
TouchControls.destroy();

// 7. The bottom band the renderer reserves. lib/renderer.js pushes the game up
//    by exactly this much, so 0 when there is nothing there is load-bearing:
//    a nonzero reading with the overlay down would shrink every app on a phone.
TouchControls.install({ document: global.document, renderer });
assert.strictEqual(TouchControls.getOccupiedHeight(), 0,
  'no layout means no reserved band');
assert.strictEqual(TouchControls.getOccupiedFraction(), 0,
  'no layout means no reserved fraction');

TouchControls.setLayout({
  dpad: { pos: 'bl', ways: 4 },
  buttons: [{ vk: 0x71, label: 'New game', pos: 'br' }],
});
assert.strictEqual(TouchControls.isVisible(), true, 'a layout shows the overlay');
const bandEstimated = TouchControls.getOccupiedHeight();
// The fake DOM reports no layout, so this is the estimate path: the 140px pad
// plus the 18px bottom padding, and the 58px button in the other corner loses.
assert.strictEqual(bandEstimated, 158,
  'the band is the tallest bottom-corner stack plus its padding');
assert.ok(Math.abs(TouchControls.getOccupiedFraction() - 158 / 844) < 1e-9,
  'the fraction is the band over the overlay height');

// With real rects it measures instead of estimating, and a top-corner widget
// never contributes: it is not in the way of anything below.
TouchControls.el.getBoundingClientRect = () => ({
  left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844,
});
for (const el of TouchControls._widgets) {
  el.getBoundingClientRect = () => ({
    left: 0, top: 700, right: 140, bottom: 840, width: 140, height: 140,
  });
}
assert.strictEqual(TouchControls.getOccupiedHeight(), 144,
  'with layout available the band is measured from the topmost bottom widget');
TouchControls.setLayout({ buttons: [{ vk: 0x71, label: 'New game', pos: 'tl' }] });
assert.strictEqual(TouchControls.getOccupiedHeight(), 0,
  'a top-corner button reserves nothing at the bottom');
TouchControls.destroy();

// 8. In-place zones: pinball's flippers ARE the bottom of the table.
{
  TouchControls.install({ document: global.document, renderer });
  // The overlay box is the page; the app is presented into part of it.
  TouchControls.el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844,
  });
  let presented = { x: 0, y: 100, w: 390, h: 500 };
  renderer.getPresentedRectClient = () => presented;

  const ZONES = {
    zones: [
      { vk: 0x5A, title: 'Left flipper', rect: { x: 0, y: 0.14, w: 0.5, h: 0.86 } },
      { vk: 0xBF, title: 'Right flipper', rect: { x: 0.5, y: 0.14, w: 0.36, h: 0.86 } },
      { vk: 0x20, title: 'Plunger', rect: { x: 0.86, y: 0.14, w: 0.14, h: 0.86 } },
    ],
    buttons: [{ vk: 0x58, label: 'Nudge', pos: 'bl' }],
  };
  TouchControls.setLayout(ZONES);
  const zones = TouchControls._zones;
  assert.strictEqual(zones.length, 3, 'three zones rendered');
  const px = (v) => parseFloat(v);
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.01, what + ' (' + a + ' vs ' + b + ')');
  near(px(zones[0].style.left), 0, 'the left flipper starts at the app edge');
  near(px(zones[0].style.top), 170, 'a zone is positioned against the PRESENTED rect, not the page');
  near(px(zones[0].style.width), 195, 'the left flipper is half the table');
  near(px(zones[0].style.height), 430, 'and reaches the bottom of it');
  near(px(zones[2].style.left), 335.4, 'the plunger strip hugs the right edge');

  // Both flippers held at once, tracked by identifier like every other widget.
  keys.length = 0;
  zones[0].dispatch('touchstart', touchEvent([touch(50, 10, 400)]));
  zones[1].dispatch('touchstart', touchEvent([touch(51, 300, 400)]));
  assert.deepStrictEqual(keys, [['down', 0x5A], ['down', 0xBF]],
    'two zones held together hold both flippers');
  assert.ok(zones[0]._classes.has('tc-down'), 'a held zone shows its highlight');
  zones[0].dispatch('touchend', touchEvent([touch(50, 10, 400)]));
  assert.deepStrictEqual(keys.slice(2), [['up', 0x5A]],
    'releasing one flipper leaves the other down');
  zones[1].dispatch('touchcancel', touchEvent([touch(51, 300, 400)]));
  assert.deepStrictEqual(keys.slice(3), [['up', 0xBF]],
    'touchcancel releases a zone key too');
  assert.ok(!zones[1]._classes.has('tc-down'), 'the highlight clears on release');

  // A touch the zone never saw is not its business: the game keeps it.
  keys.length = 0;
  zones[0].dispatch('touchend', touchEvent([touch(999, 0, 0)]));
  assert.deepStrictEqual(keys, [], 'an unknown identifier changes nothing');

  // The zoom moved (the bottom inset appeared, or the guest resized): the
  // zones follow the picture rather than staying where they were drawn.
  presented = { x: 40, y: 0, w: 310, h: 400 };
  TouchControls.layoutZones();
  near(px(zones[0].style.left), 40, 'zones follow the presented rect');
  near(px(zones[0].style.top), 56, 'and follow it vertically after an inset changes the fit');
  near(px(zones[0].style.width), 155, 'and rescale with it');

  TouchControls.destroy();
}

// 9. A command button posts WM_COMMAND instead of a key, for a game whose
//    new-game action is a menu item.
{
  const posted = [];
  const win = {
    hwnd: 0x20001, visible: true, isChild: false, zOrder: 5,
    wasm: { exports: { post_message_q: (...a) => posted.push(a) } },
  };
  const cmdRenderer = {
    handleKeyDown() { assert.fail('a command button must not press a key'); },
    handleKeyUp() {},
    windows: { [win.hwnd]: win },
  };
  TouchControls.install({ document: global.document, renderer: cmdRenderer });
  TouchControls.setLayout({ buttons: [{ command: 40001, label: 'Start', pos: 'tl' }] });
  const btn = TouchControls._widgets.find(el => el.className === 'tc-btn');
  btn.dispatch('touchstart', touchEvent([touch(60, 0, 0)]));
  assert.deepStrictEqual(posted, [[0x20001, 0x0111, 40001, 0]],
    'a command button posts WM_COMMAND to the topmost top-level window');
  btn.dispatch('touchend', touchEvent([touch(60, 0, 0)]));
  assert.strictEqual(posted.length, 1, 'releasing it posts nothing further');
  TouchControls.destroy();
}

// 10. The discrete cross pad. A tile game moves one square per KEYSTROKE, so
//     the control has to produce keystrokes -- the continuous pad holds a key
//     and gives such a game exactly one step however long you lean on it.
{
  TouchControls.install({ document: global.document, renderer });
  TouchControls.setLayout({ dpad: { pos: 'bl', ways: 4, style: 'cross' } });
  const pad = TouchControls._widgets.find(el => el.className === 'tc-cross');
  assert.ok(pad, 'a cross-style dpad renders a cross, not the round pad');
  const arrows = pad.children.slice();
  assert.strictEqual(arrows.length, 4, 'the cross pad has four arrows');
  const right = arrows.find(el => el.className.indexOf('tc-right') >= 0);

  // A tap is one complete keystroke, not a held key.
  keys.length = 0;
  right.dispatch('touchstart', touchEvent([touch(70, 0, 0)]));
  assert.deepStrictEqual(keys, [['down', VK_RIGHT], ['up', VK_RIGHT]],
    'a tap on an arrow is one complete keystroke');
  right.dispatch('touchend', touchEvent([touch(70, 0, 0)]));
  assert.strictEqual(keys.length, 2, 'and lifting the finger adds nothing');

  // A hold auto-repeats the way a physical keyboard does.
  keys.length = 0;
  right.dispatch('touchstart', touchEvent([touch(71, 0, 0)]));
  assert.strictEqual(keys.length, 2, 'the hold starts with its first keystroke');
  const entry = TouchControls._touches.get(71);
  assert.ok(entry && entry.repeatTimer, 'a hold arms the repeat delay');
  // Drive the timers rather than waiting on them: the property under test is
  // that a repeat is armed and that releasing disarms it.
  TouchControls._pulse(VK_RIGHT);
  TouchControls._pulse(VK_RIGHT);
  assert.strictEqual(keys.length, 6, 'each repeat is a further complete keystroke');
  right.dispatch('touchend', touchEvent([touch(71, 0, 0)]));
  assert.ok(!entry.repeatTimer && !entry.repeatInterval,
    'releasing disarms the repeat -- a stuck repeat would walk the board on its own');
  TouchControls.destroy();
}

// 11. Swipes on the playing field: over the threshold it is a direction and
//     the guest sees no mouse at all; under it, it is still a tap and the
//     guest gets the click, or the menus stop working.
{
  const mouse = [];
  const swipeRenderer = {
    handleKeyDown: (vk) => keys.push(['down', vk]),
    handleKeyUp: (vk) => keys.push(['up', vk]),
    handleMouseDown: (x, y, b) => mouse.push(['down', Math.round(x), Math.round(y), b]),
    handleMouseUp: (x, y, b) => mouse.push(['up', Math.round(x), Math.round(y), b]),
    canvas: {
      width: 640, height: 480,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    },
    getPresentedRectClient: () => ({ x: 0, y: 0, w: 320, h: 240 }),
  };
  TouchControls.install({ document: global.document, renderer: swipeRenderer });
  TouchControls.el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240,
  });
  TouchControls.setLayout({ swipes: true });
  const field = TouchControls._widgets.find(el => el.className === 'tc-swipe');
  assert.ok(field, 'the swipe field is rendered');
  assert.strictEqual(field.style.width, '320px',
    'and covers the presented app rectangle');

  keys.length = 0;
  mouse.length = 0;
  field.dispatch('touchstart', touchEvent([touch(80, 100, 100)]));
  field.dispatch('touchmove', touchEvent([touch(80, 100, 145)]));
  assert.deepStrictEqual(keys, [['down', VK_DOWN], ['up', VK_DOWN]],
    'a downward flick is one keystroke in that direction');
  field.dispatch('touchmove', touchEvent([touch(80, 100, 200)]));
  assert.strictEqual(keys.length, 2, 'one flick is one keystroke, however far it runs on');
  field.dispatch('touchend', touchEvent([touch(80, 100, 200)]));
  assert.deepStrictEqual(mouse, [],
    'a consumed swipe must not also click -- that would drag across the board');

  keys.length = 0;
  mouse.length = 0;
  field.dispatch('touchstart', touchEvent([touch(81, 100, 100)]));
  field.dispatch('touchmove', touchEvent([touch(81, 104, 103)]));
  field.dispatch('touchend', touchEvent([touch(81, 104, 103)]));
  assert.deepStrictEqual(keys, [], 'a short move is not a swipe');
  assert.deepStrictEqual(mouse, [['down', 208, 206, 0], ['up', 208, 206, 0]],
    'and reaches the guest as a click in canvas coordinates, so menus still work');

  // The swipe field, not the canvas, owns these touches in Rodent. Its second
  // finger must therefore expose the same Fit/Fill and wheel gestures.
  let mode = 'fit';
  const wheel = [];
  swipeRenderer.viewMode = mode;
  swipeRenderer.setViewMode = next => {
    mode = next;
    swipeRenderer.viewMode = next;
    return true;
  };
  swipeRenderer.handleWheel = (x, y, delta) =>
    wheel.push([Math.round(x), Math.round(y), delta]);
  mouse.length = 0;
  field.dispatch('touchstart', touchEvent([touch(82, 100, 100)], [touch(82, 100, 100)]));
  field.dispatch('touchstart', touchEvent([touch(83, 200, 100)],
    [touch(82, 100, 100), touch(83, 200, 100)]));
  field.dispatch('touchmove', touchEvent([touch(82, 70, 100), touch(83, 230, 100)],
    [touch(82, 70, 100), touch(83, 230, 100)]));
  assert.strictEqual(mode, 'zoom', 'spreading two fingers over a swipe field selects Fill');
  field.dispatch('touchend', touchEvent([touch(82, 70, 100)], [touch(83, 230, 100)]));
  field.dispatch('touchend', touchEvent([touch(83, 230, 100)], []));
  assert.deepStrictEqual(mouse, [], 'a field pinch never leaks a guest click');

  field.dispatch('touchstart', touchEvent([touch(84, 100, 100)], [touch(84, 100, 100)]));
  field.dispatch('touchstart', touchEvent([touch(85, 200, 100)],
    [touch(84, 100, 100), touch(85, 200, 100)]));
  field.dispatch('touchmove', touchEvent([touch(84, 100, 130), touch(85, 200, 130)],
    [touch(84, 100, 130), touch(85, 200, 130)]));
  assert.deepStrictEqual(wheel, [[300, 260, 1]],
    'parallel two-finger travel over a swipe field becomes mouse wheel input');
  field.dispatch('touchend', touchEvent([touch(84, 100, 130), touch(85, 200, 130)], []));
  TouchControls.destroy();
}

// 12. The view-mode toggle. The pinch that switches modes is invisible, so the
//     button is what makes the feature findable at all.
{
  let mode = 'fit';
  const modeRenderer = {
    handleKeyDown() {}, handleKeyUp() {},
    get viewMode() { return mode; },
    setViewMode(next) {
      const want = next === 'zoom' ? 'zoom' : 'fit';
      if (want === mode) return false;
      mode = want;
      return true;
    },
  };
  TouchControls.install({ document: global.document, renderer: modeRenderer });
  TouchControls.setLayout({ buttons: [{ vk: 0x71, label: 'New game', pos: 'tl' }] });
  const toggle = TouchControls._widgets.find(el => el.className === 'tc-mode');
  assert.ok(toggle, 'the overlay carries a view-mode toggle');
  assert.strictEqual(toggle.textContent, 'Fill',
    'the label names what a press does, not the mode you are in');
  toggle.dispatch('touchstart', touchEvent([touch(90, 0, 0)]));
  assert.strictEqual(mode, 'zoom', 'a press switches the renderer to zoom');
  assert.strictEqual(toggle.textContent, 'Fit', 'and the label flips with it');
  toggle.dispatch('touchend', touchEvent([touch(90, 0, 0)]));
  toggle.dispatch('touchstart', touchEvent([touch(91, 0, 0)]));
  assert.strictEqual(mode, 'fit', 'and a second press switches back');
  TouchControls.destroy();
}

// 13. Where the toggle goes, and what a guest text field does to the layer.
{
  let caret = null;
  const layoutRenderer = {
    handleKeyDown() {}, handleKeyUp() {},
    viewMode: 'fit',
    setViewMode() { return false; },
    caretRect: () => caret,
    getPresentedRectClient: () => ({ x: 0, y: 6, w: 390, h: 494 }),
  };
  TouchControls.install({ document: global.document, renderer: layoutRenderer });
  TouchControls.el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 390, bottom: 664, width: 390, height: 664,
  });
  TouchControls.setLayout({ dpad: { pos: 'bl', style: 'cross' }, swipes: true });
  const toggle = TouchControls._widgets.find(el => el.className === 'tc-mode');
  const keyPill = TouchControls._widgets.find(el => el.className === 'tc-key');
  assert.ok(keyPill, 'the keyboard pill rides along with the view toggle');

  // The letterbox is the one part of the screen nothing else can ever occupy,
  // and the middle of it is clear of both corner clusters.
  // Give the two bottom clusters real rects, so the gap between them is a
  // real measurement rather than the middle of an empty bar.
  for (const w of TouchControls._widgets) {
    if (w._tcCorner === 'bl') {
      w.getBoundingClientRect = () => ({ left: 18, right: 186, top: 506, bottom: 646, width: 168, height: 140 });
    }
  }
  TouchControls.layoutZones();
  // Only a left cluster here, so the gap is everything right of the pad.
  // Two pills share that gap: 40px each with a 10px gap = a 90px span centred
  // in the 204px opening, so the keyboard pill leads at 243 and the view
  // toggle follows at 293. The point of the assertion is that they do not
  // land on the same pixel, which two independent centring placers would.
  assert.strictEqual(keyPill.style.left, '243px',
    'the pills sit in the gap beside the corner cluster, not on top of it');
  assert.strictEqual(toggle.style.left, '293px', 'and beside each other, not on top');
  assert.strictEqual(toggle.style.top, '562px', 'inside the bigger of the two bars');
  assert.strictEqual(keyPill.style.top, '562px', 'both in the same bar');
  assert.strictEqual(toggle.style.opacity, '1', 'and is legible while it is in dead space');
  assert.notStrictEqual(keyPill.style.left, toggle.style.left, 'never stacked on each other');

  // If only one pill fits beside the bottom controls, use the other dead band
  // for the second one instead of falling back over the game content.
  for (const w of TouchControls._widgets) {
    if (w._tcCorner === 'bl') {
      w.getBoundingClientRect = () => ({ left: 18, right: 310, top: 506, bottom: 646, width: 292, height: 140 });
    }
  }
  layoutRenderer.getPresentedRectClient = () => ({ x: 0, y: 80, w: 390, h: 420 });
  TouchControls.layoutZones();
  assert.strictEqual(keyPill.style.top, '562px', 'one pill uses the narrow bottom opening');
  assert.strictEqual(toggle.style.top, '20px', 'the remaining pill uses the empty top band');
  assert.strictEqual(toggle.style.opacity, '1', 'and never falls back translucent over content');

  // Filling the screen leaves no dead space: it gets a corner and goes quiet
  // rather than taking room from the picture.
  layoutRenderer.getPresentedRectClient = () => ({ x: 0, y: 0, w: 390, h: 664 });
  TouchControls.layoutZones();
  assert.strictEqual(toggle.style.left, '8px', 'with no letterbox it retreats to the edge');
  assert.strictEqual(keyPill.style.left, '8px', 'so does the keyboard pill');
  assert.strictEqual(keyPill.style.top, '287px', 'stacked at the edge, not overlapping');
  assert.strictEqual(toggle.style.top, '337px', 'one pill height plus the gap below it');
  assert.strictEqual(toggle.style.opacity, '0.35', 'and stops competing with the game');

  // A caret in the guest means a text field is focused. The swipe field must
  // stop taking touches or the tap that puts the caret in the NEXT field --
  // and the gesture iOS needs to open its keyboard -- never lands.
  const field = TouchControls._widgets.find(el => el.className === 'tc-swipe');
  assert.strictEqual(field.style.pointerEvents, 'auto', 'the field takes touches normally');
  caret = { x: 10, y: 10, w: 1, h: 12 };
  TouchControls.layoutZones();
  assert.strictEqual(field.style.pointerEvents, 'none',
    'a focused guest text field beats every gesture on this layer');
  caret = null;
  TouchControls.layoutZones();
  assert.strictEqual(field.style.pointerEvents, 'auto', 'and it comes back when the caret goes');
  TouchControls.destroy();
}

// 13b. Safari keeps the running page at 100vh while its visible viewport is
// shorter. Bottom controls follow the visible edge, and the reported occupied
// band includes the obscured toolbar so the guest is kept above both.
{
  const viewportHandlers = new Map();
  global.window.visualViewport = {
    height: 700, offsetTop: 0,
    addEventListener(type, fn) { viewportHandlers.set(type, fn); },
    removeEventListener(type, fn) {
      if (viewportHandlers.get(type) === fn) viewportHandlers.delete(type);
    },
  };
  const layoutRenderer = {
    handleKeyDown() {}, handleKeyUp() {}, viewMode: 'fit',
    setViewMode() { return false; }, caretRect: () => null,
    getPresentedRectClient: () => ({ x: 0, y: 80, w: 390, h: 480 }),
  };
  TouchControls.install({ document: global.document, renderer: layoutRenderer });
  TouchControls.el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844,
  });
  TouchControls.setLayout({ dpad: { pos: 'bl', style: 'cross' }, swipes: true });
  const bottomCorner = TouchControls._corners.bl;
  assert.strictEqual(bottomCorner.style.bottom, '144px',
    'the dpad clears Safari visual-viewport occlusion without resizing the guest');
  assert.ok(viewportHandlers.has('resize') && viewportHandlers.has('scroll'),
    'toolbar movement relayouts controls immediately');
  TouchControls.destroy();
  assert.strictEqual(viewportHandlers.size, 0, 'visual viewport listeners are removed at teardown');
  delete global.window.visualViewport;
}

// 14. The manual keyboard pill: it exists for every app, and a tap on it calls
// the page's focus hand-off from inside the gesture.
{
  const renderer = {
    handleKeyDown() {}, handleKeyUp() {},
    viewMode: 'fit', setViewMode() { return false; },
    caretRect: () => null,
    getPresentedRectClient: () => ({ x: 0, y: 6, w: 390, h: 494 }),
  };

  // An app with NO touchControls entry at all -- Diablo II, StarCraft, every
  // fullscreen game that draws its own text field. It still gets the pill,
  // because a registry edit is not a prerequisite for being able to type.
  TouchControls.install({ document: global.document, renderer });
  TouchControls.sync([{ id: 'diablo2_demo' }], renderer);
  assert.ok(TouchControls.layout, 'a plain app still gets a layout');
  assert.strictEqual(TouchControls.layout.chrome, true, 'the bare chrome one');
  const pill = TouchControls._widgets.find(el => el.className === 'tc-key');
  assert.ok(pill, 'and with it the keyboard pill');
  assert.strictEqual(TouchControls.el.style.display, 'block', 'which is on screen');
  assert.strictEqual(
    TouchControls._widgets.find(el => el.className === 'tc-mode'), undefined,
    'but NOT the fit/fill toggle: no app has authored a crop for it');

  // isVisible() means "the app's game controls are up", and this app has
  // none. Both callers -- the renderer's bottom inset and the cursor-sprite
  // policy -- depend on that distinction, so a pill must not reserve screen
  // space or take Solitaire's cursor away.
  assert.strictEqual(TouchControls.isVisible(), false,
    'chrome alone is not "the game controls are up"');
  assert.strictEqual(TouchControls.isMounted(), true, 'though it IS on screen');
  assert.strictEqual(TouchControls.getOccupiedHeight(), 0, 'and reserves no band');
  assert.strictEqual(TouchControls.getOccupiedFraction(), 0, 'so the game is not pushed up');

  // The tap. The page's hand-off has to be called from inside the touchstart
  // handler -- iOS opens its keyboard from a user gesture and nowhere else.
  let open = false;
  let calls = 0;
  global.window.__wineToggleKeyboard = () => { calls++; open = !open; return open; };
  global.window.__wineKeyboardOpen = () => open;
  pill.dispatch('touchstart', { changedTouches: [{ identifier: 1, clientX: 20, clientY: 20 }] });
  assert.strictEqual(calls, 1, 'the pill calls the page hand-off');
  assert.strictEqual(open, true, 'which opens the keyboard');
  assert.ok(pill.classList.contains('tc-on'), 'and the pill lights up as a latch');

  pill.dispatch('touchend', { changedTouches: [{ identifier: 1 }] });
  pill.dispatch('touchstart', { changedTouches: [{ identifier: 2, clientX: 20, clientY: 20 }] });
  assert.strictEqual(open, false, 'a second tap closes it again');
  assert.ok(!pill.classList.contains('tc-on'), 'and the latch goes out');

  // iOS can close the keyboard from its own affordances; all the page sees is
  // the proxy blurring, and it tells us so through this entry point.
  open = true;
  TouchControls.syncKeyboardToggle();
  assert.ok(pill.classList.contains('tc-on'), 'the pill can be resynced from the page');
  open = false;
  TouchControls.syncKeyboardToggle();
  assert.ok(!pill.classList.contains('tc-on'), 'in both directions');

  // No app running at all: the overlay comes down with it.
  TouchControls.sync([], renderer);
  assert.strictEqual(TouchControls.layout, null, 'no app, no overlay');
  delete global.window.__wineToggleKeyboard;
  delete global.window.__wineKeyboardOpen;
  TouchControls.destroy();
}

// 15. A mouse-backed action button presses at the guest cursor, not at the
// HTML button's page coordinate, and teardown cannot leave it held.
{
  const mouse = [];
  const mouseRenderer = {
    canvas: { width: 640, height: 480,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) },
    _mouseX: 321, _mouseY: 222,
    handleKeyDown() {}, handleKeyUp() {},
    handleMouseDown: (x, y, button) => mouse.push(['down', x, y, button]),
    handleMouseUp: (x, y, button) => mouse.push(['up', x, y, button]),
  };
  TouchControls.install({ document: global.document, renderer: mouseRenderer });
  TouchControls.setLayout({
    buttons: [{ mouseButton: 0, label: 'Jump', pos: 'br' }],
  });
  const jump = TouchControls._widgets.find(el => el.className === 'tc-btn');
  jump.dispatch('touchstart', touchEvent([touch(80, 600, 440)]));
  jump.dispatch('touchend', touchEvent([touch(80, 600, 440)]));
  assert.deepStrictEqual(mouse, [
    ['down', 321, 222, 0], ['up', 321, 222, 0],
  ], 'mouse action uses the current guest cursor for a paired press');
  jump.dispatch('touchstart', touchEvent([touch(81, 600, 440)]));
  TouchControls.destroy();
  assert.deepStrictEqual(mouse.slice(-2), [
    ['down', 321, 222, 0], ['up', 321, 222, 0],
  ], 'destroy releases a held mouse action');
}

// Keep the release-facing Blobby layout and the verified local keyboard-game
// layouts attached when candidates are repacked or promoted.
{
  const { APPS } = require('../lib/apps');
  const actionApps = [
    'blobby_volley', 'cave_story', 'generally', 'little_fighter_2',
    'icy_tower', 'elasto_mania', 'atomic_bomberman_demo', 'jazz2_demo',
    'quake2_demo', 'gta2_demo', 'halflife_uplink', 'deus_ex_demo', 'abedemo',
  ];
  for (const id of actionApps) {
    assert(APPS[id] && APPS[id].touchControls,
      `${id} should expose phone gameplay controls`);
  }
  assert.deepStrictEqual(APPS.blobby_volley.touchControls.buttons,
    [{ mouseButton: 0, label: 'Jump', pos: 'br' }],
    'public Blobby should expose its shipped mouse-control jump action');
  assert.deepStrictEqual(APPS.quake2_demo.touchControls.dpad.vks,
    { up: 0x57, down: 0x53, left: 0x41, right: 0x44 },
    'Quake II phone movement should use its bundled WASD bindings');
  assert.strictEqual(APPS.halflife_uplink.mobileTouch, 'trackpad',
    'Half-Life should combine its WASD pad with deterministic trackpad look');
  assert.strictEqual(APPS.deus_ex_demo.mobileTouch, 'trackpad',
    'Deus Ex should combine its WASD pad with deterministic trackpad look');
}

console.log('PASS  touch controls hold, pair and release guest keys');
