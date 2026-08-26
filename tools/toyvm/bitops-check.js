#!/usr/bin/env node

'use strict';

// Smoke-test the toy VM's 386 bit instructions against hand-computed answers.
//
//   node tools/toyvm/bitops-check.js [--variant=tailcall] [--verbose]
//
// BT/BTS/BTR/BTC and BSF/BSR are 386 opcodes, and the SingleStepTests/8088
// corpus tools/toyvm/gate.js runs against was recorded off a part where 0F is
// POP CS -- so there is no ground truth to fetch for any of them, the same
// situation fpu-check.js exists for. This file is the substitute, in the same
// shape: short byte sequences run one instruction at a time through the real
// vm.stepOne(), so the real decoder and the real handlers are what answer.
//
// The case that matters most is the negative memory offset. A register
// destination masks the bit index to the operand width; a MEMORY destination
// treats it as a SIGNED bit displacement from the effective address, so
// `bt [addr], ax` with ax = -1 reads the top bit of the byte BEFORE addr. Get
// that wrong and every ordinary bitmap test still passes.

const { makeVm } = require('./vm');
const { setCpuLevel } = require('./decode');

const CODE = 0x1000;
const DATA = 0x2000;

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const verbose = process.argv.slice(2).includes('--verbose');

const D = (a) => [a & 0xFF, (a >> 8) & 0xFF];
// ModRM for a register destination: mod=11, the /reg field, and the register.
const RR = (reg, rm) => 0xC0 | (reg << 3) | rm;
// ModRM for `[disp16]`: mod=00, rm=110.
const MM = (reg) => (reg << 3) | 0x06;

// The four bit tests, by their 0F BA /reg extension and their register-index
// second opcode byte.
const BT = 4, BTS = 5, BTR = 6, BTC = 7;

const CF = (vm) => vm.get('flags') & 1;
const ZF = (vm) => (vm.get('flags') >> 6) & 1;

