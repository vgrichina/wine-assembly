#!/usr/bin/env node

'use strict';

// Smoke-test the toy VM's x87 against hand-computed expectations.
//
//   node tools/toyvm/fpu-check.js [--variant=tailcall] [--verbose]
//
// The SingleStepTests/8088 corpus that gates every other opcode was recorded
// off a bare 8088 with no coprocessor fitted, so it has nothing to say about
// D8-DF -- there is no ground truth to fetch and this file is the substitute.
// Each case is a short byte sequence run one instruction at a time through the
// same vm.stepOne() the gate uses, so it exercises the real decoder and the
// real handlers, not a shortcut.
//
// Expectations are written as f64 because that is how the VM models the stack
// (8 f64 globals and a rotating TOP, not an 80-bit softfloat). Anything that
// would only be distinguishable at 64-bit mantissa precision is out of scope
// here by construction, and is noted where it matters.

const { makeVm } = require('./vm');

const CODE = 0x1000;   // where each case's bytes are placed
const DATA = 0x2000;   // scratch: inputs at +0, outputs at +0x40

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const verbose = process.argv.slice(2).includes('--verbose');

// ModRM for `[disp16]` (mod=00, rm=110) with the given /reg field.
const M = (reg) => (reg << 3) | 0x06;
// The two disp16 bytes of an absolute address.
const D = (a) => [a & 0xFF, (a >> 8) & 0xFF];
// One memory-form escape: `esc /reg [addr]`.
const mem = (esc, reg, addr) => [esc, M(reg), ...D(addr)];

const IN = DATA, OUT = DATA + 0x40;

