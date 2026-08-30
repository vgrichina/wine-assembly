#!/usr/bin/env node
'use strict';

// Semantic and lowering regression for MSVC's canonical x87 branch tail:
//   FNSTSW AX; TEST AH, imm8; Jcc

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_set_fpu_status") (param $sw i32) (param $top i32)
    (global.set $fpu_sw (local.get $sw))
    (global.set $fpu_top (local.get $top)))
  (func (export "test_fpu_status") (result i32) (global.get $fpu_sw))
  (func (export "test_cf") (result i32) (call $get_cf))
  (func (export "test_zf") (result i32) (call $get_zf))
  (func (export "test_sf") (result i32) (call $get_sf))
  (func (export "test_of") (result i32) (call $get_of))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({
    extraWat: EXTRA_WAT,
    fonts: 'none',
  });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = ga => (ga - imageBase + guestBase) >>> 0;
  const codeBase = (imageBase + 0x2a00) >>> 0;
  const stack = (imageBase + 0xd00000) >>> 0;
  const view = new DataView(memory.buffer);

  function run(offset, code, sw, top = 5) {
    const address = (codeBase + offset) >>> 0;
    bytes.set(Uint8Array.from(code), wa(address));
    view.setUint32(wa(stack), 0, true);
    e.test_set_fpu_status(sw, top);
    e.set_eax(0xa5a5beef);
    e.set_ecx(0);
    e.set_esp(stack);
    e.reset_handler_hist();
    e.set_handler_hist_enabled(1);
    e.set_eip(address);
    e.run(1000);
    e.set_handler_hist_enabled(0);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns to sentinel');
    const hist = new Uint32Array(
      memory.buffer,
      e.get_handler_hist_base() >>> 0,
      e.get_handler_hist_count(),
    );
    return {
      eax: e.get_eax() >>> 0,
      ecx: e.get_ecx() >>> 0,
      sw: e.test_fpu_status() >>> 0,
      cf: e.test_cf(), zf: e.test_zf(), sf: e.test_sf(), of: e.test_of(),
      h189: hist[189] >>> 0,
      h217: hist[217] >>> 0,
      h439: hist[439] >>> 0,
    };
  }

  // Short JNE. C0 is AH bit 0, so TEST AH,41h is non-zero and branches.
  const shortJne = [
    0xdf, 0xe0,                   // fnstsw ax
    0xf6, 0xc4, 0x41,             // test ah,41h
    0x75, 0x07,                   // jne taken
    0xb9, 0x11, 0x11, 0x11, 0x11, // fall: mov ecx,11111111h
    0xeb, 0x05,                   // jmp done
    0xb9, 0x22, 0x22, 0x22, 0x22, // taken: mov ecx,22222222h
    0xc3,
  ];
  let result = run(0, shortJne, 0x0100);
  assert.strictEqual(result.ecx, 0x22222222, 'C0 takes TEST AH,41h / JNE');
  assert.strictEqual(result.eax, 0xa5a52900,
    'FNSTSW preserves upper EAX and stores C bits plus current TOP');
  assert.strictEqual(result.sw, 0x2900, 'stored x87 status includes TOP=5');
  assert.deepStrictEqual(
    { cf: result.cf, zf: result.zf, sf: result.sf, of: result.of },
    { cf: 0, zf: 0, sf: 0, of: 0 },
    'TEST publishes byte-width logic flags',
  );
  assert.strictEqual(result.h439, 1, 'exact short sequence lowers to H439');
  assert.strictEqual(result.h189 + result.h217, 0,
    'fused sequence does not dispatch separate FNSTSW or TEST handlers');

  // Near JE. With no C0/C3 bits, the masked result is zero and branches.
  const nearJe = [
    0xdf, 0xe0,
    0xf6, 0xc4, 0x41,
    0x0f, 0x84, 0x07, 0x00, 0x00, 0x00,
    0xb9, 0x33, 0x33, 0x33, 0x33,
    0xeb, 0x05,
    0xb9, 0x44, 0x44, 0x44, 0x44,
    0xc3,
  ];
  result = run(0x100, nearJe, 0);
  assert.strictEqual(result.ecx, 0x44444444, 'near JE uses TEST zero result');
  assert.strictEqual(result.zf, 1, 'zero TEST result remains visible after branch');
  assert.strictEqual(result.h439, 1, 'exact near sequence also lowers to H439');

  // TEST AL is observably different and must remain three ordinary handlers.
  const nearMiss = Uint8Array.from(shortJne);
  nearMiss[3] = 0xc0;
  result = run(0x200, nearMiss, 0x0100);
  assert.strictEqual(result.h439, 0, 'TEST AL near miss is not captured');
  assert.strictEqual(result.h189, 1, 'near miss retains ordinary FNSTSW');
  assert.strictEqual(result.h217, 1, 'near miss retains ordinary TEST r8,imm8');

  console.log('PASS  FNSTSW/TEST AH/Jcc fusion preserves x87, AX, flags, and branch semantics');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
