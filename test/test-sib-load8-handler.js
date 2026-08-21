#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');

async function main() {
  const root = path.join(__dirname, '..');
  const wasmPath = path.join(root, 'build', 'wine-assembly.wasm');
  const srcDir = path.join(root, 'src');
  let wasmTime = 0;
  try { wasmTime = fs.statSync(wasmPath).mtimeMs; } catch (_) {}
  if (fs.readdirSync(srcDir).filter(name => name.endsWith('.wat'))
      .some(name => fs.statSync(path.join(srcDir, name)).mtimeMs > wasmTime)) {
    childProcess.execFileSync('bash', ['tools/build.sh'], { cwd: root, stdio: 'inherit' });
  }

  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const context = { exports: null, getMemory: () => memory.buffer };
  const imports = createHostImports(context);
  imports.host.memory = memory;
  imports.host.exit = () => {};
  imports.host.log = () => {};
  imports.host.log_i32 = () => {};
  imports.host.crash_unimplemented = () => {};
  imports.host.wait_multiple = () => 0;
  imports.host.shell_execute = () => 33;
  const bytes = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  const e = instance.exports;
  context.exports = e;

  const exe = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  e.load_pe(exe.length);
  const imageBase = e.get_image_base() >>> 0;
  const g2w = guest => (guest - imageBase + 0x12000) >>> 0;
  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const le32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
  const histogram = () => {
    const base = e.get_handler_hist_base() >>> 2;
    return new Uint32Array(memory.buffer, base << 2, e.get_handler_hist_count());
  };
  const run = (address, code, setup) => {
    mem.set(code.concat(0xc3), g2w(address));
    const stack = imageBase + 0xd00000;
    e.set_esp(stack);
    dv.setUint32(g2w(stack), 0, true);
    setup();
    e.reset_handler_hist();
    e.set_handler_hist_enabled(1);
    e.set_eip(address);
    e.run(1000);
    e.set_handler_hist_enabled(0);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe should return to the sentinel');
    return histogram();
  };

  const scratch = imageBase + 0x9000;
  const indexedCode = imageBase + 0x1100;
  mem[g2w(scratch + 0x15)] = 0x12;
  mem[g2w(scratch + 0x16)] = 0x34;
  let counts = run(indexedCode, [
    0xf9,                   // stc -- MOV must preserve flags
    0x8a, 0x5c, 0x28, 0x05, // mov bl,[eax+ebp+5]
    0x8a, 0x7c, 0x28, 0x06, // mov bh,[eax+ebp+6]
    0x0f, 0x92, 0xc2,       // setc dl
  ], () => {
    e.set_eax(scratch);
    e.set_ebp(0x10);
    e.set_ebx(0xaabbccdd);
    e.set_edx(0);
  });
  assert.strictEqual(e.get_ebx() >>> 0, 0xaabb3412,
    'fused indexed loads must update BL/BH and preserve the other bytes');
  assert.strictEqual(e.get_edx() & 0xff, 1, 'fused MOV byte loads must preserve flags');
  assert.strictEqual(counts[149] >>> 0, 2,
    'two indexed byte loads should execute through the SIB handler');
  assert.strictEqual(counts[24] >>> 0, 0,
    'indexed byte loads should not dispatch the separate absolute load8 handler');

  const absoluteCode = imageBase + 0x1200;
  mem[g2w(scratch + 0x30)] = 0x56;
  counts = run(absoluteCode, [0x8a, 0x1d, ...le32(scratch + 0x30)], () => {
    e.set_ebx(0xaabbccdd);
  });
  assert.strictEqual(e.get_ebx() >>> 0, 0xaabbcc56,
    'absolute byte loads retain their existing semantics');
  assert.strictEqual(counts[149] >>> 0, 0,
    'absolute byte loads must not be misclassified as indexed SIB loads');
  assert.strictEqual(counts[24] >>> 0, 1,
    'absolute byte loads retain the ordinary load8 handler');

  const pairedMovCode = imageBase + 0x1300;
  counts = run(pairedMovCode, [
    0xf9,             // stc -- both MOVs must preserve flags
    0x8a, 0xc1,       // mov al,cl
    0x88, 0xd4,       // mov ah,dl (opposite 88 encoding)
    0x0f, 0x92, 0xc3, // setc bl
  ], () => {
    e.set_eax(0x11223344);
    e.set_ecx(0x55667788);
    e.set_edx(0x99aabbcc);
    e.set_ebx(0);
  });
  assert.strictEqual(e.get_eax() >>> 0, 0x1122cc88,
    'a fused register-byte pair must preserve x86 source/destination order');
  assert.strictEqual(e.get_ebx() & 0xff, 1,
    'a fused register-byte pair must preserve flags');
  assert.strictEqual(counts[155] >>> 0, 1,
    'two adjacent register-byte MOVs should use one handler dispatch');

  console.log('PASS  indexed SIB loads and adjacent register-byte MOVs fuse safely');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
