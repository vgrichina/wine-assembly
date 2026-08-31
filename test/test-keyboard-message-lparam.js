#!/usr/bin/env node
'use strict';

// Win32 games frequently translate WM_KEYDOWN/UP from the Set-1 scan code in
// lParam instead of using wParam.  Quake II's MapKey path is one example.

const assert = require('assert');
const {
  installInputHandlers,
  keyboardMessageLParam,
} = require('../lib/renderer-input');

assert.strictEqual(keyboardMessageLParam(0x57, { code: 'KeyW' }, false, false),
  0x00110001, 'W carries Set-1 scan code 0x11 and repeat count 1');
assert.strictEqual(keyboardMessageLParam(0x26, { code: 'ArrowUp' }, false, false),
  0x01480001, 'Up carries scan code 0x48 plus the extended-key bit');
assert.strictEqual(keyboardMessageLParam(0x57, { code: 'KeyW', repeat: true }, false, true),
  0x40110001, 'repeated keydown sets the previous-state bit');
assert.strictEqual(keyboardMessageLParam(0x26, { code: 'ArrowUp' }, true, true),
  0xC1480001, 'keyup sets previous-state, transition, scan, and extended bits');
assert.strictEqual(keyboardMessageLParam(0x0D, null, false, false),
  0x001C0001, 'numeric-only CLI callers retain an Enter scan-code fallback');

class RendererProbe {
  constructor() {
    this.inputQueue = [];
    this.windows = {};
    this.wasm = null;
    this.mainWasm = null;
    this._exited = false;
  }
}
installInputHandlers(RendererProbe);

const renderer = new RendererProbe();
renderer.handleKeyDown(0x26, { code: 'ArrowUp' });
assert.strictEqual(renderer.peekKeyDownState(0x26), 0x8000,
  'DirectInput physical state sees a browser key press immediately');
let event = renderer.takeInput();
assert(event, 'keydown enters the normal renderer input queue');
assert.strictEqual(event.msg, 0x0100);
assert.strictEqual(event.wParam, 0x26);
assert.strictEqual(event.lParam >>> 0, 0x01480001,
  'queued WM_KEYDOWN preserves the scan-code lParam');

renderer.handleKeyUp(0x26, { code: 'ArrowUp' });
event = renderer.takeInput();
assert(event, 'keyup enters the normal renderer input queue');
assert.strictEqual(event.msg, 0x0101);
assert.strictEqual(event.lParam >>> 0, 0xC1480001,
  'queued WM_KEYUP preserves scan, extended, previous, and transition bits');

const directInputOnly = new RendererProbe();
directInputOnly.handleKeyDown(0x28, { code: 'ArrowDown' });
directInputOnly.handleKeyUp(0x28, { code: 'ArrowDown' });
assert.strictEqual(directInputOnly.inputQueue.length, 2,
  'the Win32 key messages remain queued for an app that does not drain them');
assert.strictEqual(directInputOnly.peekAsyncKeyState(0x28), 0x8000,
  'Win32 async state remains ordered behind the queued key-up');
assert.strictEqual(directInputOnly.peekKeyDownState(0x28), 0,
  'DirectInput physical state observes key-up without waiting for GetMessage');

console.log('PASS Win32 keyboard messages preserve ordering while DirectInput tracks physical key release');
