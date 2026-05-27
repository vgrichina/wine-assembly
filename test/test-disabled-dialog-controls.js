#!/usr/bin/env node
// Disabled WAT dialog controls should not accept mouse routing, and the
// disabled style bit should remain visible to control painters.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e } = await bootRenderHarness();
  const dlg = e.test_create_find_dialog();

  let findNext = 0;
  let slot = 0;
  while ((slot = e.wnd_next_child_slot(dlg, slot)) !== -1) {
    const hwnd = e.wnd_slot_hwnd(slot);
    slot++;
    if (e.ctrl_get_class(hwnd) === 1 && e.ctrl_get_id(hwnd) === 1) {
      findNext = hwnd;
      break;
    }
  }
  assert(findNext, 'Find Next button should exist');

  const xy = e.ctrl_get_xy(findNext) >>> 0;
  const x = (xy & 0xffff) + 4;
  const y = (xy >>> 16) + 4;
  const lParam = ((y & 0xffff) << 16) | (x & 0xffff);

  assert.strictEqual(e.dialog_route_mouse(dlg, 0x0201, 1, lParam), 1,
    'enabled button should accept mouse down routing');
  assert(e.button_get_flags(findNext) & 1, 'enabled button should become pressed');
  e.dialog_route_mouse(dlg, 0x0202, 0, lParam);
  assert.strictEqual(e.button_get_flags(findNext) & 1, 0,
    'enabled button should release after mouse up');

  const disabledStyle = (e.wnd_get_style_export(findNext) | 0x08000000) >>> 0;
  e.wnd_set_style_export(findNext, disabledStyle);
  assert(e.wnd_get_style_export(findNext) & 0x08000000,
    'disabled style bit should be recorded');

  assert.strictEqual(e.dialog_route_mouse(dlg, 0x0201, 1, lParam), 0,
    'disabled button should not accept mouse down routing');
  assert.strictEqual(e.button_get_flags(findNext) & 1, 0,
    'disabled button should not become pressed');

  console.log('PASS  disabled dialog controls ignore mouse routing');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
