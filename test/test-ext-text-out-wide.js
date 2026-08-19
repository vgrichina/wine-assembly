#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const imageBase = wat.get_image_base() >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const toWa = ga => 0x12000 + ((ga >>> 0) - imageBase);

  const writeAnsi = text => {
    const ga = wat.guest_alloc(text.length + 2) >>> 0;
    const wa = toWa(ga);
    bytes.fill(0, wa, wa + text.length + 2);
    for (let i = 0; i < text.length; i++) bytes[wa + i] = text.charCodeAt(i);
    return ga;
  };
  const writeWide = text => {
    const ga = wat.guest_alloc((text.length + 1) * 2) >>> 0;
    const wa = toWa(ga);
    const dv = new DataView(memory.buffer);
    for (let i = 0; i < text.length; i++) dv.setUint16(wa + i * 2, text.charCodeAt(i), true);
    dv.setUint16(wa + text.length * 2, 0, true);
    return ga;
  };

  const oddPacked = writeAnsi('My Computer');
  assert.strictEqual(wat.test_gdi_ext_text_out_w_packed_ansi_len(oddPacked, 6), 11,
    'Win9x status text packed into six words must recover eleven ANSI bytes');

  const evenPacked = writeAnsi('0123456789');
  assert.strictEqual(wat.test_gdi_ext_text_out_w_packed_ansi_len(evenPacked, 5), 10,
    'an even packed string may terminate immediately after the count boundary');

  const paddedPacked = writeAnsi('My Computer\\HKEY_CURRENT_USER\\Control Panel\\Desktop');
  const paddedWa = toWa(paddedPacked);
  bytes[paddedWa + 52] = 0x70;
  bytes[paddedWa + 53] = 0x72;
  bytes[paddedWa + 54] = 0x48;
  bytes[paddedWa + 55] = 0xFF;
  assert.strictEqual(wat.test_gdi_ext_text_out_w_packed_ansi_len(paddedPacked, 30), 51,
    'a bogus wide count may extend through stack padding after the ANSI terminator');

  const genuineWide = writeWide('My Computer');
  assert.strictEqual(wat.test_gdi_ext_text_out_w_packed_ansi_len(genuineWide, 11), 0,
    'ordinary UTF-16 text must stay on the wide path');

  const binary = writeAnsi('AB\x01CD');
  assert.strictEqual(wat.test_gdi_ext_text_out_w_packed_ansi_len(binary, 3), 0,
    'arbitrary binary data must not be reinterpreted as packed ANSI text');

  console.log('PASS  ExtTextOutW distinguishes packed Win9x ANSI from genuine UTF-16');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
