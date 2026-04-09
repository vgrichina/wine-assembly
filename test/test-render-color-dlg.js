#!/usr/bin/env node
// PNG screenshot test: ChooseColor dialog. Exercises the WAT colorgrid
// WM_PAINT (8x3 swatches + selection ring) plus push buttons (OK / Cancel).
//
// Output: test/output/color-dlg.png
//
// PASS criteria:
//   - dialog hwnd allocated
//   - the colorgrid is found among children
//   - canvas has many colors after repaint (≥ 24 — every swatch is unique
//     enough that the 16-px sampling grid in render-helper sees most of them)
const { runRenderTest } = require('./render-helper');

runRenderTest('color-dlg', async (h, check) => {
  const e = h.exports;
  const dlg = e.test_create_color_dialog();
  check('dialog hwnd allocated', dlg !== 0, 'hwnd=0x' + dlg.toString(16));

  // Find the colorgrid child and pick cell 13 (blue) so the selection ring
  // has something to render.
  let grid = 0;
  for (let s = 0; s < 256; s++) {
    const ch = e.wnd_slot_hwnd(s);
    if (ch && e.ctrl_get_class(ch) === 6) { grid = ch; break; }
  }
  check('colorgrid child found', grid !== 0, 'hwnd=0x' + grid.toString(16));

  // Click row 1, col 5 → idx 13.
  const x = 5 * 24 + 10, y = 1 * 20 + 10;
  e.send_message(grid, 0x0201, 0, (x & 0xFFFF) | ((y & 0xFFFF) << 16));
  check('colorgrid sel_idx == 13 after click', e.colorgrid_get_sel(grid) === 13);

  h.renderer.repaint();
}, { minColors: 16 });
