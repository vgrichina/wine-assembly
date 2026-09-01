#!/usr/bin/env node
'use strict';

// One mode table, two APIs.
//
// IDirectDraw::EnumDisplayModes and EnumDisplaySettingsA/W must advertise the
// same display list: a game that finds a mode through one and sets it through
// the other is the common case, and two hand-maintained lists drift.
//
// What is checked here:
//   1. the table carries the three 16:9 rows (1280x720, 1600x900, 1920x1080)
//      at 8/16/32 bpp, appended so that no pre-existing raw index moved --
//      raw 18 is still 320x200x8, which Jazz Jackrabbit 2's cinematics need;
//   2. the host-canvas slot is still rounded DOWN to a multiple of 8 (measured
//      against RollerCoaster Tycoon, which leaves the trailing rows black
//      otherwise) but is now clamped to 1920x1080 rather than 1280x1024, so a
//      1920x820 window advertises 1920x816 instead of 1280x816;
//   3. EnumDisplaySettingsA/W enumerate that same list with NO holes -- the
//      documented caller loop runs iModeNum upward until FALSE, so the two
//      raw indices DirectDraw skips (320x200 at 16/32bpp, modes that never
//      existed) must not appear as a FALSE in the middle of the list;
//   4. ENUM_CURRENT_SETTINGS (-1) still reports the host canvas at 32bpp.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const dx = fs.readFileSync(path.join(__dirname, '..', 'src',
  '09a8-handlers-directx.wat'), 'utf8');
const audio = fs.readFileSync(path.join(__dirname, '..', 'src',
  '09a3-handlers-audio.wat'), 'utf8');

