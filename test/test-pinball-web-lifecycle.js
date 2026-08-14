#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
const context = { console };
vm.runInNewContext(source + '\n;globalThis.WineAssembly = WineAssembly;', context);

const keep = context.WineAssembly.hasRemainingAppWindow;

const hiddenPinballMain = {
  hwnd: 0x10002,
  visible: false,
  isDialog: false,
};
const pinballSplash = {
  hwnd: 0x10001,
  visible: false,
  isDialog: undefined,
  ownerHwnd: undefined,
  className: '3DPB_SPLASH_CLASS',
};
assert.strictEqual(keep(pinballSplash, []), true,
  'destroying Pinball hidden splash must not stop startup before its main frame is ready');
assert.strictEqual(keep({ ...pinballSplash, visible: true }, []), false,
  'destroying the final visible ownerless window still stops a process');

const hiddenAccessoryOwner = {
  hwnd: 0x20001,
  visible: false,
  isDialog: false,
};
const accessoryDialog = {
  hwnd: 0x20002,
  visible: true,
  isDialog: true,
  ownerHwnd: hiddenAccessoryOwner.hwnd,
};
assert.strictEqual(keep(accessoryDialog, [hiddenAccessoryOwner]), false,
  'closing a dialog-only accessory must not retain its invisible owner process');

assert.strictEqual(keep(accessoryDialog, [{ ...hiddenAccessoryOwner, visible: true }]), true,
  'a visible owner must keep its process alive');
assert.strictEqual(keep({ isDialog: false }, [hiddenPinballMain]), true,
  'ordinary hidden top-level windows retain a process');
assert.strictEqual(keep({ isDialog: false }, []), false,
  'destroying the final top-level window stops a process');

console.log('PASS  Pinball splash teardown retains its hidden independent main window');
console.log('PASS  dialog-only accessory teardown still stops its invisible owner process');
