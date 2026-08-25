#!/usr/bin/env node

'use strict';

// Run the toy VM against SingleStepTests/8088 -- per-instruction ground truth
// recorded off a physical AMD D8088.
//
//   node tools/toyvm/gate.js --ops=00-05
//   node tools/toyvm/gate.js --ops=01 --variant=switch --limit=2000 --verbose
//
// A `final` state in that corpus is a DELTA: only registers that changed are
// listed, with the whole flags word present if any flag moved. So the check is
// two-sided -- every listed register must match, and every register NOT listed
// must be unchanged from its initial value. Checking only the listed ones would
// pass a VM that scribbled on bx.

const { makeVm, REGS } = require('./vm');
const { loadOpcode, parseOps, listRemote, CACHE } = require('../fetch-cputests');
const { VARIANTS } = require('./emit');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

function hex(v, w = 4) { return '0x' + (v >>> 0).toString(16).padStart(w, '0'); }

// Which flag bits the 8086 leaves architecturally UNDEFINED for a given
// mnemonic. The corpus records what the physical part happened to do, which is
// not something an emulator is obliged to reproduce -- but ignoring a flag
// silently is how a real bug hides, so every masked bit is named here and
// counted in the summary.
const CF = 1 << 0, PF = 1 << 2, AF = 1 << 4, ZF = 1 << 6, SF = 1 << 7, OF = 1 << 11;
const UNDEFINED_FLAGS = {
  // AND/OR/XOR/TEST clear CF and OF and define SF/ZF/PF; AF is undefined.
  and: AF, or: AF, xor: AF, test: AF,
  // Shifts and rotates: AF is undefined throughout, and OF is defined only for
  // a count of one. The corpus mixes both counts in one file, so OF is masked
  // for the CL forms via the byte check below rather than by mnemonic.
  rol: AF, ror: AF, rcl: AF, rcr: AF, shl: AF, sal: AF, shr: AF, sar: AF,
  // MUL/IMUL/DIV/IDIV define CF and OF only; the rest is undefined, and DIV
  // defines nothing at all.
  mul: SF | ZF | AF | PF, imul: SF | ZF | AF | PF,
  div: CF | PF | AF | ZF | SF | OF, idiv: CF | PF | AF | ZF | SF | OF,
  // The decimal adjusts. DAA/DAS define everything but OF; AAA/AAS define only
  // CF and AF; AAM/AAD define only SF, ZF and PF.
  daa: OF, das: OF,
  aaa: OF | SF | ZF | PF, aas: OF | SF | ZF | PF,
  aam: OF | AF | CF, aad: OF | AF | CF,
};

// OF after a multi-bit shift is undefined. D2/D3 take the count from CL, and
// D0/D1 always shift by one, so the opcode byte is the discriminator.
function extraMask(t) {
  const op = t.bytes.find(b => b >= 0xD0 && b <= 0xD3);
  return (op === 0xD2 || op === 0xD3) ? OF : 0;
}