const CASES = [
  // --- register destination, immediate index --------------------------------
  {
    name: 'bt ax,3 -- bit set',
    regs: { ax: 0x0008 },
    code: [0x0F, 0xBA, RR(BT, 0), 3],
    want: (dv, vm) => CF(vm) === 1 && vm.get('ax') === 0x0008,
  },
  {
    name: 'bt ax,2 -- bit clear',
    regs: { ax: 0x0008 },
    code: [0x0F, 0xBA, RR(BT, 0), 2],
    want: (dv, vm) => CF(vm) === 0,
  },
  {
    name: 'bts ax,4 -- sets, CF was clear',
    regs: { ax: 0x0000 },
    code: [0x0F, 0xBA, RR(BTS, 0), 4],
    want: (dv, vm) => vm.get('ax') === 0x0010 && CF(vm) === 0,
  },
  {
    name: 'btr ax,4 -- clears, CF was set',
    regs: { ax: 0x0010 },
    code: [0x0F, 0xBA, RR(BTR, 0), 4],
    want: (dv, vm) => vm.get('ax') === 0x0000 && CF(vm) === 1,
  },
  {
    name: 'btc ax,15 twice -- back where it started',
    regs: { ax: 0x1234 },
    code: [0x0F, 0xBA, RR(BTC, 0), 15, 0x0F, 0xBA, RR(BTC, 0), 15],
    want: (dv, vm) => vm.get('ax') === 0x1234,
  },
  {
    // The index wraps to the operand width, so bit 17 of AX is bit 1 -- and
    // nothing outside AX is touched.
    name: 'bts ax,17 -- index masked to 16 bits',
    regs: { ax: 0x0000, bx: 0xFFFF },
    code: [0x0F, 0xBA, RR(BTS, 0), 17],
    want: (dv, vm) => vm.get('ax') === 0x0002 && vm.get('bx') === 0xFFFF,
  },

  // --- register destination, index from a register --------------------------
  {
    name: 'bt bx,cx -- index in a register',
    regs: { bx: 0x0100, cx: 8 },
    code: [0x0F, 0xA3, RR(1, 3)],           // reg=cx, rm=bx
    want: (dv, vm) => CF(vm) === 1,
  },
  {
    name: 'btr bx,cx -- clears the named bit',
    regs: { bx: 0x0100, cx: 8 },
    code: [0x0F, 0xB3, RR(1, 3)],
    want: (dv, vm) => vm.get('bx') === 0 && CF(vm) === 1,
  },

  // --- memory destination ---------------------------------------------------
  {
    name: 'bt word [addr],3 -- immediate index',
    pre: (dv) => dv.setUint16(DATA, 0x0008, true),
    code: [0x0F, 0xBA, MM(BT), ...D(DATA), 3],
    want: (dv, vm) => CF(vm) === 1,
  },
  {
    name: 'bts word [addr],9 -- writes the second byte',
    pre: (dv) => dv.setUint16(DATA, 0x0000, true),
    code: [0x0F, 0xBA, MM(BTS), ...D(DATA), 9],
    want: (dv, vm) => dv.getUint16(DATA, true) === 0x0200 && CF(vm) === 0,
  },
  {
    // 20 is past the end of the addressed word: a memory bit offset is not
    // masked, it addresses forward.
    name: 'bt [addr],ax with ax=20 -- reaches past the word',
    pre: (dv) => { dv.setUint32(DATA, 0, true); dv.setUint8(DATA + 2, 0x10); },
    regs: { ax: 20 },
    code: [0x0F, 0xA3, MM(0), ...D(DATA)],
    want: (dv, vm) => CF(vm) === 1,
  },
  {
    name: 'bt [addr],ax with ax=-1 -- reaches BACKWARD',
    pre: (dv) => { dv.setUint8(DATA - 1, 0x80); dv.setUint16(DATA, 0, true); },
    regs: { ax: 0xFFFF },
    code: [0x0F, 0xA3, MM(0), ...D(DATA)],
    want: (dv, vm) => CF(vm) === 1,
  },
  {
    name: 'btc [addr],ax with ax=20 -- flips the far byte, leaves the word',
    pre: (dv) => { dv.setUint32(DATA, 0, true); },
    regs: { ax: 20 },
    code: [0x0F, 0xBB, MM(0), ...D(DATA)],
    want: (dv, vm) => dv.getUint8(DATA + 2) === 0x10
      && dv.getUint16(DATA, true) === 0 && CF(vm) === 0,
  },

  // --- 32-bit operand size --------------------------------------------------
  {
    // MOV EAX,imm32 first, because vm.set() is a 16-bit door.
    name: 'bt eax,16 with the 66 prefix',
    code: [0x66, 0xB8, 0x00, 0x00, 0x01, 0x00,   // mov eax, 0x00010000
      0x66, 0x0F, 0xBA, RR(BT, 0), 16],
    want: (dv, vm) => CF(vm) === 1,
  },
  {
    name: 'bts eax,31 -- reaches the top of the 32-bit register',
    code: [0x66, 0xB8, 0x00, 0x00, 0x00, 0x00,
      0x66, 0x0F, 0xBA, RR(BTS, 0), 31],
    want: (dv, vm) => (vm.raw('ax') >>> 0) === 0x80000000 && CF(vm) === 0,
  },
  {
    name: 'bts dword [addr],31',
    pre: (dv) => dv.setUint32(DATA, 0, true),
    code: [0x66, 0x0F, 0xBA, MM(BTS), ...D(DATA), 31],
    want: (dv) => dv.getUint32(DATA, true) === 0x80000000,
  },

  // --- bit scan -------------------------------------------------------------
  {
    name: 'bsf cx,ax -- lowest set bit',
    regs: { ax: 0x0180, cx: 0 },
    code: [0x0F, 0xBC, RR(1, 0)],            // reg=cx (dest), rm=ax (src)
    want: (dv, vm) => vm.get('cx') === 7 && ZF(vm) === 0,
  },
  {
    name: 'bsr cx,ax -- highest set bit',
    regs: { ax: 0x0180, cx: 0 },
    code: [0x0F, 0xBD, RR(1, 0)],
    want: (dv, vm) => vm.get('cx') === 8 && ZF(vm) === 0,
  },
  {
    // A zero source sets ZF and leaves the destination ALONE. Zeroing it is the
    // tempting simplification and is not what the part does.
    name: 'bsf cx,ax with ax=0 -- ZF set, cx untouched',
    regs: { ax: 0, cx: 0x1234 },
    code: [0x0F, 0xBC, RR(1, 0)],
    want: (dv, vm) => vm.get('cx') === 0x1234 && ZF(vm) === 1,
  },
  {
    name: 'bsr cx,[addr] -- memory source',
    pre: (dv) => dv.setUint16(DATA, 0x0400, true),
    regs: { cx: 0 },
    code: [0x0F, 0xBD, MM(1), ...D(DATA)],
    want: (dv, vm) => vm.get('cx') === 10 && ZF(vm) === 0,
  },
];

async function main() {
  const variant = arg('variant', 'tailcall');
  // The decoder defaults to an 8088, where 0F is POP CS and 66 is not a prefix.
  setCpuLevel(386);
  const vm = await makeVm(variant);
  const dv = new DataView(vm.mem.buffer);
  let pass = 0;

  for (const c of CASES) {
    vm.mem.fill(0);
    vm.setAll({
      cs: 0, ip: CODE, ds: 0, es: 0, ss: 0, sp: 0xFFF0, flags: 0xF002, ...(c.regs || {}),
    });
    if (c.pre) c.pre(dv);
    for (let i = 0; i < c.code.length; i++) vm.mem[CODE + i] = c.code[i];

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
