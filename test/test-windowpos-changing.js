#!/usr/bin/env node

'use strict';

// USER exposes a mutable WINDOWPOS before committing SetWindowPos/MoveWindow,
// then sends the final structure afterward. WM_MOVE/WM_SIZE belong to
// DefWindowProc's WM_WINDOWPOSCHANGED path, not to SetWindowPos itself.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const WM_MOVE = 0x0003;
const WM_SIZE = 0x0005;
const WM_WINDOWPOSCHANGING = 0x0046;
const WM_WINDOWPOSCHANGED = 0x0047;
const SWP_NOREDRAW = 0x0008;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOZORDER = 0x0004;
const SWP_NOSENDCHANGING = 0x0400;

const COUNT = 0;
const MESSAGES = 4;
const LPARAMS = 36;
const XS = 68;
const YS = 100;
const CXS = 132;
const CYS = 164;
const FLAGS = 196;
const OBSERVED_BYTES = 228;

const pack = (low, high) => ((low & 0xffff) | ((high & 0xffff) << 16)) >>> 0;
const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);

function makeWndProc(observed) {
  const code = [];
  const labels = new Map();
  const fixups = [];
  const emit = (...bytes) => code.push(...bytes.map(byte => byte & 0xff));
  const label = name => labels.set(name, code.length);
  const jcc = (opcode, name) => {
    emit(0x0f, opcode, 0, 0, 0, 0);
    fixups.push({ at: code.length - 4, name });
  };
  const jump = name => {
    emit(0xe9, 0, 0, 0, 0);
    fixups.push({ at: code.length - 4, name });
  };
  const storeIndexedEax = address => emit(0x89, 0x04, 0x95, ...u32(address));
  const recordWindowPos = () => {
    emit(0x8b, 0x4c, 0x24, 0x10); // mov ecx,[esp+16] (WINDOWPOS*)
    for (const [offset, base] of [
      [8, XS], [12, YS], [16, CXS], [20, CYS], [24, FLAGS],
    ]) {
      emit(0x8b, 0x41, offset); // mov eax,[ecx+offset]
      storeIndexedEax(observed + base);
    }
  };

  emit(0x8b, 0x44, 0x24, 0x08); // mov eax,[esp+8] (message)
  emit(0x8b, 0x15, ...u32(observed + COUNT)); // mov edx,[count]
  storeIndexedEax(observed + MESSAGES);
  emit(0x8b, 0x44, 0x24, 0x10); // mov eax,[esp+16] (lParam)
  storeIndexedEax(observed + LPARAMS);
  emit(0x8b, 0x44, 0x24, 0x08); // reload message
  emit(0x83, 0xf8, WM_WINDOWPOSCHANGING);
  jcc(0x84, 'changing'); // je
  emit(0x83, 0xf8, WM_WINDOWPOSCHANGED);
  jcc(0x84, 'changed');
  jump('finish');

  label('changing');
  recordWindowPos();
  // The window changes every mutable field and attempts to clear
  // SWP_NOACTIVATE. USER must commit these values but preserve NOACTIVATE.
  emit(0xc7, 0x41, 0x04, ...u32(1));   // hwndInsertAfter = HWND_BOTTOM
  emit(0xc7, 0x41, 0x08, ...u32(111)); // x
  emit(0xc7, 0x41, 0x0c, ...u32(112)); // y
  emit(0xc7, 0x41, 0x10, ...u32(113)); // cx
  emit(0xc7, 0x41, 0x14, ...u32(114)); // cy
  emit(0xc7, 0x41, 0x18, ...u32(SWP_NOZORDER | SWP_NOREDRAW));
  jump('finish');

  label('changed');
  recordWindowPos();

  label('finish');
  emit(0x42); // inc edx
  emit(0x89, 0x15, ...u32(observed + COUNT)); // mov [count],edx
  emit(0x31, 0xc0); // xor eax,eax
  emit(0xc2, 0x10, 0x00); // ret 16

  for (const fixup of fixups) {
    const target = labels.get(fixup.name);
    assert.notStrictEqual(target, undefined, `missing x86 label ${fixup.name}`);
    const relative = (target - (fixup.at + 4)) | 0;
    code[fixup.at] = relative & 0xff;
    code[fixup.at + 1] = relative >>> 8 & 0xff;
    code[fixup.at + 2] = relative >>> 16 & 0xff;
    code[fixup.at + 3] = relative >>> 24 & 0xff;
  }
  return Uint8Array.from(code);
}

