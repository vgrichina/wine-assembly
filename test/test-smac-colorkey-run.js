#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_colorkey8_cf") (result i32) (call $get_cf))
  (func (export "test_colorkey8_zf") (result i32) (call $get_zf))
  (func (export "test_colorkey8_sf") (result i32) (call $get_sf))
  (func (export "test_colorkey8_of") (result i32) (call $get_of))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = ga => e.test_g2w ? e.test_g2w(ga) >>> 0 : (ga - imageBase + guestBase) >>> 0;
  const code = (imageBase + 0x2800) >>> 0;
  const data = e.guest_alloc(0x1000) >>> 0;
  const loop = Uint8Array.from([
    0x38, 0x27,       // cmp byte [edi],ah
    0x75, 0x02,       // jne induction
    0x88, 0x07,       // mov byte [edi],al
    0x47,             // inc edi
    0x4e,             // dec esi
    0x75, 0xf6,       // jne loop
  ]);
  bytes = new Uint8Array(memory.buffer);
  bytes.set(loop, wa(code));
  bytes.set([0x55, 0x10, 0x55, 0x20, 0x55], wa(data));

  e.set_eip(code);
  e.set_eax(0x000055aa); // AH=key 0x55, AL=replacement 0xaa
  e.set_esi(5);
  e.set_edi(data);
  const matches = e.get_loop_colorkey8_matches();
  const runs = e.get_loop_colorkey8_runs();
  const foldedBytes = e.get_loop_colorkey8_bytes();
  e.run(1);

  assert.strictEqual(e.get_loop_colorkey8_matches(), matches + 1, 'authentic loop matched');
  assert.strictEqual(e.get_loop_colorkey8_runs(), runs + 1, 'folded row executed once');
  assert.strictEqual(e.get_loop_colorkey8_bytes(), foldedBytes + 5n, 'five pixels folded');
  assert.deepStrictEqual(Array.from(new Uint8Array(memory.buffer, wa(data), 5)),
    [0xaa, 0x10, 0xaa, 0x20, 0xaa], 'only key-colored bytes replaced');
  assert.strictEqual(e.get_edi() >>> 0, data + 5, 'EDI advances across row');
  assert.strictEqual(e.get_esi() >>> 0, 0, 'ESI counts down to zero');
  assert.strictEqual(e.get_eip() >>> 0, code + 10, 'execution continues after row');
  assert.strictEqual(e.test_colorkey8_zf(), 1, 'final DEC sets ZF');
  assert.strictEqual(e.test_colorkey8_sf(), 0, 'final DEC clears SF');
  assert.strictEqual(e.test_colorkey8_of(), 0, 'final DEC clears OF');
  assert.strictEqual(e.test_colorkey8_cf(), 0, 'final CMP carry survives INC/DEC');

  // One changed interior byte must leave the block on the ordinary decoder.
  const nearCode = code + 0x100;
  const near = Uint8Array.from(loop);
  near[4] = 0x90;
  bytes.set(near, wa(nearCode));
  e.set_eip(nearCode);
  e.set_eax(0x000055aa);
  e.set_esi(1);
  e.set_edi(data);
  const nearMatches = e.get_loop_colorkey8_matches();
  e.run(1);
  assert.strictEqual(e.get_loop_colorkey8_matches(), nearMatches,
    'near miss remains ordinary x86');

  console.log('PASS Alpha Centauri byte color-key row superinstruction');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
