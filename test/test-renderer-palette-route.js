#!/usr/bin/env node
// MFC floating palettes can host a child dialog under a non-dialog popup.
// Mouse routing must start at that popup so nested controls use its origin.

const assert = require('assert');
const { installInputHandlers } = require('../lib/renderer-input');

class FakeRenderer {}
installInputHandlers(FakeRenderer);

const r = new FakeRenderer();
const palette = { hwnd: 0x1001e, isChild: false, isDialog: false };
const childDialog = {
  hwnd: 0x1001f, isChild: true, isDialog: true, parentHwnd: palette.hwnd,
};
const nestedDialog = {
  hwnd: 0x10030, isChild: true, isDialog: true, parentHwnd: 0x1002f,
};
const dialogParent = { hwnd: 0x1002f, isChild: false, isDialog: true };
r.windows = {
  [palette.hwnd]: palette,
  [childDialog.hwnd]: childDialog,
  [dialogParent.hwnd]: dialogParent,
  [nestedDialog.hwnd]: nestedDialog,
};

assert.strictEqual(r._dialogMouseRouteRoot(childDialog), palette,
  'floating palette child dialog did not route from its popup parent');
assert.strictEqual(r._dialogMouseRouteRoot(nestedDialog), nestedDialog,
  'ordinary nested dialogs should retain existing routing behavior');
assert.strictEqual(r._dialogMouseRouteRoot(palette), palette,
  'top-level popup routing changed unexpectedly');

console.log('PASS  floating palette controls route through their popup root');
console.log('PASS  ordinary dialog routing remains unchanged');
