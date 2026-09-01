#!/usr/bin/env node
'use strict';

// XP winmine's "you have the fastest time -- enter your name" dialog is
// RT_DIALOG 600. `node tools/dlg-dump.js test/binaries/xp/winmine.exe` reads it
// as
//
//   style 0x80400040  WS_POPUP | WS_DLGFRAME | DS_SETFONT
//   rect  x=0 y=28 cx=100 cy=100 (dialog units)
//
// which is the whole test in two lines:
//
//   1. WS_DLGFRAME with neither WS_BORDER nor WS_CAPTION is still a *framed*
//      window. $defwndproc_do_nccalcsize only counted WS_BORDER, so the
//      client rect came back as the entire window rect, $dc_apply_nc_clip
//      excluded all of it, and every pixel $defwndproc_ncpaint drew -- the
//      btnFace fill and the raised 3D edge -- was clipped away. The dialog
//      rendered as a flat grey slab with no border at all.
//
//   2. A template's x/y are dialog units measured from the upper-left corner
//      of the OWNER's client area unless DS_ABSALIGN is set. Nothing added
//      that offset, so the dialog opened at screen (0, 45) in the top-left
//      corner of the desktop instead of over the minesweeper board.
//
// Both assertions run the real $handle_DialogBoxParamA against winmine's own
// resource, so the template is ground truth rather than a hand-built fixture.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness, writePng } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'xp', 'winmine.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  xp/winmine.exe not found at', EXE);
  process.exit(0);
}

// The owner stands in for the minesweeper main window: a normal captioned,
// sizable top-level at a known place, so "relative to the owner's client area"
// has a number attached to it.
const OWNER = { x: 200, y: 100, w: 164, h: 220, style: 0x00CF0000 | 0x10000000 };
const NAME_DIALOG_ID = 600;

const extraWat = String.raw`
  ;; Register a plain top-level window in the WAT tables. The renderer side is
  ;; built by the test so $host_get_window_rect has a rect to report.
  (func (export "test_make_owner") (param $style i32) (result i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_BUILTIN))
    (drop (call $wnd_set_style (local.get $hwnd) (local.get $style)))
    (global.set $main_hwnd (local.get $hwnd))
    (local.get $hwnd))

  (func (export "test_nccalcsize") (param $hwnd i32)
    (call $defwndproc_do_nccalcsize (local.get $hwnd)))

  (func (export "test_ncpaint") (param $hwnd i32)
    (call $defwndproc_do_ncpaint (local.get $hwnd)))

  ;; A direct handler call has no stdcall frame under it, so preserve the
  ;; harness stack around the handler's own 24-byte cleanup.
  (func (export "test_dialog_box_param") (param $id i32) (param $owner i32)
        (param $dlgproc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DialogBoxParamA
      (i32.const 0) (local.get $id) (local.get $owner)
      (local.get $dlgproc) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $dlg_hwnd))

  (func (export "test_dlg_template_style") (param $hwnd i32) (result i32)
    (i32.load offset=4 (call $dlg_record_addr (call $wnd_table_find (local.get $hwnd)))))
`;

