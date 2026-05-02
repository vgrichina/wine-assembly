#!/usr/bin/env node
// PNG screenshot test: Notepad-style Find dialog. Exercises every WAT
// button kind (push button, autocheckbox, autoradio, groupbox), the WAT
// edit_wndproc paint, the WAT static_wndproc paint, and the
// $autoradio_clear_siblings mutex (we click "Down" so the rendered ring
// must show on Down, not Up).
//
// Output: test/output/find-dlg.png
//
// PASS criteria:
//   - dialog hwnd allocated
//   - canvas has many colors after repaint (i.e. WM_PAINT actually fired
//     into the WAT control wndprocs)
//   - the "Down" radio is the checked one (BM_GETCHECK reports 1, Up=0)
const { runRenderTest } = require('./render-helper');

function controlCanvasPoint(h, hwnd, relX, relY) {
  const e = h.exports;
  let x = relX;
  let y = relY;
  let cur = hwnd;
  while (cur) {
    const top = h.renderer.windows[cur];
    if (top) {
      const clientX = top.clientRect ? top.clientRect.x : top.x;
      const clientY = top.clientRect ? top.clientRect.y : top.y;
      return { x: x + clientX, y: y + clientY };
    }
    const xy = e.ctrl_get_xy(cur) >>> 0;
    x += xy & 0xFFFF;
    y += xy >>> 16;
    cur = e.wnd_get_parent(cur) >>> 0;
  }
  return { x, y };
}

function radioDotIsDark(h, hwnd) {
  const wh = h.exports.ctrl_get_wh(hwnd) >>> 0;
  const cy = ((wh >>> 16) >> 1) | 0;
  const p = controlCanvasPoint(h, hwnd, 6, cy);
  const data = h.canvas.getContext('2d').getImageData(p.x - 1, p.y - 1, 3, 3).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) dark++;
  }
  return dark >= 2;
}

runRenderTest('find-dlg', async (h, check) => {
  const e = h.exports;
  const dlg = e.test_create_find_dialog();
  check('dialog hwnd allocated', dlg !== 0, 'hwnd=0x' + dlg.toString(16));

  // Find the two autoradios (Up=0x420, Down=0x421) and click Down.
  let up = 0, down = 0;
  let slot = 0;
  while ((slot = e.wnd_next_child_slot(dlg, slot)) !== -1) {
    const ch = e.wnd_slot_hwnd(slot);
    slot++;
    if (e.ctrl_get_class(ch) !== 1) continue;
    const id = e.ctrl_get_id(ch);
    if (id === 0x420) up = ch;
    else if (id === 0x421) down = ch;
  }
  check('found Up + Down autoradios', up !== 0 && down !== 0,
    `up=0x${up.toString(16)} down=0x${down.toString(16)}`);

  // Paint the default state first. Then click Up and composite without
  // repainting the whole dialog; the cleared Down sibling must repaint itself
  // or the browser-visible canvas can keep the stale Down dot.
  e.send_message(up, 0x000F, 0, 0);
  e.send_message(down, 0x000F, 0, 0);
  h.renderer.repaint();
  check('initial Down radio dot rendered checked', radioDotIsDark(h, down));

  e.send_message(up, 0x0201, 0, 0);
  e.send_message(up, 0x0202, 0, 0);
  h.renderer.repaint();
  check('Up radio dot rendered after click', radioDotIsDark(h, up));
  check('Down radio dot visually cleared after Up click', !radioDotIsDark(h, down));

  // Click Down via WM_LBUTTONDOWN+UP. The mutex helper must clear Up.
  e.send_message(down, 0x0201, 0, 0);
  e.send_message(down, 0x0202, 0, 0);
  check('Down is checked after click',  e.send_message(down, 0x00F0, 0, 0) === 1);
  check('Up is NOT checked after click', e.send_message(up,   0x00F0, 0, 0) === 0);

  h.renderer.repaint();
}, { minColors: 12 });
