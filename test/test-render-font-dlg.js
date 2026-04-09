#!/usr/bin/env node
// PNG screenshot test: ChooseFont dialog. Exercises the WAT listbox
// WM_PAINT (3 listboxes — Face, Style, Size) with default selections,
// static labels, and OK/Cancel buttons.
//
// Output: test/output/font-dlg.png
const { runRenderTest } = require('./render-helper');

runRenderTest('font-dlg', async (h, check) => {
  const e = h.exports;
  const dlg = e.test_create_font_dialog();
  check('dialog hwnd allocated', dlg !== 0, 'hwnd=0x' + dlg.toString(16));

  // Verify there are at least 3 listbox children (Face / Style / Size).
  let lbCount = 0;
  let slot = 0;
  while ((slot = e.wnd_next_child_slot(dlg, slot)) !== -1) {
    const ch = e.wnd_slot_hwnd(slot);
    slot++;
    if (e.ctrl_get_class(ch) === 4) lbCount++;
  }
  check('found 3 listboxes', lbCount === 3, `${lbCount} found`);

  h.renderer.repaint();
}, { minColors: 8 });
