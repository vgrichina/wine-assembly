#!/usr/bin/env node
'use strict';

// H436 is an exact, opt-in lowering of MW3's branch-split RGB565 alpha row.
// Compare it against ordinary x86 over all three alpha arms and over two
// independently supplied frame bounds; the handler must never infer width.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_mw3_matches") (result i32)
    (global.get $loop_rgb565_alpha_matches))
  (func (export "test_mw3_runs") (result i32)
    (global.get $loop_rgb565_alpha_runs))
  (func (export "test_mw3_pixels") (result i64)
    (global.get $loop_rgb565_alpha_pixels))
  (func (export "test_mw3_cf") (result i32) (call $get_cf))
  (func (export "test_mw3_zf") (result i32) (call $get_zf))
  (func (export "test_mw3_sf") (result i32) (call $get_sf))
  (func (export "test_mw3_of") (result i32) (call $get_of))
  (func (export "test_copy_emit_enabled") (result i32)
    (call $loop_copy_emit_get))
`;

const LOOP_EIP = 0x00528064;
const EXIT_EIP = 0x00528111;

function peBytesAt(file, va, length) {
  const data = fs.readFileSync(file);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pe = view.getUint32(0x3c, true);
  const sections = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const imageBase = view.getUint32(pe + 24 + 28, true);
  const table = pe + 24 + optionalSize;
  const rva = (va - imageBase) >>> 0;
  for (let i = 0; i < sections; i++) {
    const entry = table + i * 40;
    const virtualSize = view.getUint32(entry + 8, true);
    const virtualAddress = view.getUint32(entry + 12, true);
    if (rva < virtualAddress || rva + length > virtualAddress + virtualSize) continue;
    const raw = view.getUint32(entry + 20, true) + rva - virtualAddress;
    return Uint8Array.from(data.subarray(raw, raw + length));
  }
  throw new Error(`VA 0x${va.toString(16)} is outside the PE sections`);
}

const mw3Exe = path.join(__dirname, '..', 'binaries', 'shareware', 'mw3', 'ex',
  'Program_Files', 'mech3demo.exe');
const authenticLoop = peBytesAt(mw3Exe, LOOP_EIP, EXIT_EIP - LOOP_EIP);

async function makeRuntime({ enabled, nearMiss = false }) {
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => e.guest_to_wasm
    ? e.guest_to_wasm(guest) >>> 0
    : (guest - imageBase + guestBase) >>> 0;
  const loop = Uint8Array.from(authenticLoop);
  if (nearMiss) loop[7] = 2; // cmp cl,3 -> cmp cl,2: valid x86, not the proven loop.
  bytes.set(loop, wa(LOOP_EIP));
  bytes[wa(EXIT_EIP)] = 0xc3; // isolate the row from MW3's outer rectangle loop.
  e.set_loop_copy_emit(enabled ? 1 : 0);

  const arena = e.guest_alloc(0x10000) >>> 0;
  bytes = new Uint8Array(memory.buffer);
  const frame = (arena + 0x200) >>> 0;
  const stack = (arena + 0x400) >>> 0;
  const alphaBase = (arena + 0x1000) >>> 0;
  const srcBase = (arena + 0x3000) >>> 0;
  const dstBase = (arena + 0x5000) >>> 0;
  const seed = Uint8Array.from({ length: 128 }, (_, i) => (i * 53 + 17) & 0xff);

  function run(count, salt) {
    const alpha = Uint8Array.from({ length: count }, (_, i) =>
      [0, 3, 4, 0x37, 0x80, 0xfb, 0xfc, 0xff][(i + salt) & 7]);
    bytes.set(alpha, wa(alphaBase));
    bytes.set(seed.subarray(0, count * 2), wa(srcBase));
    bytes.set(seed.subarray(32, 32 + count * 2), wa(dstBase));
    dv.setUint32(wa(frame + 12), alphaBase, true);
    dv.setInt32(wa(frame - 24), count, true);
    dv.setUint32(wa(frame - 32), dstBase, true);
    dv.setInt32(wa(frame - 28), srcBase - dstBase, true);
    dv.setUint32(wa(frame - 12), 0x13579bdf, true);
    dv.setUint32(wa(frame - 20), 0x2468ace0, true);
    dv.setUint32(wa(stack), 0, true);

    e.set_eax(dstBase); e.set_ecx(0xaabbccdd); e.set_edx(0x2468ace0);
    e.set_ebx(0x13579bdf); e.set_esp(stack); e.set_ebp(frame);
    e.set_esi(0x10203040); e.set_edi((srcBase - dstBase) >>> 0);
    e.set_eip(LOOP_EIP); e.run(1000000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'isolated row returns');
    return {
      pixels: Array.from(bytes.subarray(wa(dstBase), wa(dstBase) + count * 2)),
      state: {
        eax: e.get_eax() >>> 0, ecx: e.get_ecx() >>> 0,
        edx: e.get_edx() >>> 0, ebx: e.get_ebx() >>> 0,
        esp: e.get_esp() >>> 0, ebp: e.get_ebp() >>> 0,
        esi: e.get_esi() >>> 0, edi: e.get_edi() >>> 0,
        cf: e.test_mw3_cf(), zf: e.test_mw3_zf(),
        sf: e.test_mw3_sf(), of: e.test_mw3_of(),
        frameCount: dv.getInt32(wa(frame - 24), true),
        frameDst: dv.getUint32(wa(frame - 32), true),
        frameAlpha: dv.getUint32(wa(frame + 12), true),
      },
    };
  }
  return { e, run };
}

(async () => {
  const sharedMemory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });
  const sharedMain = await bootRenderHarness({
    extraWat: EXTRA_WAT, fonts: 'none', memory: sharedMemory,
  });
  const sharedThread = await bootRenderHarness({
    extraWat: EXTRA_WAT, fonts: 'none', memory: sharedMemory,
  });
  sharedMain.exports.set_loop_copy_emit(1);
  assert.strictEqual(sharedThread.exports.test_copy_emit_enabled(), 1,
    'guest-worker decoder sees the main instance copy-superop opt-in');
  sharedThread.exports.set_loop_copy_emit(0);
  assert.strictEqual(sharedMain.exports.test_copy_emit_enabled(), 0,
    'copy-superop rollback from a guest worker is process-wide');

  const ordinary = await makeRuntime({ enabled: false });
  const fused = await makeRuntime({ enabled: true });
  for (const [count, salt] of [[8, 0], [37, 3]]) {
    const expected = ordinary.run(count, salt);
    const actual = fused.run(count, salt);
    assert.deepStrictEqual(actual.pixels, expected.pixels,
      `H436 pixels must match ordinary x86 for frame bound ${count}`);
    assert.deepStrictEqual(actual.state, expected.state,
      `H436 register/flag/frame state must match ordinary x86 for bound ${count}`);
  }
  assert.strictEqual(ordinary.e.test_mw3_matches(), 0,
    'disabled opt-in leaves the authentic block ordinary');
  assert.strictEqual(fused.e.test_mw3_matches(), 1,
    'enabled authentic block is recognized once and cached');
  assert.strictEqual(fused.e.test_mw3_runs(), 2,
    'each independently supplied row bound enters H436 once');
  assert.strictEqual(fused.e.test_mw3_pixels(), 45n,
    'H436 derives exactly 8 + 37 pixels from the two guest frame bounds');

  const near = await makeRuntime({ enabled: true, nearMiss: true });
  near.run(8, 0);
  assert.strictEqual(near.e.test_mw3_matches(), 0,
    'valid cmp-immediate near miss remains on ordinary x86');
  assert.strictEqual(near.e.test_mw3_runs(), 0,
    'near miss never reaches H436');

  console.log('PASS  MW3 RGB565 H436 is exact, opt-in, bound-derived, and byte-identical');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
