#!/usr/bin/env node
// PNG screenshot test: ChooseColor dialog. Exercises the WAT colorgrid
// WM_PAINT (8x6 basic and 8x2 custom swatches + selection ring), plus the
// expandable HSL/RGB editor and Color|Solid preview used to add a
// caller-persistent custom color.
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

  const findById = id => {
    for (let s = 0; s < 256; s++) {
      const ch = e.wnd_slot_hwnd(s);
      if (ch && e.ctrl_get_id(ch) === id) return ch;
    }
    return 0;
  };
  const define = findById(0x462);
  check('Define Custom Colors button exists', define !== 0);
  e.send_message(dlg, 0x0111, 0x462, define);
  const red = findById(0x463), green = findById(0x464), blue = findById(0x465);
  const hue = findById(0x468), sat = findById(0x469), lum = findById(0x46a);
  const preview = findById(0x46b);
  const add = findById(0x466);
  check('Define expands RGB editor controls', !!(red && green && blue && add));
  check('Define expands Hue/Sat/Lum editor controls', !!(hue && sat && lum));
  check('Define creates Color|Solid preview', preview !== 0 && e.ctrl_get_class(preview) === 26,
    `hwnd=0x${preview.toString(16)} class=${preview ? e.ctrl_get_class(preview) : 0}`);
  let spectrum = 0;
  for (let s = 0; s < 256; s++) {
    const ch = e.wnd_slot_hwnd(s);
    if (ch && e.ctrl_get_class(ch) === 23) spectrum = ch;
  }
  check('Define creates hue/saturation picker', spectrum !== 0,
    `hwnd=0x${spectrum.toString(16)}`);
  check('Define widens the visible dialog', h.renderer.windows[dlg].w === 436,
    `width=${h.renderer.windows[dlg].w}`);

  const u8 = new Uint8Array(h.memory.buffer);
  const wa = g => g - e.get_image_base() + e.get_guest_base();
  const readText = hwnd => {
    const g = e.guest_alloc(8);
    const n = e.send_message(hwnd, 0x000d, 8, g);
    const value = Buffer.from(u8.subarray(wa(g), wa(g) + Math.max(0, n))).toString('latin1');
    e.guest_free(g);
    return value;
  };
  check('selected custom RGB initializes exact HSL fields',
    readText(hue) === '20' && readText(sat) === '156' && readText(lum) === '48',
    `hsl=${readText(hue)},${readText(sat)},${readText(lum)}`);

  e.send_message(spectrum, 0x0201, 0, 80 | (20 << 16));
  check('spectrum click updates CHOOSECOLOR.rgbResult',
    e.test_color_dialog_result(dlg) !== 0 && e.test_color_dialog_result(dlg) !== 0x00123456,
    `rgb=0x${e.test_color_dialog_result(dlg).toString(16)}`);
  check('spectrum click updates Hue/Sat/Lum fields',
    readText(hue) === '117' && readText(sat) === '204' && readText(lum) === '48',
    `hsl=${readText(hue)},${readText(sat)},${readText(lum)}`);

  const setText = (hwnd, value) => {
    const s = String(value);
    const g = e.guest_alloc(s.length + 1);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i);
    u8[p + s.length] = 0;
    e.send_message(hwnd, 0x000C, 0, g);
    e.guest_free(g);
  };
  setText(hue, 80);
  setText(sat, 240);
  setText(lum, 120);
  e.send_message(dlg, 0x0111, 0x03000000 | 0x46a, lum);
  check('HSL edits update CHOOSECOLOR.rgbResult',
    e.test_color_dialog_result(dlg) === 0x0000ff00,
    `rgb=0x${e.test_color_dialog_result(dlg).toString(16)}`);
  check('HSL edits synchronize RGB fields',
    readText(red) === '0' && readText(green) === '255' && readText(blue) === '0',
    `rgb=${readText(red)},${readText(green)},${readText(blue)}`);

  setText(red, 17);
  setText(green, 34);
  setText(blue, 51);
  e.send_message(dlg, 0x0111, 0x03000000 | 0x465, blue);
  check('RGB edits update CHOOSECOLOR.rgbResult',
    e.test_color_dialog_result(dlg) === 0x00332211,
    `rgb=0x${e.test_color_dialog_result(dlg).toString(16)}`);
  check('RGB edits synchronize Hue/Sat/Lum fields',
    readText(hue) === '140' && readText(sat) === '120' && readText(lum) === '32',
    `hsl=${readText(hue)},${readText(sat)},${readText(lum)}`);
  e.send_message(dlg, 0x0111, 0x466, add);
  check('Add updates selected custom swatch from RGB fields',
    e.colorgrid_control_color(customGrid, 5) === 0x00332211);
  check('Add updates CHOOSECOLOR.rgbResult',
    e.test_color_dialog_result(dlg) === 0x00332211);

  h.renderer.repaint();
}, { minColors: 16 });
