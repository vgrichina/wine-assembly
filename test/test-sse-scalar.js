#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileSrcWasm } = require('./compile-src');
const { createHostImports } = require('../lib/host-imports');

(async () => {
  const wasm = process.env.WINE_ASSEMBLY_WASM
    ? fs.readFileSync(process.env.WINE_ASSEMBLY_WASM) : compileSrcWasm();
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const { host } = createHostImports(ctx);
  Object.assign(host, { memory, log() {}, log_i32() {}, exit() {} });
  const { instance } = await WebAssembly.instantiate(wasm, { host });
  const e = ctx.exports = instance.exports;
  const exe = fs.readFileSync(path.join(__dirname, 'binaries/notepad.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  e.load_pe(exe.length);
  const base = e.get_image_base();
  const a = base + 0x9000, b = a + 32, out = b + 32;
  const le32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
  const bits = value => {
    const buf = Buffer.alloc(4); buf.writeFloatLE(value); return buf.readUInt32LE();
  };
  const upper = [0x7fc12345, 0x80000000, 0xdeadbeef];
  let count = 0;
  for (const [opcode, label, operation] of [
    [0x58, 'ADDSS', (x, y) => Math.fround(x + y)],
    [0x59, 'MULSS', (x, y) => Math.fround(x * y)],
    [0x5c, 'SUBSS', (x, y) => Math.fround(x - y)],
    [0x5e, 'DIVSS', (x, y) => Math.fround(x / y)],
  ]) {
    for (const memorySource of [false, true]) {
      for (const values of [[1.5, -2], [-0, 3], [16777216, 1], [1e20, 1e20]]) {
        const [x, y] = values.map(Math.fround);
        [bits(x), ...upper].forEach((v, i) => e.guest_write32(a + i * 4, v));
        [bits(y), 0x7fcabcde, 0, 0xffffffff].forEach((v, i) => e.guest_write32(b + i * 4, v));
        const code = [
          0x0f, 0x10, 0x05, ...le32(a),
          0x0f, 0x10, 0x0d, ...le32(b),
          0xf3, 0x0f, opcode, ...(memorySource ? [0x05, ...le32(b)] : [0xc1]),
          0x0f, 0x11, 0x05, ...le32(out), 0xc3,
        ];
        const pc = base + 0x1000 + count++ * 256;
        code.forEach((v, i) => e.guest_write8(pc + i, v));
        const sp = base + 0xd00000;
        e.guest_write32(sp, 0); e.set_esp(sp); e.set_eip(pc); e.run(10000);
        assert.strictEqual(e.get_eip(), 0, `${label} returns`);
        assert.strictEqual(e.get_esp() >>> 0, sp + 4, `${label} does not alter stack`);
        assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => e.guest_read32(out + i * 4) >>> 0),
          [bits(operation(x, y)), ...upper], `${label} ${memorySource ? 'memory' : 'register'} ${x},${y}`);
      }
    }
  }
  for (const [opcode, memorySource] of [[0x2e, false], [0x2e, true], [0x2f, false], [0x2f, true]]) {
    for (const [x, y, flags] of [[1, 2, 1], [2, 1, 0], [1, 1, 0x40],
      [-0, 0, 0x40], [NaN, 1, 0x45], [1, NaN, 0x45], [Infinity, Infinity, 0x40]]) {
      const input = [bits(x), ...upper];
      input.forEach((v, i) => e.guest_write32(a + i * 4, v));
      [bits(y), ...upper].forEach((v, i) => e.guest_write32(b + i * 4, v));
      const code = [
        0x0f, 0x10, 0x05, ...le32(a),
        0x0f, 0x10, 0x0d, ...le32(b),
        0x68, ...le32(0x8d7), 0x9d, // seed all six arithmetic flags
        0x0f, opcode, ...(memorySource ? [0x05, ...le32(b)] : [0xc1]),
        0x9c, 0x58, 0xa3, ...le32(out + 16), // capture EFLAGS
        0x0f, 0x11, 0x05, ...le32(out), 0xc3,
      ];
      const pc = base + 0x1000 + count++ * 256, sp = base + 0xd00000;
      code.forEach((v, i) => e.guest_write8(pc + i, v));
      e.guest_write32(sp, 0); e.set_esp(sp); e.set_eip(pc); e.run(10000);
      assert.strictEqual(e.get_eip(), 0, 'UCOMISS returns');
      assert.strictEqual(e.guest_read32(out + 16) & 0x8d5, flags,
        `UCOMISS ${memorySource ? 'memory' : 'register'} ${x},${y} flags`);
      assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => e.guest_read32(out + i * 4) >>> 0),
        input, 'UCOMISS does not modify either operand');
    }
  }
  for (const [opcode, label, operation] of [
    [0x5c, 'SUBPS', (x, y) => Math.fround(x - y)],
    [0x5e, 'DIVPS', (x, y) => Math.fround(x / y)],
  ]) {
    for (const memorySource of [false, true]) {
      const av = [1.5, -4, 9, -0], bv = [2, 2, -3, 1];
      av.forEach((v, i) => e.guest_write32(a + i * 4, bits(v)));
      bv.forEach((v, i) => e.guest_write32(b + i * 4, bits(v)));
      const code = [
        0x0f, 0x10, 0x05, ...le32(a), 0x0f, 0x10, 0x0d, ...le32(b),
        0x0f, opcode, ...(memorySource ? [0x05, ...le32(b)] : [0xc1]),
        0x0f, 0x11, 0x05, ...le32(out), 0xc3,
      ];
      const pc = base + 0x1000 + count++ * 256, sp = base + 0xd00000;
      code.forEach((v, i) => e.guest_write8(pc + i, v));
      e.guest_write32(sp, 0); e.set_esp(sp); e.set_eip(pc); e.run(10000);
      assert.strictEqual(e.get_eip(), 0);
      assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) => e.guest_read32(out + i * 4) >>> 0),
        av.map((v, i) => bits(operation(v, bv[i]))), `${label} all four lanes`);
    }
  }
  console.log(`PASS ${count} scalar SSE arithmetic/comparison cases`);
})().catch(error => { console.error(error); process.exitCode = 1; });