const extraWat = String.raw`
  (func (export "test_make_window") (param $proc i32) (result i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x10000000)))
    (local.get $hwnd))

  (func (export "test_call_SetWindowPos")
      (param $hwnd i32) (param $x i32) (param $y i32)
      (param $cx i32) (param $cy i32) (param $flags i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $cy))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $flags))
    (call $handle_SetWindowPos
      (local.get $hwnd) (i32.const 0) (local.get $x) (local.get $y)
      (local.get $cx) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_MoveWindow")
      (param $hwnd i32) (param $x i32) (param $y i32)
      (param $cx i32) (param $cy i32) (param $repaint i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $repaint))
    (call $handle_MoveWindow
      (local.get $hwnd) (local.get $x) (local.get $y)
      (local.get $cx) (local.get $cy) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_BeginDeferWindowPos") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BeginDeferWindowPos
      (i32.const 1) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DeferWindowPos")
      (param $hdwp i32) (param $hwnd i32)
      (param $x i32) (param $y i32) (param $cx i32) (param $cy i32)
      (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $cx))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $cy))
    (call $gs32 (i32.add (global.get $esp) (i32.const 32)) (i32.const 0x14))
    (call $handle_DeferWindowPos
      (local.get $hdwp) (local.get $hwnd) (i32.const 0)
      (local.get $x) (local.get $y) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_EndDeferWindowPos") (param $hdwp i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EndDeferWindowPos
      (local.get $hdwp) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DefWindowProc")
      (param $hwnd i32) (param $windowpos i32) (param $wide i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (if (local.get $wide)
      (then
        (call $handle_DefWindowProcW
          (local.get $hwnd) (i32.const 0x0047) (i32.const 0)
          (local.get $windowpos) (i32.const 0) (i32.const 0)))
      (else
        (call $handle_DefWindowProcA
          (local.get $hwnd) (i32.const 0x0047) (i32.const 0)
          (local.get $windowpos) (i32.const 0) (i32.const 0))))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const sizes = new Map();
  const positions = new Map();
  const moves = [];
  let memory;
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      get_window_client_size(hwnd) {
        return sizes.get(hwnd >>> 0) || 0;
      },
      move_window(hwnd, x, y, cx, cy, flags) {
        hwnd >>>= 0;
        flags >>>= 0;
        const oldXY = positions.get(hwnd) || 0;
        const oldWH = sizes.get(hwnd) || 0;
        const nextX = flags & 2 ? oldXY << 16 >> 16 : x;
        const nextY = flags & 2 ? oldXY >> 16 : y;
        const nextCX = flags & 1 ? oldWH & 0xffff : cx;
        const nextCY = flags & 1 ? oldWH >>> 16 : cy;
        positions.set(hwnd, pack(nextX, nextY));
        sizes.set(hwnd, pack(nextCX, nextCY));
        moves.push({ hwnd, x, y, cx, cy, flags });
      },
      get_window_rect(hwnd, out) {
        const xy = positions.get(hwnd >>> 0) || 0;
        const wh = sizes.get(hwnd >>> 0) || 0;
        const view = new DataView(memory.buffer);
        const x = xy << 16 >> 16;
        const y = xy >> 16;
        view.setInt32(out, x, true);
        view.setInt32(out + 4, y, true);
        view.setInt32(out + 8, x + (wh & 0xffff), true);
        view.setInt32(out + 12, y + (wh >>> 16), true);
      },
    },
  });
  const e = harness.exports;
  memory = harness.memory;

  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes synchronous wndproc dispatch');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const observed = e.guest_alloc(OBSERVED_BYTES) >>> 0;
  const proc = e.guest_alloc(512) >>> 0;
  bytes.set(makeWndProc(observed), toWasm(proc));

  const hwnd = e.test_make_window(proc) >>> 0;
  positions.set(hwnd, pack(0, 0));
  sizes.set(hwnd, pack(40, 20));

  const clearObserved = () => bytes.fill(0, toWasm(observed), toWasm(observed) + OBSERVED_BYTES);
  const read = (base, index = 0) => view.getUint32(toWasm(observed + base + index * 4), true);
  const messages = () => Array.from({ length: read(COUNT) }, (_, index) => read(MESSAGES, index));

  clearObserved();
  moves.length = 0;
  assert.strictEqual(e.test_call_SetWindowPos(hwnd, 10, 12, 80, 30, 0x14), 1);
  assert.deepStrictEqual(messages(), [WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED],
    'SetWindowPos sends changing before changed and does not synthesize geometry messages');
  assert.strictEqual(read(XS, 0), 10, 'changing sees the caller-proposed x');
  assert.strictEqual(read(CXS, 0), 80, 'changing sees the caller-proposed width');
  assert.strictEqual(read(FLAGS, 0), 0x14, 'changing sees the caller flags');
  assert.deepStrictEqual(moves[0], {
    hwnd, x: 111, y: 112, cx: 113, cy: 114,
    flags: SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOREDRAW,
  }, 'SetWindowPos commits mutable WINDOWPOS fields while preserving NOACTIVATE');
  assert.strictEqual(read(XS, 1), 111, 'changed sees the committed x');
  assert.strictEqual(read(CYS, 1), 114, 'changed sees the committed height');
  assert.strictEqual(read(FLAGS, 1), 0x1c, 'changed sees the effective flags');

  clearObserved();
  moves.length = 0;
  assert.strictEqual(
    e.test_call_SetWindowPos(hwnd, 21, 22, 81, 31, 0x14 | SWP_NOSENDCHANGING), 1);
  assert.deepStrictEqual(messages(), [WM_WINDOWPOSCHANGED],
    'SWP_NOSENDCHANGING suppresses only the mutable changing message');
  assert.deepStrictEqual(moves[0], {
    hwnd, x: 21, y: 22, cx: 81, cy: 31, flags: 0x414,
  }, 'without changing notification the caller values commit unchanged');
  assert.strictEqual(read(XS, 0), 21, 'changed still carries the committed caller value');

  clearObserved();
  moves.length = 0;
  assert.strictEqual(e.test_call_MoveWindow(hwnd, 30, 32, 90, 35, 1), 1);
  assert.deepStrictEqual(messages(), [WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED],
    'MoveWindow uses the same changing/changed transaction');
  assert.deepStrictEqual(moves[0], {
    hwnd, x: 111, y: 112, cx: 113, cy: 114, flags: 0x1c,
  }, 'MoveWindow commits the mutable WINDOWPOS and protected NOACTIVATE');

  // Move away without a changing callback, then prove deferred positioning
  // stays inert through Defer and inherits the transaction only at End.
  e.test_call_SetWindowPos(hwnd, 50, 52, 70, 25, 0x14 | SWP_NOSENDCHANGING);
  clearObserved();
  moves.length = 0;
  const hdwp = e.test_call_BeginDeferWindowPos() >>> 0;
  assert(hdwp, 'BeginDeferWindowPos succeeds');
  assert.strictEqual(e.test_call_DeferWindowPos(hdwp, hwnd, 60, 62, 75, 28) >>> 0, hdwp);
  assert.deepStrictEqual(messages(), [], 'DeferWindowPos sends nothing before End');
  assert.deepStrictEqual(moves, [], 'DeferWindowPos changes no geometry before End');
  assert.strictEqual(e.test_call_EndDeferWindowPos(hdwp), 1);
  assert.deepStrictEqual(messages(), [WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED],
    'EndDeferWindowPos commits through the same message transaction');
  assert.strictEqual(moves[0].x, 111, 'deferred commit honors changing mutation');

  // A wndproc that consumed WM_WINDOWPOSCHANGED above got no WM_MOVE/WM_SIZE.
  // Calling either DefWindowProc spelling is what derives them synchronously.
  const windowpos = e.guest_alloc(28) >>> 0;
  const wp = toWasm(windowpos);
  view.setUint32(wp, hwnd, true);
  view.setUint32(wp + 24, 0, true);
  clearObserved();
  assert.strictEqual(e.test_call_DefWindowProc(hwnd, windowpos, 0), 0);
  assert.deepStrictEqual(messages(), [WM_MOVE, WM_SIZE],
    'DefWindowProcA derives synchronous WM_MOVE then WM_SIZE');
  assert.strictEqual(read(LPARAMS, 0), pack(111, 112), 'WM_MOVE carries the client origin');
  assert.strictEqual(read(LPARAMS, 1), pack(113, 114), 'WM_SIZE carries the client dimensions');

  view.setUint32(wp + 24, 2, true); // SWP_NOMOVE
  clearObserved();
  assert.strictEqual(e.test_call_DefWindowProc(hwnd, windowpos, 1), 0);
  assert.deepStrictEqual(messages(), [WM_SIZE],
    'DefWindowProcW shares flag-sensitive geometry derivation');

  console.log('PASS  WINDOWPOS changing/changed mutation and DefWindowProc geometry semantics');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