(async () => {
  const harness = await bootRenderHarness({ extraWat, fonts: 'none' });
  const { exports: e, renderer } = harness;

  const fixture = fs.readFileSync(EXE);
  new Uint8Array(harness.memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'winmine.exe loads into the harness');

  // Owner: WAT record + the renderer window $host_get_window_rect reads.
  const owner = e.test_make_owner(OWNER.style) >>> 0;
  renderer.windows[owner] = {
    hwnd: owner, style: OWNER.style, title: 'Minesweeper',
    x: OWNER.x, y: OWNER.y, w: OWNER.w, h: OWNER.h,
    visible: true, isChild: false, parentHwnd: 0, ownerHwnd: 0,
    zOrder: 1, wasm: harness.instance, wasmMemory: harness.memory,
  };
  renderer._computeClientRect(renderer.windows[owner]);
  e.test_nccalcsize(owner);

  const ownerClientX = OWNER.x + (e.get_client_rect_l(owner) | 0);
  const ownerClientY = OWNER.y + (e.get_client_rect_t(owner) | 0);

  // The controls' WM_CREATE notifications reach the DLGPROC for real
  // ($dialog_default_proc -> $wnd_send_message -> $run), so it has to be
  // executable x86. `xor eax,eax; ret 0x10` is a DLGPROC that declines every
  // message, which is what a default DlgProc return of FALSE means.
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const dlgProc = e.guest_alloc(16) >>> 0;
  new Uint8Array(harness.memory.buffer).set(
    [0x31, 0xC0, 0xC2, 0x10, 0x00], dlgProc - imageBase + guestBase);

  const dlg = e.test_dialog_box_param(NAME_DIALOG_ID, owner, dlgProc) >>> 0;
  assert(dlg, 'DialogBoxParamA allocated an HWND for RT_DIALOG 600');

  const templateStyle = e.test_dlg_template_style(dlg) >>> 0;
  let failures = 0;
  const check = (label, got, want) => {
    if (got === want) { console.log(`PASS  ${label} = ${got}`); return; }
    failures += 1;
    console.log(`FAIL  ${label} = ${got}, want ${want}`);
  };

  // Guard the premise: this is the template the bug report is about.
  assert.strictEqual(templateStyle, 0x80400040,
    `RT_DIALOG 600 template style changed: 0x${templateStyle.toString(16)}`);
  assert.strictEqual(templateStyle & 0x00C00000, 0x00400000,
    'template is WS_DLGFRAME without WS_CAPTION');

  // --- 1. the frame -------------------------------------------------------
  // A framed window's client rect is inset from its window rect. When it is
  // not, $dc_apply_nc_clip has nothing to draw the border into.
  const cl = e.get_client_rect_l(dlg) | 0;
  const ct = e.get_client_rect_t(dlg) | 0;
  console.log(`      dialog client rect inset l=${cl} t=${ct}`);
  check('WS_DLGFRAME dialog reserves a left non-client band', cl > 0, true);
  check('WS_DLGFRAME dialog reserves a top non-client band', ct > 0, true);
  // ...but no caption band: the template has no WS_CAPTION, so a title bar
  // here would be chrome real USER does not draw either.
  check('WS_DLGFRAME dialog reserves no caption strip', ct < 19, true);

  // --- 2. the position ----------------------------------------------------
  const win = renderer.windows[dlg];
  assert(win, 'renderer mirrored the dialog window');
  console.log(`      owner client origin ${ownerClientX},${ownerClientY}; ` +
    `dialog at ${win.x},${win.y}`);
  check('dialog x is owner-client relative', win.x, ownerClientX);
  check('dialog y is owner-client relative + 28 dialog units',
    win.y, ownerClientY + Math.round(28 * renderer.dluY));

  // --- 3. the pixels ------------------------------------------------------
  // The client-rect inset above is the cause; this is the effect. A fixed
  // dialog frame is SM_CXDLGFRAME = 3, drawn as EDGE_RAISED over the whole
  // window rect, so the outermost top-left pixel is 3DHILIGHT and the
  // outermost bottom-right is 3DDKSHADOW. Before the fix both were the flat
  // btnFace the background fill left behind.
  e.test_ncpaint(dlg);
  renderer.repaint();
  const image = renderer.canvas.getContext('2d')
    .getImageData(0, 0, renderer.canvas.width, renderer.canvas.height).data;
  const at = (px, py) => {
    const i = (py * renderer.canvas.width + px) * 4;
    return (image[i] << 16) | (image[i + 1] << 8) | image[i + 2];
  };
  const hex = c => `#${c.toString(16).padStart(6, '0')}`;
  const topLeft = at(win.x + 1, win.y);
  const bottomRight = at(win.x + win.w - 1, win.y + win.h - 2);
  console.log(`      frame top-left ${hex(topLeft)} bottom-right ${hex(bottomRight)}`);
  check('frame top edge is 3DHILIGHT', hex(topLeft), hex(0xFFFFFF));
  check('frame bottom edge is 3DDKSHADOW', hex(bottomRight), hex(0x000000));

  console.log('wrote ' + writePng(renderer.canvas, 'winmine-name-dialog.png'));

  if (failures) {
    console.log(`\nFAIL  ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nPASS  winmine RT_DIALOG 600 gets a dialog frame and an owner-relative origin');
})().catch(err => { console.error(err); process.exit(1); });
