#!/usr/bin/env node

'use strict';

// EnableScrollBar is visible state, not an acknowledgement shim: Win98 keeps
// one ESB_* mask per bar, paints disabled arrows embossed, and suppresses only
// those arrow hits. SIF_DISABLENOSCROLL uses that same state while preserving
// a bar whose range no longer needs scrolling.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const { installInputHandlers } = require('../lib/renderer-input');

const extraWat = String.raw`
  (func (export "test_create_scrollbar") (param $vert i32) (result i32)
    (local $parent i32) (local $bar i32) (local $style i32)
    (local.set $parent (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $parent) (global.get $WNDPROC_CTRL_NATIVE))
    (drop (call $wnd_set_style (local.get $parent) (i32.const 0x80000000)))
    (local.set $style
      (i32.or (i32.const 0x50000000)
        (i32.and (local.get $vert) (i32.const 1))))
    (local.set $bar (call $ctrl_create_child
      (local.get $parent) (i32.const 7) (i32.const 101)
      (i32.const 0) (i32.const 0)
      (select (i32.const 16) (i32.const 100) (local.get $vert))
      (select (i32.const 100) (i32.const 16) (local.get $vert))
      (local.get $style) (i32.const 0)))
    (local.get $bar))

  (func (export "test_scroll_values") (param $hwnd i32) (param $vert i32)
      (param $pos i32) (param $smin i32) (param $smax i32)
    (local $slot i32) (local $base i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (call $scroll_bar_addr (local.get $slot) (local.get $vert)))
        (i32.store (local.get $base) (local.get $pos))
        (i32.store offset=4 (local.get $base) (local.get $smin))
        (i32.store offset=8 (local.get $base) (local.get $smax)))))

  (func (export "test_set_scroll_info")
      (param $hwnd i32) (param $bar i32) (param $info i32) (param $redraw i32)
      (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetScrollInfo
      (local.get $hwnd) (local.get $bar) (local.get $info) (local.get $redraw)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))

  (func (export "test_scroll_pressed_part") (result i32)
    (global.get $sb_pressed_part))

  (func (export "test_reuse_scroll_window")
      (param $old i32) (param $replacement i32)
    (call $wnd_table_remove (local.get $old))
    (call $wnd_table_set (local.get $replacement) (global.get $WNDPROC_CTRL_NATIVE)))

  (func (export "test_enable_last_error") (result i32)
    (global.get $last_error))

  (func (export "test_draw_scroll_arrow") (param $hdc i32) (param $disabled i32)
    (call $draw_sb_arrow (local.get $hdc)
      (i32.const 0) (i32.const 0) (i32.const 16) (i32.const 16)
      (i32.const 0) (i32.const 0) (local.get $disabled)))
`;

