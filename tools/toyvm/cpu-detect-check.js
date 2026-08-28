#!/usr/bin/env node

'use strict';

// Does a guest asking "what CPU am I on?" get the right answer?
//
//   node tools/toyvm/cpu-detect-check.js [--variant=tailcall] [--verbose]
//
// Nearly every program in the DOS corpus opens with the same ladder, and it is
// made entirely of PUSHF and POPF:
//
//   pushf / pop bx           save the flags
//   ah &= 0x0F / push / popf clear bits 12-15
//   pushf / pop ax           read them back -- still set means 8086
//   bh |= 0xF0 / push / popf set bits 12-15
//   pushf / pop ax           read them back -- all clear means 286
//   pushfd ... 0x40000 ...   toggle AC to tell a 386 from a 486
//
// It works because the reserved half of FLAGS reads differently on each part,
// which makes it the one place where "which bits does POPF actually write"
// stops being a detail and becomes the difference between a demo running its
// 386 code path and taking the "sorry, needs a 386" exit. gate.js cannot ask
// this question: its vectors come off an 8088, where bits 12-15 always read 1,
// so it pins exactly the behaviour a 386 must NOT have.
//
// The ladder is asserted a rung at a time rather than run whole, because a
// wrong answer at the first rung and a wrong answer at the third produce the
// same CL and a completely different diagnosis.

const { makeVm } = require('./vm');
const { setCpuLevel } = require('./decode');

const CODE = 0x1000;

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const verbose = process.argv.slice(2).includes('--verbose');

const PUSHF = [0x9C];
const POPF = [0x9D];
const POP_AX = [0x58];
const POP_BX = [0x5B];
const PUSH_AX = [0x50];
const PUSH_BX = [0x53];
const AND_AH = (v) => [0x80, 0xE4, v];
const OR_BH = (v) => [0x80, 0xCF, v];
const MOV_AX_BX = [0x8B, 0xC3];

// The 8086 rung: clear bits 12-15 and read them back.
const CLEAR_HIGH = [
  ...PUSHF, ...POP_BX, ...MOV_AX_BX, ...AND_AH(0x0F),
  ...PUSH_AX, ...POPF, ...PUSHF, ...POP_AX,
];
// The 286 rung: set bits 12-15 and read them back.
const SET_HIGH = [
  ...PUSHF, ...POP_BX, ...OR_BH(0xF0),
  ...PUSH_BX, ...POPF, ...PUSHF, ...POP_AX,
];

const AH = (vm) => (vm.get('ax') >> 8) & 0xFF;

