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
const { loadOpcode, parseOps } = require('../fetch-cputests');
const { VARIANTS } = require('./emit');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

function hex(v, w = 4) { return '0x' + (v >>> 0).toString(16).padStart(w, '0'); }

// Which flag bits the 8086 leaves undefined for a given mnemonic. ADD defines
// all of them, so this is empty today -- but the moment MUL/DIV/shifts arrive
// their undefined bits must be named here rather than quietly ignored, and the
// gate reports what it masked.
const UNDEFINED_FLAGS = {};

async function main() {
  const variant = arg('variant', 'tailcall');
  if (!VARIANTS.includes(variant)) {
    console.error(`unknown variant ${variant}; have ${VARIANTS.join(', ')}`);
    process.exit(2);
  }
  const ops = parseOps(arg('ops', '00-05'));
  const limit = Number(arg('limit', 0)) || Infinity;
  const verbose = flag('verbose');

  const vm = await makeVm(variant);
  let total = 0, pass = 0, unimpl = 0;
  const failures = [];

  for (const op of ops) {
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

      const mask = UNDEFINED_FLAGS[t.name.split(/\s+/)[0]] || 0;
      const bad = [];

      // Every register the corpus lists must match.
      for (const [k, want] of Object.entries(t.final.regs)) {
        if (k === 'queue') continue;
        const got = after[k];
        if (got === undefined) continue;
        if (k === 'flags') {
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
        if (after[k] !== before[k]) bad.push(`${k} moved ${hex(before[k])}->${hex(after[k])} but corpus says unchanged`);
      }
      // Memory the corpus says changed.
      for (const [addr, want] of (t.final.ram || [])) {
        const got = vm.mem[addr & 0xFFFFF];
        if (got !== want) bad.push(`ram[${hex(addr, 5)}] want=${hex(want, 2)} got=${hex(got, 2)}`);
      }

      if (bad.length === 0) { opPass++; pass++; }
      else if (failures.length < 10) {
        failures.push({ op, name: t.name, bytes: t.bytes, bad });
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
      for (const b of f.bad) console.log(`      ${b}`);
    }
  }

  const ran = total - unimpl;
  console.log(`\nvariant=${variant}  ${pass}/${ran} pass`
    + (unimpl ? `, ${unimpl} skipped as unimplemented` : '')
    + `  (${ran ? (100 * pass / ran).toFixed(3) : 0}%)`);
  process.exit(pass === ran && ran > 0 ? 0 : 1);
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