const extraWat = String.raw`
  (func (export "test_mode_w") (param $slot i32) (result i32)
    (call $enum_mode_res_w (local.get $slot)))
  (func (export "test_mode_h") (param $slot i32) (result i32)
    (call $enum_mode_res_h (local.get $slot)))
  (func (export "test_raw_count") (result i32) (call $enum_mode_raw_count))
  (func (export "test_raw_skipped") (param $raw i32) (result i32)
    (call $enum_mode_raw_skipped (local.get $raw)))
  (func (export "test_raw_bpp") (param $raw i32) (result i32)
    (call $enum_mode_raw_bpp (local.get $raw)))
  (func (export "test_dense_count") (result i32) (call $enum_mode_dense_count))
  (func (export "test_dense_to_raw") (param $i i32) (result i32)
    (call $enum_mode_dense_to_raw (local.get $i)))

  (func (export "test_enum_display_settings_a") (param $index i32) (param $buf i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (i32.store16 offset=36 (call $g2w (local.get $buf)) (i32.const 156))
    (call $handle_EnumDisplaySettingsA
      (i32.const 0) (local.get $index) (local.get $buf)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_enum_display_settings_w") (param $index i32) (param $buf i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (i32.store16 offset=68 (call $g2w (local.get $buf)) (i32.const 220))
    (call $handle_EnumDisplaySettingsW
      (i32.const 0) (local.get $index) (local.get $buf)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
};

// The DirectDraw enumeration, reconstructed exactly the way
// $enum_modes_dispatch reconstructs it: slot = raw/3, depth = raw%3.
function rawModes(e) {
  const out = [];
  for (let raw = 0; raw < e.test_raw_count(); raw++) {
    if (e.test_raw_skipped(raw)) continue;
    out.push({
      raw,
      w: e.test_mode_w((raw / 3) | 0),
      h: e.test_mode_h((raw / 3) | 0),
      bpp: e.test_raw_bpp(raw),
    });
  }
  return out;
}

const has = (modes, w, h, bpp) =>
  modes.some(m => m.w === w && m.h === h && m.bpp === bpp);

(async () => {
  // ── The table, on an ordinary 640x480 canvas ─────────────────────────────
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const modes = rawModes(e);

  console.log('DirectDraw advertises the widescreen rows:');
  for (const [w, h] of [[1280, 720], [1600, 900], [1920, 1080]]) {
    ok(has(modes, w, h, 8) && has(modes, w, h, 16) && has(modes, w, h, 32),
      `${w}x${h} at 8/16/32 bpp`);
  }

  console.log('Without renumbering anything that was already there:');
  ok(has(modes, 320, 200, 8), '320x200x8 is still enumerated');
  ok(modes.find(m => m.raw === 18).w === 320 &&
     modes.find(m => m.raw === 18).h === 200 &&
     modes.find(m => m.raw === 18).bpp === 8,
    'and is still raw index 18, where jazz2 found it');
  ok(!has(modes, 320, 200, 16) && !has(modes, 320, 200, 32),
    'the 320x200 slot still contributes only its 8bpp member');
  for (const [w, h] of [[640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 1024]]) {
    ok(has(modes, w, h, 8) && has(modes, w, h, 32), `${w}x${h} survives`);
  }
  // The RCT-measured rounding is not a cosmetic detail; keep it visible here
  // so a future ceiling change cannot quietly take it with it.
  ok(/i32\.and \(local\.get \$v\) \(i32\.const 0xFFF8\)/.test(dx),
    'the host slot is rounded down to a multiple of 8');
  ok(/\(func \$enum_modes_dispatch[\s\S]*?\$enum_mode_raw_skipped/.test(dx),
    'the DirectDraw dispatch steps over the raw holes rather than stopping at them');

  // ── The host-canvas slot on a 16:9 window ────────────────────────────────
  console.log('The host slot follows a widescreen canvas:');
  const wide = (await bootRenderHarness(
    { extraWat, fonts: 'none', width: 1920, height: 820 })).exports;
  ok(wide.test_mode_w(5) === 1920, 'a 1920-wide canvas advertises 1920 (was capped at 1280)');
  ok(wide.test_mode_h(5) === 816, 'an 820-tall canvas advertises 816 (rounded down to a multiple of 8)');
  const tall = (await bootRenderHarness(
    { extraWat, fonts: 'none', width: 2560, height: 1440 })).exports;
  ok(tall.test_mode_w(5) === 1920 && tall.test_mode_h(5) === 1080,
    'and anything larger clamps to 1920x1080');
  const small = (await bootRenderHarness(
    { extraWat, fonts: 'none', width: 320, height: 200 })).exports;
  ok(small.test_mode_w(5) === 640 && small.test_mode_h(5) === 480,
    'the 640x480 floor is unchanged');

  // ── EnumDisplaySettingsA/W over the same list ────────────────────────────
  console.log('EnumDisplaySettings walks the same list, without holes:');
  ok(/\$enum_mode_dense_to_raw/.test(audio) && /\$enum_mode_res_w/.test(audio),
    'and reads the DirectDraw table rather than keeping a second copy');

  const buf = e.guest_alloc(0x348) >>> 0;
  const view = new DataView(memory.buffer);
  const wasmBuf = (buf - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;

  const dense = e.test_dense_count();
  ok(dense === modes.length,
    `the dense count (${dense}) is the number of real modes (${modes.length})`);

  const seen = [];
  let holes = 0;
  for (let i = 0; i < dense; i++) {
    if (e.test_enum_display_settings_a(i, buf) !== 1) { holes++; continue; }
    seen.push({
      w: view.getUint32(wasmBuf + 108, true),
      h: view.getUint32(wasmBuf + 112, true),
      bpp: view.getUint32(wasmBuf + 104, true),
    });
  }
  ok(holes === 0, `every index 0..${dense - 1} returns TRUE (no hole truncates the loop)`);
  ok(seen.length === modes.length &&
     modes.every(m => seen.some(s => s.w === m.w && s.h === m.h && s.bpp === m.bpp)),
    'and the modes reported are exactly the DirectDraw ones');
  ok(seen.some(s => s.w === 1920 && s.h === 1080 && s.bpp === 32),
    '1920x1080x32 is reachable through EnumDisplaySettingsA');
  ok(seen.some(s => s.w === 320 && s.h === 200 && s.bpp === 8),
    'so is 320x200x8');
  ok(e.test_enum_display_settings_a(dense, buf) === 0,
    `index ${dense} ends the enumeration`);
  ok(e.test_enum_display_settings_a(dense + 50, buf) === 0,
    'and so does anything past it');
  ok(e.test_enum_display_settings_a(-2, buf) === 0,
    'ENUM_REGISTRY_SETTINGS (-2) still declines');

  console.log('ENUM_CURRENT_SETTINGS is unchanged:');
  ok(e.test_enum_display_settings_a(-1, buf) === 1, 'index -1 succeeds');
  ok(view.getUint32(wasmBuf + 108, true) === 640 &&
     view.getUint32(wasmBuf + 112, true) === 480 &&
     view.getUint32(wasmBuf + 104, true) === 32,
    'and reports the host canvas at 32bpp (640x480 here), not a table row');
  ok(view.getUint32(wasmBuf + 120, true) === 60, 'at 60 Hz');

  console.log('The Unicode entry point agrees:');
  ok(e.test_enum_display_settings_w(dense - 1, buf) === 1 &&
     e.test_enum_display_settings_w(dense, buf) === 0,
    'W enumerates the same number of modes');
  e.test_enum_display_settings_w(dense - 1, buf);
  const lastRaw = e.test_dense_to_raw(dense - 1);
  ok(view.getUint32(wasmBuf + 140, true) === e.test_mode_w((lastRaw / 3) | 0) &&
     view.getUint32(wasmBuf + 144, true) === e.test_mode_h((lastRaw / 3) | 0) &&
     view.getUint32(wasmBuf + 136, true) === e.test_raw_bpp(lastRaw),
    'and fills DEVMODEW from the same row');
  ok(e.test_enum_display_settings_w(-1, buf) === 1 &&
     view.getUint32(wasmBuf + 140, true) === 640 &&
     view.getUint32(wasmBuf + 144, true) === 480 &&
     view.getUint32(wasmBuf + 136, true) === 32,
    'W ENUM_CURRENT_SETTINGS is unchanged too');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
