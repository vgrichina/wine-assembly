#!/usr/bin/env node
'use strict';

// Heroes III's map loader spends most of its inflate loop in this exact tail:
//   dec remaining; cmp dword [esp+14h],102h; jb exit; ...; jmp loop
// Keep the stack-relative CMP/JB pair honest, including its fused handler and
// page-chain execution path, before blaming the guest's decompressor.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');

(async () => {
  const root = path.resolve(__dirname, '..');
  const wasm = fs.readFileSync(path.join(root, 'build/wine-assembly.wasm'));
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries/notepad.exe'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const context = { exports: null, getMemory: () => memory.buffer };
  const imports = createHostImports(context);
  Object.assign(imports.host, {
    memory,
    exit() {},
    log() {},
    log_i32() {},
    crash_unimplemented() {},
    wait_multiple() { return 0; },
    shell_execute() { return 33; },
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  context.exports = e;
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const g2w = guest => (guest - imageBase + guestBase) >>> 0;
  const code = imageBase + 0x1800;
  const stack = imageBase + 0xd00000;
  const view = new DataView(memory.buffer);

  bytes.set(Uint8Array.from([
    0x83, 0xec, 0x1c,                         // sub esp,1ch
    0xc7, 0x44, 0x24, 0x14, 0x00, 0x04, 0x00, 0x00, // remaining=1024
    0xc7, 0x44, 0x24, 0x10, 0x0a, 0x00, 0x00, 0x00, // input bytes=10
    0x31, 0xed,                               // xor ebp,ebp
    // loop (same instruction sequence as h3demo 0x5979c9)
    0x8b, 0x4c, 0x24, 0x14,                   // mov ecx,[esp+14h]
    0x45,                                     // inc ebp
    0x49,                                     // dec ecx
    0x89, 0x4c, 0x24, 0x14,                   // mov [esp+14h],ecx
    0x81, 0x7c, 0x24, 0x14, 0x02, 0x01, 0x00, 0x00, // cmp [esp+14h],102h
    0x72, 0x0c,                               // jb exit
    0x83, 0x7c, 0x24, 0x10, 0x0a,             // cmp [esp+10h],0ah
    0x72, 0x05,                               // jb exit
    0xe9, 0xe0, 0xff, 0xff, 0xff,             // jmp loop
    // exit
    0x89, 0xe8,                               // mov eax,ebp
    0x83, 0xc4, 0x1c,                         // add esp,1ch
    0xc3,
  ]), g2w(code));
  e.set_esp(stack);
  view.setUint32(g2w(stack), 0, true);
  e.set_eip(code);
  e.run(100000);

  assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns to sentinel');
  assert.strictEqual(e.get_eax() >>> 0, 767,
    'JB exits when unsigned remaining count falls from 258 to 257');
  console.log('PASS stack-relative CMP/JB exits the Heroes III inflate-loop shape at 257');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
