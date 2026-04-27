#!/usr/bin/env node
// PNG screenshot test: combobox visuals. Creates a CBS_DROPDOWNLIST
// combobox via test_create_combobox, opens its dropdown, populates a few
// items, and verifies the combobox + listbox actually paint to the
// back-canvas. Output: test/output/combobox.png.
//
// PASS criteria:
//   - combobox hwnd allocated
//   - inner listbox exposed
//   - is_dropped=1 after CB_SHOWDROPDOWN
//   - canvas has many colors after repaint (proves WM_PAINT reached the
//     combobox and listbox wndprocs and painted real GDI primitives)
const { runRenderTest } = require('./render-helper');

runRenderTest('combobox', async (h, check) => {
  const e = h.exports;
  const memory = h.memory;

  const writeStr = (s) => {
    const g = e.guest_alloc(s.length + 1);
    const wa = g - e.get_image_base() + 0x12000;
    const u8 = new Uint8Array(memory.buffer);
    for (let i = 0; i < s.length; i++) u8[wa + i] = s.charCodeAt(i);
    u8[wa + s.length] = 0;
    return g;
  };

  const CBS_DROPDOWNLIST = 3;
  const CB_ADDSTRING = 0x0143, CB_SETCURSEL = 0x014E, CB_SHOWDROPDOWN = 0x014F;

  // Combobox at (40, 40), 200 wide, 120 tall (room for the dropdown).
  const cb = e.test_create_combobox(40, 40, 200, 120, CBS_DROPDOWNLIST);
  check('combobox hwnd allocated', cb !== 0, 'hwnd=0x' + cb.toString(16));

  const lb = e.combobox_get_lb_hwnd(cb);
  check('inner listbox exposed', lb !== 0, 'lb=0x' + lb.toString(16));

  const items = ['Granite', 'Marble', 'Sandstone', 'Slate', 'Limestone'];
  items.forEach(s => e.send_message(cb, CB_ADDSTRING, 0, writeStr(s)));
  e.send_message(cb, CB_SETCURSEL, 1, 0); // pre-select "Marble"

  // Open the dropdown so both the field AND the listbox visibly paint.
  e.send_message(cb, CB_SHOWDROPDOWN, 1, 0);
  check('CB_SHOWDROPDOWN(1) → is_dropped=1', e.combobox_is_dropped(cb) === 1);
}, { minColors: 8 });