const CASES = [
  {
    // On an 8086 bits 12-15 cannot be cleared, so AH comes back 0xF0 and the
    // ladder stops here. This is the case gate.js's vectors describe.
    name: '8086: bits 12-15 always read 1',
    cpu: 86,
    code: CLEAR_HIGH,
    want: (vm) => (AH(vm) & 0xF0) === 0xF0,
  },
  {
    // On a 386 they are writable, so clearing them sticks -- and a program that
    // sees 0xF0 here concludes it is on an 8086 and takes the exit.
    name: '386: bits 12-15 clear when cleared (not an 8086)',
    cpu: 386,
    code: CLEAR_HIGH,
    want: (vm) => (AH(vm) & 0xF0) === 0x00,
  },
  {
    // ...and setting them sticks too, except for bit 15, which is 0 on every
    // part from the 386 on. A program that sees 0x00 here concludes 286.
    name: '386: bits 12-14 set when set, bit 15 stays clear (not a 286)',
    cpu: 386,
    code: SET_HIGH,
    want: (vm) => (AH(vm) & 0xF0) === 0x70,
  },
  {
    // The other half of the same claim, read off the flags word rather than
    // through AH: NT and IOPL are real bits a 386 program can write.
    name: '386: POPF writes IOPL and NT',
    cpu: 386,
    code: [...PUSHF, ...POP_BX, ...OR_BH(0xF0), ...PUSH_BX, ...POPF],
    want: (vm) => (vm.get('flags') & 0xF000) === 0x7000,
  },
  {
    // Bits 3 and 5 read 0 on every x86 there has ever been, whatever is pushed.
    name: 'every part: bits 3 and 5 always read 0',
    cpu: 386,
    code: [...PUSHF, ...POP_BX, 0x83, 0xCB, 0x28, ...PUSH_BX, ...POPF],  // or bx,0x28
    want: (vm) => (vm.get('flags') & 0x28) === 0,
  },
  {
    // Bit 1 reads 1 on every x86, whatever is pushed. `and bx,0xFFFD`.
    name: 'every part: bit 1 always reads 1',
    cpu: 386,
    code: [...PUSHF, ...POP_BX, 0x81, 0xE3, 0xFD, 0xFF, ...PUSH_BX, ...POPF],
    want: (vm) => (vm.get('flags') & 0x02) === 0x02,
  },

  // --- the 386-vs-486 rung, which is where the stack goes wrong -------------
  {
    // PUSHFD then POPFD, and SP back where it started. Four bytes each way. If
    // these are decoded as PUSHF/POPF the pair still balances, so the tell is
    // not SP after a matched pair -- it is SP after a single PUSHFD.
    name: '486 rung: PUSHFD moves SP by four',
    cpu: 386,
    code: [0x66, ...PUSHF],
    want: (vm) => vm.get('sp') === 0xFFF0 - 4,
  },
  {
    name: '486 rung: POPFD takes four back',
    cpu: 386,
    code: [0x66, ...PUSHF, 0x66, ...POPF],
    want: (vm) => vm.get('sp') === 0xFFF0,
  },
  {
    // The rung itself: pushfd / pop ebx / mov eax,ebx / xor eax,AC / push eax
    // / popfd / pushfd / pop eax / xor eax,ebx. On a 386 the AC bit does not
    // stick, so the difference is zero and the program stops at 386. What
    // matters here as much as the answer is that EBX still holds the flags it
    // was given -- a two-byte PUSHFD leaves the pops reading each other's
    // halves and EAX comes back as noise.
    name: '486 rung: AC does not stick on a 386, and the stack stays aligned',
    cpu: 386,
    code: [
      0x66, 0x9C,                                // pushfd
      0x66, 0x5B,                                // pop ebx
      0x66, 0x8B, 0xC3,                          // mov eax, ebx
      0x66, 0x35, 0x00, 0x00, 0x04, 0x00,        // xor eax, 0x40000
      0x66, 0x50,                                // push eax
      0x66, 0x9D,                                // popfd
      0x66, 0x9C,                                // pushfd
      0x66, 0x58,                                // pop eax
      0x66, 0x33, 0xC3,                          // xor eax, ebx
    ],
    // Straight off the export: vm.get() masks to 16 bits, and the whole point
    // of this case is the upper half.
    want: (vm) => vm.exports.get_ax() === 0 && vm.get('sp') === 0xFFF0,
  },

  // --- the shift-count rung, which does not go through FLAGS at all ---------
  // Everything above asks the question with PUSHF/POPF. This rung asks it with
  // arithmetic, and we failed it while passing all of those: an 8086 shifts the
  // whole count, so `shr ax,32` clears AX, while every part from the 186 on
  // masks the count to five bits and the same instruction does nothing.
  //
  // COROMER.EXE opens with exactly this and branches on the answer. We shifted
  // 32 times, so it concluded 8086 and ran the 8086-only follow-up two bytes
  // later -- `push cs` and the 0Fh that is POP CS only on that part. The
  // decoder refuses 0F 14, and the run wedged at 110:545 with a blank screen,
  // which reads as a missing instruction and is not one.
  {
    name: '186 rung: a shift count is masked to five bits',
    cpu: 386,
    code: [0xB1, 0x20, 0xB8, 0x01, 0x00, 0xD3, 0xE8],   // mov cl,32; mov ax,1; shr ax,cl
    want: (vm) => vm.get('ax') === 1,
  },
  {
    // The same code on the part gate.js's vectors came off. Both answers are
    // correct and the machine has to be able to give either, which is why the
    // masking is a global set_cpu raises rather than a constant.
    name: '8086: a shift count is not masked',
    cpu: 86,
    code: [0xB1, 0x20, 0xB8, 0x01, 0x00, 0xD3, 0xE8],
    want: (vm) => vm.get('ax') === 0,
  },
];

async function main() {
  const variant = arg('variant', 'tailcall');
  // The decoder defaults to an 8088, where 66 is not a prefix.
  setCpuLevel(386);
  const vm = await makeVm(variant);
  let pass = 0;

  for (const c of CASES) {
    vm.mem.fill(0);
    // set_cpu is the whole subject: it is what raises the FLAGS shape from the
    // 8086's to the 386's, and every case here names which one it expects.
    vm.exports.set_cpu(c.cpu);
    // The starting flags have to be a word the named part could actually be
    // holding: bits 12-15 read 1 on an 8086 and bit 15 reads 0 from the 386
    // on. Starting a 386 case at 0xF002 makes the AC rung come back with the
    // difference in bit 15 and look like a failure of the thing under test.
    vm.setAll({
      cs: 0, ip: CODE, ds: 0, es: 0, ss: 0, sp: 0xFFF0,
      flags: c.cpu >= 386 ? 0x0002 : 0xF002,
    });
    for (let i = 0; i < c.code.length; i++) vm.mem[CODE + i] = c.code[i];

    let refused = null, steps = 0;
    while (vm.get('gip') < CODE + c.code.length && steps++ < 64) {
      if (!vm.stepOne()) { refused = vm.get('gip'); break; }
    }

    let ok = false, err = null;
    if (refused !== null) err = `decoder refused at ip=0x${refused.toString(16)}`;
    else { try { ok = !!c.want(vm); } catch (e) { err = String(e); } }

    if (ok) { pass++; if (verbose) console.log(`  ok    ${c.name}`); }
    else {
      console.log(`  FAIL  ${c.name}${err ? `  (${err})` : ''}`
        + `  ax=${vm.get('ax').toString(16)} flags=${vm.get('flags').toString(16)}`);
    }
  }

  console.log(`\nvariant=${variant}  ${pass}/${CASES.length} pass`);
  process.exit(pass === CASES.length ? 0 : 1);
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
