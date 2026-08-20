#!/usr/bin/env node
// Regioned/skinned windows keep their whole shaped surface as the client
// area even after later move/resize NCCALCSIZE passes.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { instance, exports: e, renderer, memory } = await bootRenderHarness();
  const hwnd = 0x10001;
  const style = 0x00ca0000; // Winamp-style caption/sysmenu frame.

  renderer.createWindow(hwnd, style, 26, 29, 275, 116, 'Winamp 2.91', 0, instance, memory);
  renderer.windows[hwnd].visible = true;
  e.wnd_table_set(hwnd, 1);
  e.wnd_set_style_export(hwnd, style);

  e.host_resize_commit(hwnd, 26, 29, 275, 116);
  assert.strictEqual(e.get_client_rect_l(hwnd), 3, 'plain captioned window should use standard left border');
  assert.strictEqual(e.get_client_rect_t(hwnd), 23, 'plain captioned window should use standard caption offset');
  assert.strictEqual(e.get_client_rect_r(hwnd), 272, 'plain captioned window should subtract right border');
  assert.strictEqual(e.get_client_rect_b(hwnd), 112, 'plain captioned window should subtract bottom border');

  e.wnd_region_set_export(hwnd, 1);
  renderer.windows[hwnd].x = 120;
  renderer.windows[hwnd].y = 80;
  e.host_resize_commit(hwnd, 120, 80, 275, 116);

  assert.strictEqual(e.wnd_region_get_export(hwnd), 1, 'region flag should stay set');
  assert.strictEqual(e.get_client_rect_l(hwnd), 0, 'regioned window client left should stay at skin origin');
  assert.strictEqual(e.get_client_rect_t(hwnd), 0, 'regioned window client top should stay at skin origin');
  assert.strictEqual(e.get_client_rect_r(hwnd), 275, 'regioned window client right should stay full width');
  assert.strictEqual(e.get_client_rect_b(hwnd), 116, 'regioned window client bottom should stay full height');

  e.wnd_destroy_tree(hwnd);
  assert.strictEqual(e.wnd_region_get_export(hwnd), 0, 'region flag should clear when the slot is destroyed');

  console.log('PASS  regioned window client rect survives move/resize nccalc');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