const SB_HORZ = 0;
const SB_VERT = 1;
const SB_CTL = 2;
const SB_BOTH = 3;
const ESB_ENABLE_BOTH = 0;
const ESB_DISABLE_LTUP = 1;
const ESB_DISABLE_RTDN = 2;
const ESB_DISABLE_BOTH = 3;
const SBM_ENABLE_ARROWS = 0x00E4;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_HSCROLL = 0x00100000;
const WS_VSCROLL = 0x00200000;
const ES_MULTILINE = 0x0004;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  };

  const edit = e.test_create_edit(0, 0, 160, 100,
    WS_CHILD | WS_VISIBLE | WS_HSCROLL | WS_VSCROLL | ES_MULTILINE, 0);

  check('EnableScrollBar retains independent horizontal and vertical state', () => {
    assert.strictEqual(e.standard_scroll_arrows(edit, SB_HORZ), ESB_ENABLE_BOTH);
    assert.strictEqual(e.standard_scroll_arrows(edit, SB_VERT), ESB_ENABLE_BOTH);
    assert.strictEqual(e.test_enable_scroll_bar(edit, SB_HORZ, ESB_DISABLE_LTUP), 1);
    assert.strictEqual(e.standard_scroll_arrows(edit, SB_HORZ), ESB_DISABLE_LTUP);
    assert.strictEqual(e.standard_scroll_arrows(edit, SB_VERT), ESB_ENABLE_BOTH);
  });

  check('EnableScrollBar returns false when arrows already have the requested state', () => {
    assert.strictEqual(e.test_enable_scroll_bar(edit, SB_HORZ, ESB_DISABLE_LTUP), 0);
    assert.strictEqual(e.test_enable_scroll_bar(edit, SB_BOTH, ESB_DISABLE_BOTH), 1);
    assert.strictEqual(e.standard_scroll_arrows(edit, SB_HORZ), ESB_DISABLE_BOTH);
    assert.strictEqual(e.standard_scroll_arrows(edit, SB_VERT), ESB_DISABLE_BOTH);
    assert.strictEqual(e.test_enable_scroll_bar(edit, SB_BOTH, ESB_DISABLE_BOTH), 0);
  });

  check('EnableScrollBar validates handles, selectors, arrows, and SB_CTL class', () => {
    assert.strictEqual(e.test_enable_scroll_bar(0x7fffffff, SB_VERT, ESB_DISABLE_BOTH), 0);
    assert.strictEqual(e.test_enable_last_error(), 1400);
    assert.strictEqual(e.test_enable_scroll_bar(edit, 99, ESB_DISABLE_BOTH), 0);
    assert.strictEqual(e.test_enable_last_error(), 87);
    assert.strictEqual(e.test_enable_scroll_bar(edit, SB_VERT, 4), 0);
    assert.strictEqual(e.test_enable_last_error(), 87);
    assert.strictEqual(e.test_enable_scroll_bar(edit, SB_CTL, ESB_DISABLE_BOTH), 0);
    assert.strictEqual(e.test_enable_last_error(), 87);
  });

  const scroll = e.test_create_scrollbar(1);
  e.test_scroll_values(scroll, 1, 5, 0, 10);

  check('scrollbar controls share EnableScrollBar and SBM_ENABLE_ARROWS state', () => {
    assert.strictEqual(e.test_enable_scroll_bar(scroll, SB_CTL, ESB_DISABLE_LTUP), 1);
    assert.strictEqual(e.standard_scroll_arrows(scroll, SB_VERT), ESB_DISABLE_LTUP);
    assert.strictEqual(e.send_message(scroll, SBM_ENABLE_ARROWS, ESB_DISABLE_RTDN, 0), 1);
    assert.strictEqual(e.standard_scroll_arrows(scroll, SB_VERT), ESB_DISABLE_RTDN);
    assert.strictEqual(e.send_message(scroll, SBM_ENABLE_ARROWS, ESB_DISABLE_RTDN, 0), 1,
      'the message form should report a valid request, even when unchanged');
    assert.strictEqual(e.send_message(scroll, SBM_ENABLE_ARROWS, 4, 0), 0);
  });

  check('disabled scrollbar arrows consume clicks without activating', () => {
    e.send_message(scroll, SBM_ENABLE_ARROWS, ESB_DISABLE_LTUP, 0);
    e.send_message(scroll, WM_LBUTTONDOWN, 0, 8 | (8 << 16));
    assert.strictEqual(e.test_scroll_pressed_part(), 0, 'disabled up arrow became pressed');
    e.send_message(scroll, WM_LBUTTONDOWN, 0, 8 | (92 << 16));
    assert.strictEqual(e.test_scroll_pressed_part(), 2, 'enabled down arrow did not activate');
    e.send_message(scroll, WM_LBUTTONUP, 0, 8 | (92 << 16));
    e.send_message(scroll, SBM_ENABLE_ARROWS, ESB_ENABLE_BOTH, 0);
    e.send_message(scroll, WM_LBUTTONDOWN, 0, 8 | (8 << 16));
    assert.strictEqual(e.test_scroll_pressed_part(), 1, 're-enabled up arrow did not activate');
    e.send_message(scroll, WM_LBUTTONUP, 0, 8 | (8 << 16));
  });

  const info = e.guest_alloc(28) >>> 0;
  const setInfo = (mask, min, max, page, pos = 0) => {
    for (let off = 0; off < 28; off += 4) e.guest_write32(info + off, 0);
    e.guest_write32(info, 28);
    e.guest_write32(info + 4, mask);
    e.guest_write32(info + 8, min);
    e.guest_write32(info + 12, max);
    e.guest_write32(info + 16, page);
    e.guest_write32(info + 20, pos);
  };

  const sized = e.test_create_edit(0, 0, 160, 100,
    WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE, 0);
  check('SIF_DISABLENOSCROLL preserves and disables an unnecessary standard bar', () => {
    setInfo(0x01 | 0x02 | 0x08, 0, 9, 10);
    assert.strictEqual(e.test_set_scroll_info(sized, SB_VERT, info, 1), 0);
    assert(e.wnd_get_style_export(sized) & WS_VSCROLL, 'vertical bar was removed');
    assert.strictEqual(e.standard_scroll_arrows(sized, SB_VERT), ESB_DISABLE_BOTH);

    setInfo(0x01 | 0x02 | 0x08, 0, 9, 2);
    e.test_set_scroll_info(sized, SB_VERT, info, 1);
    assert(e.wnd_get_style_export(sized) & WS_VSCROLL, 'useful vertical bar disappeared');
    assert.strictEqual(e.standard_scroll_arrows(sized, SB_VERT), ESB_ENABLE_BOTH);

    setInfo(0x01 | 0x02, 0, 9, 10);
    e.test_set_scroll_info(sized, SB_VERT, info, 1);
    assert.strictEqual(e.wnd_get_style_export(sized) & WS_VSCROLL, 0,
      'ordinary SetScrollInfo kept an unnecessary bar');
  });

  check('SetScrollInfo SB_CTL disables arrows without inventing WS_VSCROLL', () => {
    setInfo(0x01 | 0x02 | 0x08, 0, 9, 10);
    e.test_set_scroll_info(scroll, SB_CTL, info, 1);
    assert.strictEqual(e.standard_scroll_arrows(scroll, SB_VERT), ESB_DISABLE_BOTH);
    assert.strictEqual(e.wnd_get_style_export(scroll) & WS_VSCROLL, 0);
    assert(e.wnd_get_style_export(scroll) & WS_VISIBLE);
  });

  check('window-slot reuse clears retained arrow state', () => {
    const replacement = 0x12345;
    e.test_reuse_scroll_window(sized, replacement);
    assert.strictEqual(e.standard_scroll_arrows(replacement, SB_VERT), ESB_ENABLE_BOTH);
    assert.strictEqual(e.standard_scroll_arrows(replacement, SB_HORZ), ESB_ENABLE_BOTH);
  });

  check('disabled arrows paint an embossed gray glyph instead of black', () => {
    const makeDib = () => {
      const bmi = e.guest_alloc(40) >>> 0;
      const out = e.guest_alloc(4) >>> 0;
      for (let off = 0; off < 40; off += 4) e.guest_write32(bmi + off, 0);
      e.guest_write32(bmi, 40);
      e.guest_write32(bmi + 4, 16);
      e.guest_write32(bmi + 8, -16);
      e.guest_write16(bmi + 12, 1);
      e.guest_write16(bmi + 14, 32);
      const bitmap = e.test_call_CreateDIBSection(0, bmi, out) >>> 0;
      const hdc = e.test_call_CreateCompatibleDC(0) >>> 0;
      assert(bitmap && hdc);
      e.test_call_SelectObject(hdc, bitmap);
      return hdc;
    };
    const enabledDc = makeDib();
    const disabledDc = makeDib();
    e.test_draw_scroll_arrow(enabledDc, 0);
    e.test_draw_scroll_arrow(disabledDc, 1);
    assert.strictEqual(e.test_call_GetPixel(enabledDc, 8, 6) >>> 0, 0x000000);
    assert.strictEqual(e.test_call_GetPixel(disabledDc, 8, 6) >>> 0, 0x808080);
    assert.strictEqual(e.test_call_GetPixel(disabledDc, 12, 10) >>> 0, 0xffffff);
  });

  check('browser non-client hit testing honors the exported ESB mask', () => {
    function InputProbe() {}
    installInputHandlers(InputProbe);
    const probe = new InputProbe();
    const base = { min: 0, max: 9, rawMax: 9, page: 1, pos: 4, disabled: 0 };
    assert.strictEqual(probe._standardScrollbarHitPart(100, 8,
      { ...base, disabled: ESB_DISABLE_LTUP }), 0);
    assert.strictEqual(probe._standardScrollbarHitPart(100, 92,
      { ...base, disabled: ESB_DISABLE_LTUP }), 2);
    assert.strictEqual(probe._standardScrollbarHitPart(100, 92,
      { ...base, disabled: ESB_DISABLE_RTDN }), 0);
    assert(probe._standardScrollbarHitPart(100, 24,
      { ...base, disabled: ESB_DISABLE_BOTH }) >= 3,
    'disabling arrows also disabled the track');

    let sent = 0;
    const ownerWasm = { exports: {
      send_message: () => { sent++; },
      wnd_screen_w: () => 100,
      wnd_screen_h: () => 100,
      wnd_window_screen_x: () => 0,
      wnd_window_screen_y: () => 0,
      wnd_get_style_export: () => WS_VSCROLL,
      standard_scroll_min: () => 0,
      standard_scroll_max: () => 9,
      standard_scroll_page: () => 1,
      standard_scroll_pos: () => 4,
      standard_scroll_arrows: () => ESB_DISABLE_LTUP,
    } };
    assert.strictEqual(probe._handleNativeScrollbarDown(
      {}, { hwnd: 42, sx: 0, sy: 0 }, 92, 8, ownerWasm), true,
    'disabled non-client arrow did not consume the click');
    assert.strictEqual(sent, 0, 'disabled non-client arrow emitted a scroll message');
  });

  console.log(`\n${passed} passed, 0 failed`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