const CASES = [
  {
    name: 'fld m64 / fstp m64 round trip',
    pre: (dv) => dv.setFloat64(IN, 1.5, true),
    code: [...mem(0xDD, 0, IN), ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === 1.5,
  },
  {
    name: 'fld m32 / fstp m32 round trip',
    pre: (dv) => dv.setFloat32(IN, -2.25, true),
    code: [...mem(0xD9, 0, IN), ...mem(0xD9, 3, OUT)],
    want: (dv) => dv.getFloat32(OUT, true) === -2.25,
  },
  {
    name: 'fld m80 / fstp m80 round trip',
    // Store an f64 as 80-bit first, so the case tests both directions against
    // each other and needs no hand-built extended encoding.
    pre: (dv) => dv.setFloat64(IN, 1234.5, true),
    code: [
      ...mem(0xDD, 0, IN),          // fld qword
      ...mem(0xDB, 7, OUT),         // fstp tbyte
      ...mem(0xDB, 5, OUT),         // fld tbyte
      ...mem(0xDD, 3, OUT + 0x10),  // fstp qword
    ],
    want: (dv) => dv.getFloat64(OUT + 0x10, true) === 1234.5,
  },
  {
    name: 'fld1 + fld1, fadd st,st(1) = 2',
    code: [0xD9, 0xE8, 0xD9, 0xE8, 0xD8, 0xC1, ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === 2,
  },
  {
    name: 'faddp st(1),st = 3',
    pre: (dv) => { dv.setFloat64(IN, 1, true); dv.setFloat64(IN + 8, 2, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      0xDE, 0xC1,                   // faddp st(1),st
      ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 3,
  },
  {
    name: 'fsub m64: 10 - 4 = 6',
    pre: (dv) => { dv.setFloat64(IN, 10, true); dv.setFloat64(IN + 8, 4, true); },
    code: [...mem(0xDD, 0, IN), ...mem(0xDC, 4, IN + 8), ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === 6,
  },
  {
    name: 'fsubr m64: 4 reversed from 10 = -6',
    pre: (dv) => { dv.setFloat64(IN, 10, true); dv.setFloat64(IN + 8, 4, true); },
    code: [...mem(0xDD, 0, IN), ...mem(0xDC, 5, IN + 8), ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === -6,
  },
  {
    name: 'fdiv m32: 7 / 2 = 3.5',
    pre: (dv) => { dv.setFloat32(IN, 7, true); dv.setFloat32(IN + 4, 2, true); },
    code: [...mem(0xD9, 0, IN), ...mem(0xD8, 6, IN + 4), ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === 3.5,
  },
  {
    name: 'fdivr st(1),st then fstp',
    // st(0)=2, st(1)=8 after the two loads. DC swaps the sense of the DIV pair
    // relative to D8, so F0+i is FDIVR and F8+i is FDIV -- and FDIVR ST(1),ST
    // is defined as ST(1) <- ST(0) / ST(1) = 2/8 = 0.25. Getting the swap
    // backwards here is a silent 16x error, which is why it has a case.
    pre: (dv) => { dv.setFloat64(IN, 8, true); dv.setFloat64(IN + 8, 2, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      0xDC, 0xF1,                   // fdivr st(1),st
      0xDD, 0xD8,                   // fstp st(0)  (drop the 2)
      ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 0.25,
  },
  {
    name: 'fild m16 / fistp m16',
    pre: (dv) => dv.setInt16(IN, -1234, true),
    code: [...mem(0xDF, 0, IN), ...mem(0xDF, 3, OUT)],
    want: (dv) => dv.getInt16(OUT, true) === -1234,
  },
  {
    name: 'fild m32 / fistp m32',
    pre: (dv) => dv.setInt32(IN, 100000, true),
    code: [...mem(0xDB, 0, IN), ...mem(0xDB, 3, OUT)],
    want: (dv) => dv.getInt32(OUT, true) === 100000,
  },
  {
    name: 'fild m64 / fistp m64',
    pre: (dv) => dv.setBigInt64(IN, -5000000000n, true),
    code: [...mem(0xDF, 5, IN), ...mem(0xDF, 7, OUT)],
    want: (dv) => dv.getBigInt64(OUT, true) === -5000000000n,
  },
  {
    name: 'fistp rounds to nearest-even by default',
    // 2.5 goes to 2, 3.5 goes to 4 -- the default RC of 00 is round-half-even,
    // not the round-half-up a C cast would give.
    pre: (dv) => { dv.setFloat64(IN, 2.5, true); dv.setFloat64(IN + 8, 3.5, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDF, 3, OUT),
      ...mem(0xDD, 0, IN + 8), ...mem(0xDF, 3, OUT + 2),
    ],
    want: (dv) => dv.getInt16(OUT, true) === 2 && dv.getInt16(OUT + 2, true) === 4,
  },
  {
    name: 'fldcw RC=11 makes fistp truncate',
    pre: (dv) => {
      dv.setFloat64(IN, 2.9, true);
      dv.setUint16(IN + 0x20, 0x0F7F, true);   // default | RC=11 (truncate)
    },
    code: [
      ...mem(0xD9, 5, IN + 0x20),   // fldcw
      ...mem(0xDD, 0, IN), ...mem(0xDF, 3, OUT),
    ],
    want: (dv) => dv.getInt16(OUT, true) === 2,
  },
  {
    name: 'fnstcw reads back what fldcw wrote',
    pre: (dv) => dv.setUint16(IN, 0x0272, true),
    code: [...mem(0xD9, 5, IN), ...mem(0xD9, 7, OUT)],
    want: (dv) => dv.getUint16(OUT, true) === 0x0272,
  },
  {
    name: 'fsqrt(2)',
    pre: (dv) => dv.setFloat64(IN, 2, true),
    code: [...mem(0xDD, 0, IN), 0xD9, 0xFA, ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === Math.SQRT2,
  },
  {
    name: 'fchs then fabs',
    code: [
      0xD9, 0xE8,                   // fld1
      0xD9, 0xE0,                   // fchs
      ...mem(0xDD, 3, OUT),
      0xD9, 0xE8, 0xD9, 0xE0, 0xD9, 0xE1,
      ...mem(0xDD, 3, OUT + 8),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === -1 && dv.getFloat64(OUT + 8, true) === 1,
  },
  {
    name: 'fld constants',
    code: [
      0xD9, 0xEB, ...mem(0xDD, 3, OUT),          // fldpi
      0xD9, 0xEE, ...mem(0xDD, 3, OUT + 8),      // fldz
      0xD9, 0xED, ...mem(0xDD, 3, OUT + 16),     // fldln2
    ],
    want: (dv) => Math.abs(dv.getFloat64(OUT, true) - Math.PI) < 1e-15
      && dv.getFloat64(OUT + 8, true) === 0
      && Math.abs(dv.getFloat64(OUT + 16, true) - Math.LN2) < 1e-15,
  },
  {
    name: 'fxch swaps st(0) and st(1)',
    pre: (dv) => { dv.setFloat64(IN, 11, true); dv.setFloat64(IN + 8, 22, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      0xD9, 0xC9,                   // fxch st(1)
      ...mem(0xDD, 3, OUT), ...mem(0xDD, 3, OUT + 8),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 11 && dv.getFloat64(OUT + 8, true) === 22,
  },
  {
    name: 'frndint honours RC',
    pre: (dv) => {
      dv.setFloat64(IN, -2.5, true);
      dv.setUint16(IN + 0x20, 0x077F, true);   // RC=01, round down
    },
    code: [
      ...mem(0xDD, 0, IN), 0xD9, 0xFC, ...mem(0xDD, 3, OUT),
      ...mem(0xD9, 5, IN + 0x20),
      ...mem(0xDD, 0, IN), 0xD9, 0xFC, ...mem(0xDD, 3, OUT + 8),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === -2       // nearest-even
      && dv.getFloat64(OUT + 8, true) === -3,          // floor
  },
  {
    name: 'fscale multiplies by 2^trunc(st(1))',
    pre: (dv) => { dv.setFloat64(IN, 3, true); dv.setFloat64(IN + 8, 5, true); },
    code: [
      ...mem(0xDD, 0, IN),          // st(1) after the next load = 3
      ...mem(0xDD, 0, IN + 8),      // st(0) = 5
      0xD9, 0xC9,                   // fxch -> st(0)=3 (value), st(1)=5 (scale)
      0xD9, 0xFD,                   // fscale
      ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 96,      // 3 * 2^5
  },
  {
    name: 'fprem: 17 mod 5 = 2',
    pre: (dv) => { dv.setFloat64(IN, 5, true); dv.setFloat64(IN + 8, 17, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      0xD9, 0xF8,                   // fprem
      ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 2,
  },
  {
    name: 'fcom + fnstsw ax: 1 < 2 sets C0',
    pre: (dv) => dv.setFloat64(IN, 2, true),
    code: [
      0xD9, 0xE8,                   // fld1  -> st(0) = 1
      ...mem(0xDC, 2, IN),          // fcom qword [2] -- 1 vs 2
      0xDF, 0xE0,                   // fnstsw ax
    ],
    want: (dv, vm) => (vm.get('ax') & 0x4500) === 0x0100,
  },
  {
    name: 'fcom + fnstsw ax: equal sets C3 only',
    pre: (dv) => dv.setFloat64(IN, 1, true),
    code: [0xD9, 0xE8, ...mem(0xDC, 2, IN), 0xDF, 0xE0],
    want: (dv, vm) => (vm.get('ax') & 0x4500) === 0x4000,
  },
  {
    name: 'fcompp pops both',
    pre: (dv) => { dv.setFloat64(IN, 4, true); dv.setFloat64(IN + 8, 9, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      0xDE, 0xD9,                   // fcompp -- 9 vs 4, so C0 clear
      0xDF, 0xE0,
      0xD9, 0xE8, ...mem(0xDD, 3, OUT),   // stack empty again: fld1 lands cleanly
    ],
    want: (dv, vm) => (vm.get('ax') & 0x4500) === 0 && dv.getFloat64(OUT, true) === 1,
  },
  {
    name: 'ftst against zero',
    pre: (dv) => dv.setFloat64(IN, -3, true),
    code: [...mem(0xDD, 0, IN), 0xD9, 0xE4, 0xDF, 0xE0],
    want: (dv, vm) => (vm.get('ax') & 0x4500) === 0x0100,
  },
  {
    name: 'fninit clears the status word',
    code: [
      0xD9, 0xE8, ...mem(0xDC, 2, IN),   // leave C0 set (1 vs 0 -> greater)
      0xDB, 0xE3,                        // fninit
      0xDF, 0xE0,
    ],
    want: (dv, vm) => (vm.get('ax') & 0xFFFF) === 0,
  },
  {
    name: 'fwait before fninit decodes',
    // `9B DB E3` is how a real-mode program written for a machine that might
    // not have a coprocessor spells FINIT, and it is the single commonest
    // give-up site in the demo corpus.
    code: [0x9B, 0xDB, 0xE3, 0xDF, 0xE0],
    want: (dv, vm) => (vm.get('ax') & 0xFFFF) === 0,
  },
  {
    name: 'fst st(i) copies without popping',
    pre: (dv) => dv.setFloat64(IN, 42, true),
    code: [
      ...mem(0xDD, 0, IN),
      0xD9, 0xC0,                   // fld st(0) -- duplicate
      0xDD, 0xD8,                   // fstp st(0)... pops into itself
      ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 42,
  },
  {
    name: 'fmul mi16 (DE /1)',
    pre: (dv) => { dv.setFloat64(IN, 6, true); dv.setInt16(IN + 8, 7, true); },
    code: [...mem(0xDD, 0, IN), ...mem(0xDE, 1, IN + 8), ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === 42,
  },
  {
    name: 'fadd mi32 (DA /0)',
    pre: (dv) => { dv.setFloat64(IN, 0.5, true); dv.setInt32(IN + 8, 100, true); },
    code: [...mem(0xDD, 0, IN), ...mem(0xDA, 0, IN + 8), ...mem(0xDD, 3, OUT)],
    want: (dv) => dv.getFloat64(OUT, true) === 100.5,
  },
  {
    name: 'fnstenv reports the control word a program just set',
    // The commonest real use: write a known CW, save the environment, read the
    // CW field back. A program that gets a stale or zero word here concludes
    // there is no coprocessor, whatever else is implemented.
    pre: (dv) => dv.setUint16(IN, 0x0272, true),
    code: [...mem(0xD9, 5, IN), ...mem(0xD9, 6, OUT)],
    want: (dv) => dv.getUint16(OUT, true) === 0x0272,
  },
  {
    name: 'fnstenv tag word marks empty vs occupied',
    // Two values pushed leaves TOP at 6, so physical registers 6 and 7 are the
    // occupied pair and the other six read as 11 (empty).
    code: [
      0xD9, 0xE8, 0xD9, 0xE8,
      ...mem(0xD9, 6, OUT),
    ],
    want: (dv) => dv.getUint16(OUT + 4, true) === 0x0FFF
      && ((dv.getUint16(OUT + 2, true) >> 11) & 7) === 6,
  },
  {
    name: 'fldenv restores what fnstenv wrote',
    pre: (dv) => dv.setUint16(IN, 0x0F7F, true),
    code: [
      ...mem(0xD9, 5, IN),          // fldcw   -- RC = truncate
      ...mem(0xD9, 6, OUT),         // fnstenv
      0xDB, 0xE3,                   // fninit  -- CW back to 0x037F
      ...mem(0xD9, 4, OUT),         // fldenv  -- and back again
      ...mem(0xD9, 7, OUT + 0x20),  // fnstcw
    ],
    want: (dv) => dv.getUint16(OUT + 0x20, true) === 0x0F7F,
  },
  {
    name: 'fnsave / frstor round trip the stack',
    pre: (dv) => { dv.setFloat64(IN, 3.75, true); dv.setFloat64(IN + 8, -19, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      ...mem(0xDD, 6, OUT),         // fnsave  -- and reinitialise
      ...mem(0xDD, 4, OUT),         // frstor
      ...mem(0xDD, 3, OUT + 0x60), ...mem(0xDD, 3, OUT + 0x68),
    ],
    want: (dv) => dv.getFloat64(OUT + 0x60, true) === -19
      && dv.getFloat64(OUT + 0x68, true) === 3.75,
  },
  {
    name: 'fnsave reinitialises the unit',
    code: [
      0xD9, 0xE8, ...mem(0xDD, 6, OUT), 0xDF, 0xE0,
    ],
    want: (dv, vm) => (vm.get('ax') & 0xFFFF) === 0,
  },
  {
    name: 'fbstp writes packed BCD',
    pre: (dv) => dv.setFloat64(IN, -1234567, true),
    code: [...mem(0xDD, 0, IN), ...mem(0xDF, 6, OUT)],
    want: (dv) => dv.getUint8(OUT) === 0x67 && dv.getUint8(OUT + 1) === 0x45
      && dv.getUint8(OUT + 2) === 0x23 && dv.getUint8(OUT + 3) === 0x01
      && dv.getUint8(OUT + 4) === 0 && dv.getUint8(OUT + 9) === 0x80,
  },
  {
    name: 'fbld reads packed BCD back',
    pre: (dv) => dv.setFloat64(IN, 90210, true),
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDF, 6, OUT),
      ...mem(0xDF, 4, OUT), ...mem(0xDD, 3, OUT + 0x10),
    ],
    want: (dv) => dv.getFloat64(OUT + 0x10, true) === 90210,
  },
  {
    name: 'fsin / fcos',
    pre: (dv) => dv.setFloat64(IN, 0.5, true),
    code: [
      ...mem(0xDD, 0, IN), 0xD9, 0xFE, ...mem(0xDD, 3, OUT),
      ...mem(0xDD, 0, IN), 0xD9, 0xFF, ...mem(0xDD, 3, OUT + 8),
    ],
    want: (dv) => Math.abs(dv.getFloat64(OUT, true) - Math.sin(0.5)) < 1e-15
      && Math.abs(dv.getFloat64(OUT + 8, true) - Math.cos(0.5)) < 1e-15,
  },
  {
    name: 'fsincos pushes the cosine on top',
    pre: (dv) => dv.setFloat64(IN, 0.75, true),
    code: [
      ...mem(0xDD, 0, IN), 0xD9, 0xFB,
      ...mem(0xDD, 3, OUT),         // st(0) = cos
      ...mem(0xDD, 3, OUT + 8),     // st(1) = sin
    ],
    want: (dv) => Math.abs(dv.getFloat64(OUT, true) - Math.cos(0.75)) < 1e-15
      && Math.abs(dv.getFloat64(OUT + 8, true) - Math.sin(0.75)) < 1e-15,
  },
  {
    name: 'fptan leaves tan and a 1',
    pre: (dv) => dv.setFloat64(IN, 0.3, true),
    code: [
      ...mem(0xDD, 0, IN), 0xD9, 0xF2,
      ...mem(0xDD, 3, OUT),         // the pushed 1.0
      ...mem(0xDD, 3, OUT + 8),     // the tangent
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 1
      && Math.abs(dv.getFloat64(OUT + 8, true) - Math.tan(0.3)) < 1e-15,
  },
  {
    name: 'fpatan(st(1), st(0))',
    pre: (dv) => { dv.setFloat64(IN, 1, true); dv.setFloat64(IN + 8, 2, true); },
    code: [
      ...mem(0xDD, 0, IN),          // st(1) = 1  (y)
      ...mem(0xDD, 0, IN + 8),      // st(0) = 2  (x)
      0xD9, 0xF3, ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => Math.abs(dv.getFloat64(OUT, true) - Math.atan2(1, 2)) < 1e-15,
  },
  {
    name: 'f2xm1',
    pre: (dv) => dv.setFloat64(IN, 0.25, true),
    code: [...mem(0xDD, 0, IN), 0xD9, 0xF0, ...mem(0xDD, 3, OUT)],
    want: (dv) => Math.abs(dv.getFloat64(OUT, true) - (2 ** 0.25 - 1)) < 1e-15,
  },
  {
    name: 'fyl2x: y * log2(x)',
    pre: (dv) => { dv.setFloat64(IN, 3, true); dv.setFloat64(IN + 8, 8, true); },
    code: [
      ...mem(0xDD, 0, IN),          // y = 3
      ...mem(0xDD, 0, IN + 8),      // x = 8
      0xD9, 0xF1, ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 9,
  },
  {
    name: 'fyl2xp1: y * log2(1 + x)',
    pre: (dv) => { dv.setFloat64(IN, 5, true); dv.setFloat64(IN + 8, 1, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      0xD9, 0xF9, ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 5,
  },
  {
    name: 'fxtract splits exponent and significand',
    pre: (dv) => dv.setFloat64(IN, 40, true),
    code: [
      ...mem(0xDD, 0, IN), 0xD9, 0xF4,
      ...mem(0xDD, 3, OUT),         // significand, in [1,2)
      ...mem(0xDD, 3, OUT + 8),     // exponent
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 1.25
      && dv.getFloat64(OUT + 8, true) === 5,
  },
  {
    name: 'fprem1 rounds the quotient to nearest',
    // 17 / 5 is 3.4, so FPREM (truncate) gives 2 and FPREM1 (nearest) gives 2
    // as well; 23 / 5 is 4.6 and separates them: 3 against -2.
    pre: (dv) => { dv.setFloat64(IN, 5, true); dv.setFloat64(IN + 8, 23, true); },
    code: [
      ...mem(0xDD, 0, IN), ...mem(0xDD, 0, IN + 8),
      0xD9, 0xF5, ...mem(0xDD, 3, OUT),
    ],
    want: (dv) => dv.getFloat64(OUT, true) === -2,
  },
  {
    name: 'fst m64 leaves the value on the stack',
    pre: (dv) => dv.setFloat64(IN, 8.125, true),
    code: [
      ...mem(0xDD, 0, IN),
      ...mem(0xDD, 2, OUT),         // fst  -- no pop
      ...mem(0xDD, 3, OUT + 8),     // fstp -- same value again
    ],
    want: (dv) => dv.getFloat64(OUT, true) === 8.125
      && dv.getFloat64(OUT + 8, true) === 8.125,
  },
];

async function main() {
  const variant = arg('variant', 'tailcall');
  const vm = await makeVm(variant);
  const dv = new DataView(vm.mem.buffer);
  let pass = 0;

  for (const c of CASES) {
    vm.mem.fill(0);
    vm.setAll({ cs: 0, ip: CODE, ds: 0, es: 0, ss: 0, sp: 0xFFF0, ax: 0, flags: 0xF002 });
    if (c.pre) c.pre(dv);
    for (let i = 0; i < c.code.length; i++) vm.mem[CODE + i] = c.code[i];

    // Step until the IP walks off the end of the case's own bytes. A refused
    // opcode returns false and is reported as such rather than as a wrong
    // answer, since the two have completely different fixes.
    let refused = null, steps = 0;
    while (vm.get('gip') < CODE + c.code.length && steps++ < 64) {
      if (!vm.stepOne()) { refused = vm.get('gip'); break; }
    }

    let ok = false, err = null;
    if (refused !== null) err = `decoder refused at ip=0x${refused.toString(16)}`;
    else { try { ok = !!c.want(dv, vm); } catch (e) { err = String(e); } }

    if (ok) { pass++; if (verbose) console.log(`  ok    ${c.name}`); }
    else console.log(`  FAIL  ${c.name}${err ? `  (${err})` : ''}`);
  }

  console.log(`\nvariant=${variant}  ${pass}/${CASES.length} pass`);
  process.exit(pass === CASES.length ? 0 : 1);
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
