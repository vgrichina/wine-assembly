#!/usr/bin/env node
// PNG screenshot test: ChooseColor dialog. Exercises the WAT colorgrid
// WM_PAINT (8x6 basic and 8x2 custom swatches + selection ring) plus buttons.
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
  let grid = 0, customGrid = 0;
  for (let s = 0; s < 256; s++) {
    const ch = e.wnd_slot_hwnd(s);
    if (!ch || e.ctrl_get_class(ch) !== 6) continue;
    if (e.ctrl_get_id(ch) === 0x460) grid = ch;
    if (e.ctrl_get_id(ch) === 0x461) customGrid = ch;
  }
  check('colorgrid child found', grid !== 0, 'hwnd=0x' + grid.toString(16));
  check('custom colorgrid child found', customGrid !== 0, 'hwnd=0x' + customGrid.toString(16));

  // Click basic row 1, col 5 → idx 13.
  const x = 5 * 26 + 10, y = 1 * 22 + 10;
  e.send_message(grid, 0x0201, 0, (x & 0xFFFF) | ((y & 0xFFFF) << 16));
  check('colorgrid sel_idx == 13 after click', e.colorgrid_get_sel(grid) === 13);

  // Custom row 0, col 5 is backed by lpCustColors[5], not the basic table.
  const customX = 5 * 26 + 10, customY = 10;
  e.send_message(customGrid, 0x0201, 0,
    (customX & 0xFFFF) | ((customY & 0xFFFF) << 16));
  check('custom color comes from lpCustColors',
    e.colorgrid_control_color(customGrid, 5) === 0x00123456);
  check('custom click selects its cell', e.colorgrid_get_sel(customGrid) === 5);
  check('custom click clears basic selection', e.colorgrid_get_sel(grid) === -1);
  check('custom click updates CHOOSECOLOR.rgbResult',
    e.test_color_dialog_result(dlg) === 0x00123456);

  h.renderer.repaint();
}, { minColors: 16 });