async function main() {
  const variant = arg('variant', 'tailcall');
  if (!VARIANTS.includes(variant)) {
    console.error(`unknown variant ${variant}; have ${VARIANTS.join(', ')}`);
    process.exit(2);
  }
  // --all is the coverage census: every opcode file the suite has, at whatever
  // --limit says. It reports two separate numbers per opcode -- how much is
  // implemented, and how much of what IS implemented is correct -- because
  // conflating them is how a decoder that quietly refuses half the encodings
  // scores 100%.
  const ops = flag('all')
    ? (await listRemote()).map(e => e.name).sort()
    : parseOps(arg('ops', '00-05'));
  const limit = Number(arg('limit', 0)) || Infinity;
  const verbose = flag('verbose');
  // How many failures to keep for the report. Ten is enough to see that
  // something is wrong; working out WHICH inputs a flag rule is wrong for needs
  // the whole set, so the cap is adjustable.
  const maxFails = Number(arg('fails', 10));

  const vm = await makeVm(variant);
  let total = 0, pass = 0, unimpl = 0, masked = 0;
  const failures = [];

  for (const op of ops) {
    // D8-DF were recorded on a board with no 8087 fitted, so the corpus
    // documents ESC as a dummy memory read that changes nothing. The VM models
    // a coprocessor, so agreeing with those vectors would mean NOT having an
    // FPU. They pass today only because a store lands at an address the vector
    // does not list and unlisted memory is not checked -- which is luck, not a
    // result. tools/toyvm/fpu-check.js is the real gate for these.
    if (/^D[89A-Fa-f]/i.test(op)) {
      console.log(`${op}  ${' '.repeat(6)}skipped -- no 8087 on the recording board; `
        + `see tools/toyvm/fpu-check.js`);
      continue;
    }
    const tests = await loadOpcode(op, { quiet: true });
    let opPass = 0, opTotal = 0, opUnimpl = 0;

    for (const t of tests.slice(0, Math.min(tests.length, limit))) {
      opTotal++; total++;

      // Initial state: registers, then the RAM the instruction needs. RAM is
      // physical (20-bit) and includes the instruction bytes themselves.
      vm.mem.fill(0);
      vm.setAll(t.initial.regs);
      for (const [addr, byte] of t.initial.ram) vm.mem[addr & 0xFFFFF] = byte;

      const before = vm.getAll();
      if (!vm.stepOne()) { opUnimpl++; unimpl++; continue; }
      const after = vm.getAll();

      const mnem = t.name.split(/\s+/)[0].replace(/^(rep|repe|repne|repnz|repz|lock)\s*/, '');
      const mask = (UNDEFINED_FLAGS[mnem] || 0) | extraMask(t);
      const bad = [];

      // Every register the corpus lists must match.
      for (const [k, want] of Object.entries(t.final.regs)) {
        if (k === 'queue') continue;
        const got = after[k];
        if (got === undefined) continue;
        if (k === 'flags') {
          if (mask && ((got ^ want) & mask) !== 0) masked++;
          if (((got ^ want) & ~mask & 0xFFFF) !== 0) {
            bad.push(`flags want=${hex(want)} got=${hex(got)} diff=${hex((got ^ want) & ~mask & 0xFFFF)}`);
          }
        } else if (got !== (want & 0xFFFF)) {
          bad.push(`${k} want=${hex(want)} got=${hex(got)}`);
        }
      }
      // And every register it does NOT list must be untouched.
      for (const k of Object.keys(before)) {
        if (t.final.regs[k] !== undefined) continue;
        // "Unchanged" is subject to the same undefined-flag mask: the corpus
        // omitting flags means the real part left them alone, which for an
        // undefined bit is one permitted outcome among several.
        const m = k === 'flags' ? mask : 0;
        if (((after[k] ^ before[k]) & ~m & 0xFFFF) !== 0) {
          bad.push(`${k} moved ${hex(before[k])}->${hex(after[k])} but corpus says unchanged`);
        } else if (after[k] !== before[k]) masked++;
      }
      // Memory the corpus says changed.
      //
      // One exception: a divide error pushes FLAGS, and DIV/IDIV leave every
      // flag undefined, so those two stack bytes carry whatever garbage the
      // real part's microcode left behind. The pushed CS and IP are checked
      // normally -- it is only the flags word that is not a specification.
      let skipLo = -1;
      if ((mnem === 'div' || mnem === 'idiv') && after.ip !== undefined) {
        const sp = after.sp, ss = after.ss;
        if (sp !== undefined && ss !== undefined) skipLo = ((ss << 4) + ((sp + 4) & 0xFFFF)) & 0xFFFFF;
      }
      for (const [addr, want] of (t.final.ram || [])) {
        const a = addr & 0xFFFFF;
        const got = vm.mem[a];
        if (got === want) continue;
        if (skipLo >= 0 && (a === skipLo || a === ((skipLo + 1) & 0xFFFFF))) { masked++; continue; }
        bad.push(`ram[${hex(a, 5)}] want=${hex(want, 2)} got=${hex(got, 2)}`);
      }

      if (bad.length === 0) { opPass++; pass++; }
      else if (failures.length < maxFails) {
        // The entry state is part of the report: a flag rule that is wrong for
        // one input range cannot be diagnosed from the outputs alone.
        failures.push({ op, name: t.name, bytes: t.bytes, bad, before });
      }
    }

    const ran = opTotal - opUnimpl;
    const rate = ran ? (100 * opPass / ran).toFixed(2) : '  n/a';
    console.log(`${op}  ${String(opPass).padStart(6)}/${String(ran).padEnd(6)} ${rate}%`
      + (opUnimpl ? `   (${opUnimpl} not implemented)` : ''));
  }

  if (verbose || failures.length) {
    for (const f of failures) {
      console.log(`\n  ${f.op} "${f.name}"  bytes=${f.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      console.log(`      in: ax=${hex(f.before.ax)} flags=${hex(f.before.flags)}`);
      for (const b of f.bad) console.log(`      ${b}`);
    }
  }

  const ran = total - unimpl;
  console.log(`\nvariant=${variant}  ${pass}/${ran} pass`
    + (unimpl ? `, ${unimpl} skipped as unimplemented` : '')
    + `  (${ran ? (100 * pass / ran).toFixed(3) : 0}%)`);
  if (masked) {
    console.log(`${masked} case(s) differed ONLY in a flag the 8086 leaves `
      + `undefined for that mnemonic (see UNDEFINED_FLAGS) and were accepted on that basis.`);
  }
  process.exit(pass === ran && ran > 0 ? 0 : 1);
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
