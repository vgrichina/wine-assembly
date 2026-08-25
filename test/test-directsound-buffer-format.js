#!/usr/bin/env node
'use strict';

// A primary DirectSound buffer is created without lpwfxFormat. Miles calls
// SetFormat and immediately reads it back; losing that state leaves its
// bytes-per-interval divisor at zero and aborts Heroes III during startup.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_dsbuf_create") (result i32)
    (call $dx_create_com_obj (i32.const 5) (global.get $DX_VTBL_DSBUF)))

  (func (export "test_dsbuf_set_format")
        (param $this i32) (param $format i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSoundBuffer_SetFormat
      (local.get $this) (local.get $format)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_dsbuf_get_format")
        (param $this i32) (param $format i32) (param $allocated i32)
        (param $written i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSoundBuffer_GetFormat
      (local.get $this) (local.get $format) (local.get $allocated)
      (local.get $written) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

async function main() {
  const wasm = await compileWat(async file => {
    const source = await fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8');
    return file === '13-exports.wat'
      ? source.replace(/\n\)\s*$/, `\n${extraWat}\n)\n`)
      : source;
  });
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: {},
  });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes guest memory and DX vtables');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const format = e.guest_alloc(18) >>> 0;
  const output = e.guest_alloc(18) >>> 0;
  const written = e.guest_alloc(4) >>> 0;
  const formatWa = wa(format);
  const outputWa = wa(output);
  const writtenWa = wa(written);
  const buffer = e.test_dsbuf_create() >>> 0;
  assert(buffer, 'DirectSound buffer fixture allocates');

  function writePcm(channels, rate, bits) {
    const align = channels * bits / 8;
    dv.setUint16(formatWa, 1, true);
    dv.setUint16(formatWa + 2, channels, true);
    dv.setUint32(formatWa + 4, rate, true);
    dv.setUint32(formatWa + 8, rate * align, true);
    dv.setUint16(formatWa + 12, align, true);
    dv.setUint16(formatWa + 14, bits, true);
    dv.setUint16(formatWa + 16, 0, true);
  }

  function readPcm() {
    return {
      tag: dv.getUint16(outputWa, true),
      channels: dv.getUint16(outputWa + 2, true),
      rate: dv.getUint32(outputWa + 4, true),
      average: dv.getUint32(outputWa + 8, true),
      align: dv.getUint16(outputWa + 12, true),
      bits: dv.getUint16(outputWa + 14, true),
      extra: dv.getUint16(outputWa + 16, true),
    };
  }

  writePcm(2, 44100, 16);
  assert.strictEqual(e.test_dsbuf_set_format(buffer, format) >>> 0, 0);
  new Uint8Array(memory.buffer).fill(0xcc, outputWa, outputWa + 18);
  dv.setUint32(writtenWa, 0, true);
  assert.strictEqual(e.test_dsbuf_get_format(buffer, output, 18, written) >>> 0, 0);
  assert.strictEqual(dv.getUint32(writtenWa, true), 18);
  assert.deepStrictEqual(readPcm(), {
    tag: 1, channels: 2, rate: 44100, average: 176400,
    align: 4, bits: 16, extra: 0,
  });

  // The NULL-output query reports the exact PCM WAVEFORMATEX allocation.
  dv.setUint32(writtenWa, 0, true);
  assert.strictEqual(e.test_dsbuf_get_format(buffer, 0, 0, written) >>> 0, 0);
  assert.strictEqual(dv.getUint32(writtenWa, true), 18);

  // Refuse a partial struct instead of overwriting the caller's allocation.
  new Uint8Array(memory.buffer).fill(0x5a, outputWa, outputWa + 18);
  assert.strictEqual(e.test_dsbuf_get_format(buffer, output, 17, written) >>> 0,
    0x80070057);
  assert.deepStrictEqual(Array.from(new Uint8Array(memory.buffer, outputWa, 18)),
    new Array(18).fill(0x5a));

  // A later primary-format change replaces all canonical PCM fields.
  writePcm(1, 22050, 8);
  assert.strictEqual(e.test_dsbuf_set_format(buffer, format) >>> 0, 0);
  assert.strictEqual(e.test_dsbuf_get_format(buffer, output, 18, written) >>> 0, 0);
  assert.deepStrictEqual(readPcm(), {
    tag: 1, channels: 1, rate: 22050, average: 22050,
    align: 1, bits: 8, extra: 0,
  });
  assert.strictEqual(e.test_dsbuf_set_format(buffer, 0) >>> 0, 0x80070057);

  console.log('PASS DirectSound primary-buffer PCM format persists and round-trips completely');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
