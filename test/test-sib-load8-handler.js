#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
// $GUEST_BASE, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

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
  const context = { exports: null, getMemory: () => memory.buffer, guestNowMs: () => 1234 };
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
  const g2w = guest => RegionMap.g2w(guest, imageBase);
  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const le32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
  const histogram = () => {
    const base = e.get_handler_hist_base() >>> 2;
    return new Uint32Array(memory.buffer, base << 2, e.get_handler_hist_count());
  };
  const run = (address, code, setup, useHistogram = true) => {
    mem.set(code.concat(0xc3), g2w(address));
    const stack = imageBase + 0xd00000;
    e.set_esp(stack);
    dv.setUint32(g2w(stack), 0, true);
    setup();
    if (useHistogram) {
      e.reset_handler_hist();
      e.set_handler_hist_enabled(1);
    }
    e.set_eip(address);
    e.run(1000);
    if (useHistogram) e.set_handler_hist_enabled(0);
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

  const indexedLoad32Code = imageBase + 0x1250;
  const stack = imageBase + 0xd00000;
  dv.setUint32(g2w(stack + 0x2c), 0x89abcdef, true);
  counts = run(indexedLoad32Code, [
    0xf9,                   // stc -- MOV must preserve flags
    0x8b, 0x74, 0x8c, 0x20, // mov esi,[esp+ecx*4+0x20]
    0x0f, 0x92, 0xc2,       // setc dl
  ], () => {
    e.set_ecx(3);
    e.set_esi(0);
    e.set_edx(0);
  }, false);
  assert.strictEqual(e.get_esi() >>> 0, 0x89abcdef,
    'fused indexed dword loads must use the full SIB effective address');
  assert.strictEqual(e.get_edx() & 0xff, 1,
    'fused indexed dword loads must preserve flags');

  const loadTestCode = imageBase + 0x1260;
  dv.setUint32(g2w(scratch + 0x40), 0x80000010, true);
  run(loadTestCode, [
    0x8b, 0x42, 0x40,       // mov eax,[edx+0x40]
    0xa9, 0x00, 0x00, 0x00, 0x80, // test eax,0x80000000
    0x0f, 0x94, 0xc1,       // setz cl
    0x0f, 0x92, 0xc3,       // setc bl -- TEST clears carry
  ], () => {
    e.set_eax(0);
    e.set_ecx(0xff);
    e.set_edx(scratch);
    e.set_ebx(0xff);
  }, false);
  assert.strictEqual(e.get_eax() >>> 0, 0x80000010,
    'fused load/TEST must retain the loaded EAX value');
  assert.strictEqual(e.get_ecx() & 0xff, 0,
    'fused load/TEST must publish the nonzero TEST result');
  assert.strictEqual(e.get_ebx() & 0xff, 0,
    'fused load/TEST must clear carry like TEST');

  const addLoadTestCode = imageBase + 0x1270;
  dv.setUint32(g2w(scratch + 0x50), 0x00000020, true);
  run(addLoadTestCode, [
    0x03, 0xd0,             // add edx,eax
    0x8b, 0x02,             // mov eax,[edx]
    0xa9, 0x20, 0x00, 0x00, 0x00, // test eax,0x20
    0x0f, 0x94, 0xc1,       // setz cl
    0x0f, 0x92, 0xc3,       // setc bl
  ], () => {
    e.set_eax(0x10);
    e.set_ecx(0xff);
    e.set_edx(scratch + 0x40);
    e.set_ebx(0xff);
  }, false);
  assert.strictEqual(e.get_edx() >>> 0, (scratch + 0x50) >>> 0,
    'fused ADD/load/TEST must retain ADD\'s destination');
  assert.strictEqual(e.get_eax() >>> 0, 0x20,
    'fused ADD/load/TEST must load through the updated EDX');
  assert.strictEqual(e.get_ecx() & 0xff, 0,
    'fused ADD/load/TEST must publish TEST flags');
  assert.strictEqual(e.get_ebx() & 0xff, 0,
    'fused ADD/load/TEST must clear carry like TEST');

  const pairedLeaCode = imageBase + 0x1280;
  run(pairedLeaCode, [
    0xf9,             // stc -- LEA must preserve flags
    0x8d, 0x2c, 0xdb, // lea ebp,[ebx+ebx*8]
    0x8d, 0x04, 0x68, // lea eax,[eax+ebp*2] (depends on first LEA)
    0x0f, 0x92, 0xc2, // setc dl
  ], () => {
    e.set_eax(2);
    e.set_ebx(3);
    e.set_ebp(0);
    e.set_edx(0);
  }, false);
  assert.strictEqual(e.get_ebp() >>> 0, 27,
    'fused first LEA must compute its SIB address');
  assert.strictEqual(e.get_eax() >>> 0, 56,
    'fused second LEA must observe the first destination');
  assert.strictEqual(e.get_edx() & 0xff, 1,
    'fused SIB LEAs must preserve flags');

  const huffCode = imageBase + 0x1400;
  const huffCounter = scratch + 0x70;
  const huffTree = scratch + 0x100;
  const huffBits = scratch + 0x180;
  const huffLoop = [
    0xfe, 0x0d, ...le32(huffCounter), // dec byte [counter]
    0x75, 0x0c,                       // jnz consume-bit
    0x8b, 0x2e,                       // mov ebp,[esi]
    0x83, 0xc6, 0x04,                 // add esi,4
    0xc6, 0x05, ...le32(huffCounter), 0x20,
    0xc1, 0xed, 0x01,                 // consume-bit: shr ebp,1
    0x72, 0x05,                       // jb use prior EAX
    0xb8, 0x04, 0x00, 0x00, 0x00,     // mov eax,4
    0x03, 0xd0,                       // add edx,eax
    0x8b, 0x02,                       // mov eax,[edx]
    0xa9, 0x00, 0x00, 0x00, 0x80,     // test eax,0x80000000
    0x74, 0xd7,                       // jz loop
    0x0f, 0x94, 0xc1,                 // setz cl
    0x0f, 0x92, 0xc3,                 // setc bl
  ];
  mem[g2w(huffCounter)] = 2;
  dv.setUint32(g2w(huffTree + 4), 0x80000042, true);
  run(huffCode, huffLoop, () => {
    e.set_eax(8);
    e.set_ebx(0xff);
    e.set_ecx(0xff);
    e.set_edx(huffTree);
    e.set_ebp(0);
    e.set_esi(huffBits);
  }, false);
  assert.strictEqual(mem[g2w(huffCounter)], 1,
    'fused Huffman walk must decrement its bit counter');
  assert.strictEqual(e.get_edx() >>> 0, (huffTree + 4) >>> 0,
    'fused Huffman walk must select the zero-bit child');
  assert.strictEqual(e.get_eax() >>> 0, 0x80000042,
    'fused Huffman walk must stop on and retain a leaf');
  assert.strictEqual(e.get_ecx() & 0xff, 0,
    'fused Huffman walk must expose the final TEST result');
  assert.strictEqual(e.get_ebx() & 0xff, 0,
    'fused Huffman walk final TEST must clear carry');

  mem[g2w(huffCounter)] = 1;
  dv.setUint32(g2w(huffBits), 1, true);
  dv.setUint32(g2w(huffTree + 8), 0x80000084, true);
  run(huffCode + 0x80, huffLoop, () => {
    e.set_eax(8);
    e.set_ebx(0xff);
    e.set_ecx(0xff);
    e.set_edx(huffTree);
    e.set_ebp(0);
    e.set_esi(huffBits);
  }, false);
  assert.strictEqual(mem[g2w(huffCounter)], 32,
    'fused Huffman walk must refill an exhausted bit counter');
  assert.strictEqual(e.get_esi() >>> 0, (huffBits + 4) >>> 0,
    'fused Huffman walk must advance the refill pointer');
  assert.strictEqual(e.get_edx() >>> 0, (huffTree + 8) >>> 0,
    'fused Huffman walk must retain EAX for a one-bit child');
  assert.strictEqual(e.get_eax() >>> 0, 0x80000084,
    'fused Huffman refill path must stop on its leaf');

  const stormBitreader = Array.from(Buffer.from(
    '53568b74240c578b5c24148b46183bc372108acb2bc35f894618d36e1433c05e' +
    '5bc38ac88d7e1cd36e148b46203907752e8b46248d8e3422000050c707000800' +
    '005751ff562883c40c89462085c07509b8010000005f5e5bc3c707000000008b' +
    '0733d28a940634220000408bcbc1e20889070b56148b46182ac88956142bc35f' +
    'd3ea83c00889561489461833c05e5bc3', 'hex'));
  const stormCode = imageBase + 0x3000;
  const stormCtx = scratch + 0x400;
  counts = run(stormCode, stormBitreader, () => {
    dv.setUint32(g2w(stack + 4), stormCtx, true);
    dv.setUint32(g2w(stack + 8), 3, true);
    dv.setUint32(g2w(stormCtx + 0x14), 0xa5a5a5a5, true);
    dv.setUint32(g2w(stormCtx + 0x18), 12, true);
    e.set_eax(0xffffffff);
    e.set_ebx(0x11111111);
    e.set_esi(0x22222222);
    e.set_edi(0x33333333);
  });
  assert.strictEqual(dv.getUint32((e.get_handler_hist_base() >>> 0) + 396 * 4, true), 1,
    'exact Storm bit reader must use its superinstruction');
  assert.strictEqual(dv.getUint32(g2w(stormCtx + 0x14), true) >>> 0,
    0xa5a5a5a5 >>> 3, 'Storm fast path must shift the reservoir');
  assert.strictEqual(dv.getUint32(g2w(stormCtx + 0x18), true), 9,
    'Storm fast path must consume the requested bit count');
  assert.strictEqual(e.get_eax() >>> 0, 0,
    'Storm bit reader returns zero on success');
  assert.strictEqual(e.get_ebx() >>> 0, 0x11111111,
    'Storm fast path must preserve EBX');
  assert.strictEqual(e.get_esi() >>> 0, 0x22222222,
    'Storm fast path must preserve ESI');
  assert.strictEqual(e.get_edi() >>> 0, 0x33333333,
    'Storm fast path must preserve EDI');

  const stormSlowCtx = scratch + 0x800;
  run(stormCode + 0x100, stormBitreader, () => {
    dv.setUint32(g2w(stack + 4), stormSlowCtx, true);
    dv.setUint32(g2w(stack + 8), 6, true);
    dv.setUint32(g2w(stormSlowCtx + 0x14), 0x00000abc, true);
    dv.setUint32(g2w(stormSlowCtx + 0x18), 3, true);
    dv.setUint32(g2w(stormSlowCtx + 0x1c), 2, true);
    dv.setUint32(g2w(stormSlowCtx + 0x20), 10, true);
    mem[g2w(stormSlowCtx + 0x2234 + 2)] = 0xd2;
    e.set_ebx(0x44444444);
    e.set_esi(0x55555555);
    e.set_edi(0x66666666);
  }, false);
  assert.strictEqual(dv.getUint32(g2w(stormSlowCtx + 0x14), true), 0x1a6a,
    'Storm slow path must append and consume the next input byte');
  assert.strictEqual(dv.getUint32(g2w(stormSlowCtx + 0x18), true), 5,
    'Storm slow path must publish the replenished bit count');
  assert.strictEqual(dv.getUint32(g2w(stormSlowCtx + 0x1c), true), 3,
    'Storm slow path must advance its byte-buffer cursor');
  assert.strictEqual(e.get_edx() >>> 0, 0x1a6a,
    'Storm slow path must retain the shifted reservoir in EDX');
  assert.strictEqual(e.get_ecx() >>> 0, 3,
    'Storm slow path must retain the helper\'s final shift count in ECX');
  assert.strictEqual(e.get_ebx() >>> 0, 0x44444444,
    'Storm slow path must restore EBX');
  assert.strictEqual(e.get_esi() >>> 0, 0x55555555,
    'Storm slow path must restore ESI');
  assert.strictEqual(e.get_edi() >>> 0, 0x66666666,
    'Storm slow path must restore EDI');

  const stormRefillCtx = scratch + 0xc00;
  const stormCallback = scratch + 0x3800;
  mem.set([0xb8, 1, 0, 0, 0, 0xc3], g2w(stormCallback));
  run(stormCode + 0x200, stormBitreader, () => {
    dv.setUint32(g2w(stack + 4), stormRefillCtx, true);
    dv.setUint32(g2w(stack + 8), 5, true);
    dv.setUint32(g2w(stormRefillCtx + 0x14), 0x17, true);
    dv.setUint32(g2w(stormRefillCtx + 0x18), 2, true);
    dv.setUint32(g2w(stormRefillCtx + 0x1c), 7, true);
    dv.setUint32(g2w(stormRefillCtx + 0x20), 7, true);
    dv.setUint32(g2w(stormRefillCtx + 0x28), stormCallback, true);
    mem[g2w(stormRefillCtx + 0x2234)] = 0xa0;
    e.set_ebx(0x77777777);
    e.set_esi(0x88888888);
    e.set_edi(0x99999999);
  }, false);
  assert.strictEqual(dv.getUint32(g2w(stormRefillCtx + 0x20), true), 1,
    'Storm rare path must retain the original refill callback');
  assert.strictEqual(dv.getUint32(g2w(stormRefillCtx + 0x1c), true), 1,
    'Storm refill path must reset and then advance the byte cursor');
  assert.strictEqual(dv.getUint32(g2w(stormRefillCtx + 0x14), true), 0x1400,
    'Storm refill path must continue through the original common tail');
  assert.strictEqual(dv.getUint32(g2w(stormRefillCtx + 0x18), true), 5,
    'Storm refill path must replenish the bit count');
  assert.strictEqual(e.get_ebx() >>> 0, 0x77777777,
    'Storm refill path must restore EBX after original code resumes');
  assert.strictEqual(e.get_esi() >>> 0, 0x88888888,
    'Storm refill path must restore ESI after original code resumes');
  assert.strictEqual(e.get_edi() >>> 0, 0x99999999,
    'Storm refill path must restore EDI after original code resumes');

  const decJnzCode = imageBase + 0x1290;
  const counter = scratch + 0x60;
  mem[g2w(counter)] = 2;
  run(decJnzCode, [
    0xf9,                         // stc -- DEC preserves carry
    0xfe, 0x0d, ...le32(counter), // dec byte [counter]
    0x75, 0x05,                   // jnz past the MOV
    0xb8, 0x11, 0x11, 0x11, 0x11,
    0x0f, 0x94, 0xc1,             // setz cl
    0x0f, 0x92, 0xc3,             // setc bl
  ], () => {
    e.set_eax(0x22222222);
    e.set_ecx(0xff);
    e.set_ebx(0);
  }, false);
  assert.strictEqual(mem[g2w(counter)], 1,
    'fused DEC/JNZ must write the decremented byte');
  assert.strictEqual(e.get_eax() >>> 0, 0x22222222,
    'fused DEC/JNZ must take JNZ when the byte remains nonzero');
  assert.strictEqual(e.get_ecx() & 0xff, 0,
    'fused DEC/JNZ must publish the nonzero DEC result');
  assert.strictEqual(e.get_ebx() & 0xff, 1,
    'fused DEC/JNZ must preserve carry like DEC');

  mem[g2w(counter)] = 1;
  run(decJnzCode + 0x30, [
    0xf9,
    0xfe, 0x0d, ...le32(counter),
    0x75, 0x05,
    0xb8, 0x11, 0x11, 0x11, 0x11,
    0x0f, 0x94, 0xc1,
    0x0f, 0x92, 0xc3,
  ], () => {
    e.set_eax(0x22222222);
    e.set_ecx(0);
    e.set_ebx(0);
  }, false);
  assert.strictEqual(e.get_eax() >>> 0, 0x11111111,
    'fused DEC/JNZ must fall through when DEC reaches zero');
  assert.strictEqual(e.get_ecx() & 0xff, 1,
    'fused DEC/JNZ must publish ZF when DEC reaches zero');
  assert.strictEqual(e.get_ebx() & 0xff, 1,
    'fused DEC/JNZ zero path must also preserve carry');

  const shrJbCode = imageBase + 0x12f0;
  run(shrJbCode, [
    0xc1, 0xed, 0x01,             // shr ebp,1
    0x72, 0x05,                   // jb past the MOV
    0xb8, 0x33, 0x33, 0x33, 0x33,
    0x0f, 0x92, 0xc3,             // setc bl
  ], () => {
    e.set_eax(0x44444444);
    e.set_ebp(3);
    e.set_ebx(0);
  }, false);
  assert.strictEqual(e.get_ebp() >>> 0, 1,
    'fused SHR/JB must update EBP');
  assert.strictEqual(e.get_eax() >>> 0, 0x44444444,
    'fused SHR/JB must branch on the shifted-out low bit');
  assert.strictEqual(e.get_ebx() & 0xff, 1,
    'fused SHR/JB must publish SHR carry');

  run(shrJbCode + 0x30, [
    0xc1, 0xed, 0x01,
    0x73, 0x05,                   // jae past the MOV
    0xb8, 0x33, 0x33, 0x33, 0x33,
    0x0f, 0x92, 0xc3,
  ], () => {
    e.set_eax(0x44444444);
    e.set_ebp(2);
    e.set_ebx(0xff);
  }, false);
  assert.strictEqual(e.get_ebp() >>> 0, 1,
    'fused SHR/JAE must update EBP');
  assert.strictEqual(e.get_eax() >>> 0, 0x44444444,
    'fused SHR/JAE must branch when SHR clears carry');
  assert.strictEqual(e.get_ebx() & 0xff, 0,
    'fused SHR/JAE must publish cleared carry');

  const aamCode = imageBase + 0x1360;
  run(aamCode, [0xd4, 0x0a], () => {
    e.set_eax(0xabcd002d);
  }, false);
  assert.strictEqual(e.get_eax() >>> 0, 0xabcd0405,
    'AAM base 10 must put AL/base in AH and AL%base in AL');
  assert.strictEqual(e.get_flag_op(), 3,
    'AAM must publish logical SF/ZF/PF state');
  assert.strictEqual(e.get_flag_res(), 5,
    'AAM flags must derive from the resulting AL byte');
  assert.strictEqual(e.get_flag_sign_shift(), 7,
    'AAM sign flag must use byte width');

  const portIoCode = imageBase + 0x1380;
  run(portIoCode, [
    0xba, 0x43, 0x00, 0x00, 0x00, // mov edx,0x43
    0x30, 0xc0,                   // xor al,al (latch channel 0)
    0xee,                         // out dx,al
    0xba, 0x40, 0x00, 0x00, 0x00, // mov edx,0x40
    0xec,                         // in al,dx (low byte)
    0x88, 0xc3,                   // mov bl,al
    0xec,                         // in al,dx (high byte)
    0x88, 0xc4,                   // mov ah,al
    0x88, 0xd8,                   // mov al,bl
  ], () => {
    e.set_eax(0xaaaa5555);
    e.set_ebx(0);
    e.set_edx(0);
  }, false);
  assert.strictEqual(e.get_eax() >>> 0,
    (0xaaaa0000 | ((-(1234 * 1193)) & 0xffff)) >>> 0,
    'OUT 0x43 followed by two IN 0x40 reads must return one latched PIT count');

  const enterCode = imageBase + 0x13c0;
  run(enterCode, [
    0xc8, 0x44, 0x01, 0x00, // enter 0x144,0
    0xc9,                   // leave
  ], () => {
    e.set_ebp(0x12345678);
  }, false);
  assert.strictEqual(e.get_ebp() >>> 0, 0x12345678,
    '32-bit ENTER/LEAVE must preserve and restore the caller frame pointer');

  const longBlockCode = imageBase + 0x2000;
  run(longBlockCode, Array(1200).fill(0x40), () => {
    e.set_eax(0);
  }, false);
  assert.strictEqual(e.get_eax() >>> 0, 1200,
    'a generated straight-line block longer than the dispatch quantum must not replay');

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
