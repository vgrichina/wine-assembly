#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');
const apiTable = require('../src/api_table.json');

const ROOT = path.join(__dirname, '..');
const SND_MEMORY = 0x0004;
const SND_ALIAS = 0x10000;
const SND_FILENAME = 0x20000;
const SND_RESOURCE = 0x40004;

const extraWat = String.raw`
  (func (export "test_make_api_thunk") (param $api_id i32) (result i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $THUNK_BASE)
      (i32.mul (global.get $num_thunks) (i32.const 8))))
    (i32.store (local.get $addr) (i32.const 0))
    (i32.store offset=4 (local.get $addr) (local.get $api_id))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
    (call $update_thunk_end)
    (i32.add (i32.sub (local.get $addr) (global.get $GUEST_BASE))
             (global.get $image_base)))
`;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24]
  .map(part => part & 0xff);

function makeWave() {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('RIFF'), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(Buffer.from('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  bytes.set(Buffer.from('data'), 36);
  view.setUint32(40, 4, true);
  bytes.set([0x80, 0x90, 0x70, 0x80], 44);
  return bytes;
}

async function main() {
  const wasm = compileSrcWasm((file, source) =>
    file === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, terminate_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const played = [];
  imports.host.play_sound = (wasmPtr, length) => {
    played.push(new Uint8Array(memory.buffer, wasmPtr >>> 0, length >>> 0).slice());
  };

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  ctx.exports = e;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes API dispatch');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const alloc = size => e.guest_alloc(size) >>> 0;
  const putAnsi = value => {
    const encoded = Buffer.from(`${value}\0`, 'latin1');
    const guest = alloc(encoded.length);
    bytes.set(encoded, wa(guest));
    return guest;
  };
  const putWide = value => {
    const encoded = Buffer.from(`${value}\0`, 'utf16le');
    const guest = alloc(encoded.length);
    bytes.set(encoded, wa(guest));
    return guest;
  };
  const makeCaller = name => {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} is registered`);
    const thunk = e.test_make_api_thunk(api.id) >>> 0;
    return args => {
      assert.strictEqual(args.length, api.nargs, `${name} argument count`);
      const code = [];
      for (const arg of [...args].reverse()) code.push(0x68, ...u32(arg >>> 0));
      code.push(0xb8, ...u32(thunk), 0xff, 0xd0, 0xc2, 0x10, 0x00);
      const wrapper = alloc(code.length);
      bytes.set(code, wa(wrapper));
      e.call_func(wrapper, 0, 0, 0, 0);
      for (let i = 0; i < 1000 && e.get_eip(); i++) e.run(5000);
      assert.strictEqual(e.get_eip(), 0, `${name} wrapper terminates`);
      return e.get_eax() >>> 0;
    };
  };

  const sndPlaySoundA = makeCaller('sndPlaySoundA');
  const playSoundA = makeCaller('PlaySoundA');
  const playSoundW = makeCaller('PlaySoundW');
  const wave = makeWave();
  ctx.vfs.files.set('c:\\tone.wav', { data: wave, attrs: 0x20 });
  ctx.vfs.files.set('c:\\bad.wav', {
    data: new Uint8Array(Buffer.from('not a waveform file', 'latin1')),
    attrs: 0x20,
  });
  const ansiPath = putAnsi('C:\\tone.wav');
  const widePath = putWide('C:\\tone.wav');

  assert.strictEqual(playSoundA([ansiPath, 0, SND_FILENAME]), 1,
    'PlaySoundA loads an explicit filename from the VFS');
  assert.deepStrictEqual([...played.pop()], [...wave]);
  assert.strictEqual(playSoundW([widePath, 0, SND_FILENAME]), 1,
    'PlaySoundW decodes a UTF-16 VFS filename through the same loader');
  assert.deepStrictEqual([...played.pop()], [...wave]);
  assert.strictEqual(sndPlaySoundA([ansiPath, 0]), 1,
    'sndPlaySoundA treats an unresolved event name as a filename');
  assert.deepStrictEqual([...played.pop()], [...wave]);
  assert.strictEqual(playSoundA([ansiPath, 0, 0]), 1,
    'PlaySound also applies the documented no-selector filename fallback');
  assert.deepStrictEqual([...played.pop()], [...wave]);

  const memoryWave = alloc(wave.length);
  bytes.set(wave, wa(memoryWave));
  assert.strictEqual(sndPlaySoundA([memoryWave, SND_MEMORY]), 1,
    'sndPlaySoundA submits a valid in-memory WAVE image');
  assert.deepStrictEqual([...played.pop()], [...wave]);
  assert.strictEqual(playSoundW([memoryWave, 0, SND_MEMORY]), 1,
    'PlaySoundW shares the in-memory WAVE path');
  assert.deepStrictEqual([...played.pop()], [...wave]);

  assert.strictEqual(playSoundA([putAnsi('C:\\missing.wav'), 0, SND_FILENAME]), 0,
    'a missing filename returns FALSE instead of silent success');
  assert.strictEqual(playSoundA([putAnsi('C:\\bad.wav'), 0, SND_FILENAME]), 0,
    'a non-WAVE file is rejected before reaching Web Audio');
  assert.strictEqual(sndPlaySoundA([1, SND_RESOURCE]), 0,
    'SND_RESOURCE is resolved before its overlapping SND_MEMORY bit');
  assert.strictEqual(playSoundA([putAnsi('SystemStart'), 0, SND_ALIAS]), 1,
    'explicit aliases preserve the existing accepted/no-op behavior');
  assert.strictEqual(playSoundA([0, 0, 0]), 1,
    'NULL sound keeps the existing successful stop contract');
  assert.strictEqual(played.length, 0, 'failure, alias, and stop paths submit no audio');

  console.log('PASS  PlaySoundA/W and sndPlaySoundA load VFS and memory WAV images');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
