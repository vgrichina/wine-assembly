#!/usr/bin/env node

'use strict';

// Decode the same bytes with both decoders and diff the word streams.
//
//   node tools/toyvm/decode-diff.js --random=20000
//   node tools/toyvm/decode-diff.js --exe=/tmp/demos/1995-b-bc_dtm2/DTM2.EXE
//   node tools/toyvm/decode-diff.js --bytes=8b0e3412 --verbose
//
// The wasm decoder (tools/toyvm/emit-decoder.js) is allowed to be incomplete:
// it declines what it does not implement and the host falls back to the JS one.
// What it is NOT allowed to be is WRONG about something it claims, and that is
// the only failure this looks for. A decline is reported as coverage, never as
// a mismatch.
//
// This is the companion to gate.js and answers a different question. The gate
// runs instructions against recorded 8088 hardware and catches a bad decode by
// way of a wrong final register state -- which names the instruction that RAN,
// not the one that decoded wrong, and says nothing at all about an encoding
// whose two decodings happen to behave the same on the one case tested. This
// compares the artefact directly, so a mismatch names the opcode.

const fs = require('fs');
const isa = require('./isa');
const { makeVm } = require('./vm');
const { setCpuLevel, decodeOne } = require('./decode');

function arg(n, d) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${n}=`));
  return hit === undefined ? d : hit.slice(n.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

const hex = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');

// Kept in step with STOP in emit-decoder.js by the one test below that asserts
// a known-unimplemented opcode reports it.
const STOP_UNIMPL = 2;

// One case: bytes laid into guest memory at a fixed spot, decoded both ways.
//
// The two decoders are pointed at the SAME memory -- the wasm one reads the
// instance's linear memory and the JS one reads it through a closure over the
// same Uint8Array -- so a difference can only come from the decoding, never
// from the two seeing different bytes.
const CS = 0x1000;
const IP = 0x100;

// ONE INSTRUCTION at a time, not one block. The block-at-a-time version of this
// measured almost nothing: a block ends at the first opcode either decoder
// declines, so a random case nearly always declined somewhere in the middle and
// 99.2% of cases went untested. Comparing single instructions tests exactly the
// thing that has to agree, and the wasm side's stop reason is checked too --
// getting the words right and the instruction LENGTH wrong is a decoder that
// resumes the next instruction mid-encoding, which is the worst way to be wrong.
function runCase(vm, bytes) {
  const base = CS << 4;
  vm.mem.fill(0, base + IP, base + IP + 64);
  vm.mem.set(bytes, base + IP);

  const arena = isa.THREAD_BASE;
  const maxWords = 1024;

  // The wasm side first, because it is the one that can decline.
  const n = vm.exports.compile_block(IP, base, 0xFFFFF, 0, arena, maxWords, 1, 0);
  if (vm.exports.dc_stopped() === STOP_UNIMPL) return { declined: true };

  const got = [...new Int32Array(vm.mem.buffer, arena, n)];
  const gotNext = vm.exports.dc_stop_ip();
  const modrm = {
    isreg: vm.exports.dc_isreg(), ea: vm.exports.dc_ea(), disp: vm.exports.dc_disp(),
    rm: vm.exports.dc_rm(), reg: vm.exports.dc_reg(), asize: vm.exports.dc_asize(),
    n: gotNext - IP,
  };

  // ...and the JS side. decodeOne is the same unit, so no block bookkeeping sits
  // between the two answers: compileProgram would wrap this in a trace-cache
  // layout whose end markers and fall-through contiguity are the HOST's rules,
  // not the decoder's, and a difference there would read as a decode bug.
  const d = decodeOne((lin) => vm.mem[lin], CS, IP, base, 0xFFFFF, false);
  if (d === null) return { jsDeclined: true, got, modrm };
  const want = d.words.slice();
  if (gotNext !== d.nextIp) {
    return { declined: false, got, want, lenGot: gotNext, lenWant: d.nextIp, modrm };
  }

  // A branch's target and fall-through slots hold a 0 placeholder that the host
  // patches to an arena address later, and the fixup list says which words
  // those are. Both sides are blanked so what is compared is the opcode stream.
  const blank = (words, fixups) => {
    const out = words.slice();
    for (const f of fixups) out[f.index !== undefined ? f.index : f] = 0;
    return out;
  };
  const wantBlank = blank(want, d.fixups || []);
  const nfix = vm.exports.dc_fixups();
  const gotFix = [];
  for (let i = 0; i < nfix; i++) {
    gotFix.push(new Int32Array(vm.mem.buffer,
      isa.DEC_FIXUPS + i * isa.DEC_FIXUP_WORDS * 4, isa.DEC_FIXUP_WORDS)[0]);
  }
  const gotBlank = blank(got, gotFix);

  return { declined: false, got: gotBlank, want: wantBlank, raw: got, modrm };
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if ((a[i] | 0) !== (b[i] | 0)) return false;
  return true;
}

// Random encodings, weighted toward the shapes that actually occur: a uniform
// random 16 bytes is almost always an instruction neither decoder implements,
// which measures nothing. Seeding the first byte from the implemented opcode
// space and filling the rest randomly exercises the ModRM and immediate paths,
// which is where a decoder is actually wrong.
const INTERESTING = [];
for (let op = 0x00; op < 0x40; op++) if ((op & 7) < 6) INTERESTING.push(op);
for (const op of [0x80, 0x81, 0x82, 0x83, 0x88, 0x89, 0x8A, 0x8B, 0xC6, 0xC7]) {
  INTERESTING.push(op);
}
for (let op = 0x70; op <= 0x7F; op++) INTERESTING.push(op);
const PREFIXES = [0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3];

// A deterministic generator: a seeded xorshift, so a failing run is a failing
// run again rather than a story about one that used to fail.
function rng(seed) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

function randomCase(r) {
  const bytes = [];
  // A prefix, sometimes, and occasionally two -- the last of each kind wins and
  // that rule is exactly the sort of thing two decoders disagree about.
  while (r() < 0.25 && bytes.length < 3) {
    bytes.push(PREFIXES[Math.floor(r() * PREFIXES.length)]);
  }
  bytes.push(INTERESTING[Math.floor(r() * INTERESTING.length)]);
  for (let i = 0; i < 8; i++) bytes.push(Math.floor(r() * 256));
  // A terminator so a stream that runs off the end of the case stops rather
  // than decoding whatever the last case left behind. 0xF4 is HLT, which both
  // decoders end a block on.
  bytes.push(0xF4);
  return Uint8Array.from(bytes);
}

async function main() {
  setCpuLevel(Number(arg('cpu', 386)));
  const vm = await makeVm('tailcall');

  const cases = [];
  if (arg('bytes')) {
    const s = arg('bytes').replace(/[^0-9a-fA-F]/g, '');
    const b = [];
    for (let i = 0; i + 1 < s.length; i += 2) b.push(parseInt(s.slice(i, i + 2), 16));
    b.push(0xF4);
    cases.push(Uint8Array.from(b));
  } else if (arg('exe')) {
    // Every offset in the file, as if it were an instruction. Most are not, and
    // that is the point: a decoder is asked to decode whatever the guest jumps
    // to, and misaligned starts are where real programs land after a computed
    // jump into a jump table.
    const buf = fs.readFileSync(arg('exe'));
    const step = Number(arg('step', 1));
    for (let i = 0; i + 16 < buf.length; i += step) {
      cases.push(Uint8Array.from([...buf.subarray(i, i + 12), 0xF4]));
    }
  } else {
    const r = rng(Number(arg('seed', 12345)));
    const n = Number(arg('random', 20000));
    for (let i = 0; i < n; i++) cases.push(randomCase(r));
  }

  let declined = 0, matched = 0;
  const fails = [];
  for (const bytes of cases) {
    let res;
    try {
      res = runCase(vm, bytes);
    } catch (e) {
      fails.push({ bytes, err: String(e.message || e) });
      continue;
    }
    if (res.declined) { declined++; continue; }
    // wasm decoded something the JS decoder refuses. That is never acceptable
    // whichever one is right: the host falls back to JS on a decline, so an
    // encoding only wasm claims is one the VM would run two different ways
    // depending on which decoder saw it first.
    if (res.jsDeclined) {
      fails.push({ bytes, got: res.got, want: [], modrm: res.modrm, note: 'js declines this' });
      continue;
    }
    if (same(res.got, res.want)) { matched++; continue; }
    fails.push({ bytes, got: res.got, want: res.want, modrm: res.modrm });
  }

  const total = cases.length;
  const covered = total - declined;
  console.log(`${total} cases: ${matched} match, ${fails.length} MISMATCH, `
    + `${declined} declined (${(100 * covered / total).toFixed(1)}% claimed by wasm)`);

  for (const f of fails.slice(0, Number(arg('show', 10)))) {
    console.log(`\n  bytes ${[...f.bytes].map(b => hex(b)).join(' ')}`);
    if (f.err) { console.log(`    threw: ${f.err}`); continue; }
    if (f.note) console.log(`    ${f.note}`);
    if (f.lenGot !== undefined) {
      console.log(`    next ip: wasm 0x${hex(f.lenGot, 4)}, js 0x${hex(f.lenWant, 4)}`
        + ` -- the two disagree about the instruction's LENGTH`);
    }
    console.log(`    wasm  ${f.got.map(w => hex(w, 8)).join(' ')}`);
    console.log(`    js    ${f.want.map(w => hex(w, 8)).join(' ')}`);
    if (f.modrm) {
      console.log(`    modrm isreg=${f.modrm.isreg} ea=0x${hex(f.modrm.ea, 4)}`
        + ` disp=0x${hex(f.modrm.disp, 4)} rm=${f.modrm.rm} reg=${f.modrm.reg}`
        + ` asize=${f.modrm.asize} n=${f.modrm.n}`);
    }
  }
  if (fails.length > Number(arg('show', 10))) {
    console.log(`\n  ...and ${fails.length - Number(arg('show', 10))} more`);
  }
  // A run that claims nothing is not a pass, however few mismatches it found.
  if (covered === 0) {
    console.log('\nFAIL: the wasm decoder claimed no case at all.');
    process.exit(1);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
