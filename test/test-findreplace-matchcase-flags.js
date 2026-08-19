#!/usr/bin/env node

'use strict';

// Pointer-like HWND values must be tested for nonzero separately from the
// checkbox's checked bit when assembling FINDREPLACE flags.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e } = await bootRenderHarness();
  // Match Case is the fifth child; this base makes its HWND end in ...5, so
  // the old `hwnd & (flags & 2)` condition deterministically evaluated false.
  e.set_hwnd_base(0x20000);
  const dlg = e.test_create_replace_dialog();
  let matchCase = 0;
  let replaceAll = 0;
  let slot = 0;
  while ((slot = e.wnd_next_child_slot(dlg, slot)) !== -1) {
    const hwnd = e.wnd_slot_hwnd(slot++);
    const id = e.ctrl_get_id(hwnd);
    if (id === 0x411) matchCase = hwnd;
    if (id === 0x401) replaceAll = hwnd;
  }
  assert(matchCase && replaceAll, 'Replace dialog controls should exist');
  assert.strictEqual(matchCase & 0x0002, 0,
    'test HWND must not accidentally share the checked-state bit');

  e.send_message(matchCase, 0x00F1, 1, 0); // BM_SETCHECK
  assert.strictEqual(e.button_get_flags(matchCase) & 0x02, 0x02,
    'Match Case checkbox should be checked');
  e.send_message(dlg, 0x0111, 0x401, replaceAll); // WM_COMMAND / Replace All
  assert.strictEqual(e.test_findreplace_flags(), 0x24,
    'Replace All should preserve FR_MATCHCASE');

  console.log('PASS  Replace All preserves Match Case for pointer-like HWND values');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
