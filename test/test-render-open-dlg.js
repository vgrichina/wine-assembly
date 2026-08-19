#!/usr/bin/env node
// PNG screenshot test: GetOpenFileName dialog. Exercises the WAT edit
// WM_PAINT (Look in / File name fields), the WAT listbox WM_PAINT (file
// list), static labels, and push buttons (Open / Cancel / Upload). Built
// with has_dom=1 so the optional Upload button gets rendered.
//
// Output: test/output/open-dlg.png
const { runRenderTest } = require('./render-helper');

runRenderTest('open-dlg', async (h, check) => {
  const e = h.exports;
  const dlg = e.test_create_open_dialog(0); // 0 = Open, 1 = Save As
  check('dialog hwnd allocated', dlg !== 0, 'hwnd=0x' + dlg.toString(16));

  // Spot-check that we have at least one Edit and one ListBox child.
  let editCount = 0, lbCount = 0;
  let slot = 0;
  while ((slot = e.wnd_next_child_slot(dlg, slot)) !== -1) {
    const ch = e.wnd_slot_hwnd(slot);
    slot++;
    const c = e.ctrl_get_class(ch);
    if (c === 2) editCount++;
    if (c === 4) lbCount++;
  }
  check('has Edit child(ren)', editCount > 0, `${editCount}`);
  check('has ListBox child(ren)', lbCount > 0, `${lbCount}`);

  h.renderer.repaint();
}, { minColors: 8 });
