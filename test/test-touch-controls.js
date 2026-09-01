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
global.window = { addEventListener() {}, removeEventListener() {} };
global.location = { search: '' };

const touchEvent = (touches) => ({
  changedTouches: touches,
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
TouchControls.sync([{ name: 'notepad' }], renderer);
assert.strictEqual(TouchControls.layout, null, 'sync drops the layout when the app closes');
assert.strictEqual(TouchControls.el.style.display, 'none', 'no layout hides the overlay');
TouchControls.destroy();

console.log('PASS  touch controls hold, pair and release guest keys');
