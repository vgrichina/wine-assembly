#!/usr/bin/env node
'use strict';

const assert = require('assert');

const listeners = new Map();
const addListener = (type, fn) => listeners.set(type, fn);
const classNames = new Set();
const canvas = {
  width: 640,
  height: 480,
  style: {},
  classList: {
    toggle(name, enabled) {
      if (enabled) classNames.add(name);
      else classNames.delete(name);
    },
  },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  addEventListener: addListener,
  removeEventListener() {},
  setAttribute() {},
  focus() {},
  requestPointerLock() {},
};

global.window = {
  addEventListener: addListener,
  removeEventListener() {},
  MobileKeyboard: null,
};
global.document = {
  pointerLockElement: null,
  body: {},
  documentElement: {},
  activeElement: canvas,
  visibilityState: 'visible',
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: addListener,
  elementFromPoint: () => null,
};

const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = () => 1;
global.clearInterval = () => {};

const calls = { absolute: [], relative: [], hover: [] };
let wantsRelative = true;
const renderer = {
  windows: {},
  wantsRelativeMouse: () => wantsRelative,
  wantsHiddenMouse: () => wantsRelative,
  handleMouseMove: (x, y) => calls.absolute.push([x, y]),
  handleRelativeMouseMove: (x, y) => calls.relative.push([x, y]),
  handleMenuHover: (x, y) => calls.hover.push([x, y]),
  handleMouseDown() {},
  handleMouseUp() {},
  handleWheel() {},
};

try {
  const browserInput = require('../lib/browser-input');
  browserInput.wireCanvasInput(canvas, renderer, { runningApps: [], debugMode: false });

  canvas.onmousemove({ clientX: 520, clientY: 240, movementX: 200, movementY: 0 });
  assert.deepStrictEqual(calls.absolute, [],
    'absolute DOM motion must not enter a relative guest while Pointer Lock is pending');
  assert.deepStrictEqual(calls.hover, [],
    'relative capture mode must not leak the pending absolute point through menu hover');

  canvas.onmousedown({
    clientX: 320, clientY: 240, button: 0, buttons: 1,
    ctrlKey: false, shiftKey: false, preventDefault() {},
  });
  listeners.get('mousemove')({
    clientX: 500, clientY: 240, movementX: 180, movementY: 0, buttons: 1,
    preventDefault() {}, stopPropagation() {},
  });
  assert.deepStrictEqual(calls.absolute, [],
    'motion during asynchronous Pointer Lock acquisition must not become an absolute jump');
  listeners.get('mouseup')({
    clientX: 500, clientY: 240, button: 0,
    preventDefault() {}, stopPropagation() {},
  });

  document.pointerLockElement = canvas;
  canvas.onmousemove({ clientX: 0, clientY: 0, movementX: 7, movementY: -3 });
  assert.deepStrictEqual(calls.relative, [[7, -3]],
    'Pointer Lock movement should still enter the relative mouse path');

  document.pointerLockElement = null;
  wantsRelative = false;
  canvas.onmousemove({ clientX: 123, clientY: 234, movementX: 1, movementY: 2 });
  assert.deepStrictEqual(calls.absolute, [[123, 234]],
    'ordinary desktop guests must retain absolute mouse movement');
  assert.deepStrictEqual(calls.hover, [[123, 234]],
    'ordinary desktop hover behavior must remain intact');
} finally {
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
}

console.log('PASS  relative guests ignore absolute motion until Pointer Lock is acquired');
