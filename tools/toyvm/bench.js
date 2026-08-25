#!/usr/bin/env node

'use strict';

// Time the dispatch variants against each other on the same compiled program.
//
//   node tools/toyvm/bench.js
//   node tools/toyvm/bench.js --reps=9 --dispatches=20000000 --shape=mixed
//
// Method, inherited from docs/loop-microbench-harness.md because it was paid
// for the hard way: all arms live in ONE process, they alternate every rep, the
// order rotates within the round, and minima are reported rather than means.
// The +-1% floor that buys only holds inside a process -- an unchanged build
// measured across separate invocations spread 44% against itself on this box.
// Every variant here is a different module in the same node process, so that
// boundary is not crossed.

const { performance } = require('perf_hooks');
const { makeVm } = require('./vm');
const { compileProgram, install } = require('./compile');
const { VARIANTS } = require('./emit');
const isa = require('./isa');

function arg(name, d) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? d : hit.slice(name.length + 3);
}

// ---------------------------------------------------------------------------
// Hand-assembled guest programs. Kept as raw bytes rather than built by an
// assembler so that what is executed is exactly what is written here.
// ---------------------------------------------------------------------------
const SHAPES = {
  // A load / ALU / store loop with a counted inner loop and an outer repeat.
  // Seven dispatches per element, touching memory both ways and writing flags
  // on three of them -- close to the op mix a real inner loop produces.
  mixed: {
    org: 0x100,
    perIter: 7,
    bytes: [
      0xBB, 0x34, 0x12,             // mov bx, 0x1234
      0xBD, 0xFF, 0xFF,             // mov bp, 0xFFFF     (outer repeat count)
      // outer:  (0x106)
      0xB9, 0x00, 0x08,             // mov cx, 0x0800
      0xBE, 0x00, 0x10,             // mov si, 0x1000
      // inner:  (0x10C)
      0x8B, 0x04,                   // mov ax, [si]
      0x01, 0xD8,                   // add ax, bx
      0x31, 0xC2,                   // xor dx, ax
      0x89, 0x04,                   // mov [si], ax
      0x46,                         // inc si
      0x46,                         // inc si
      0xE2, 0xF4,                   // loop inner
      0x4D,                         // dec bp
      0x75, 0xEB,                   // jnz outer
      0xF4,                         // hlt -- unimplemented, ends the trace
    ],
  },

  // Register-only ALU: no memory traffic at all, so the dispatch share of each
  // op is as high as this ISA can make it. The ceiling case.
  alu: {
    org: 0x100,
    perIter: 5,
    bytes: [
      0xBD, 0xFF, 0xFF,             // mov bp, 0xFFFF
      // outer: (0x103)
      0xB9, 0x00, 0x08,             // mov cx, 0x0800
      // inner: (0x106)
      0x01, 0xD8,                   // add ax, bx
      0x31, 0xC2,                   // xor dx, ax
      0x29, 0xC8,                   // sub ax, cx
      0x39, 0xD8,                   // cmp ax, bx
      0xE2, 0xF6,                   // loop inner
      0x4D,                         // dec bp
      0x75, 0xF0,                   // jnz outer
      0xF4,
    ],
  },

  // Memory streaming: every op touches memory. The floor case, where dispatch
  // is the smallest share of the work.
  mem: {
    org: 0x100,
    perIter: 5,
    bytes: [
      0xBD, 0xFF, 0xFF,             // mov bp, 0xFFFF
      // outer: (0x103)
      0xB9, 0x00, 0x08,             // mov cx, 0x0800
      0xBE, 0x00, 0x10,             // mov si, 0x1000
      // inner: (0x109)
      0x8B, 0x04,                   // mov ax, [si]
      0x03, 0x44, 0x02,             // add ax, [si+2]
      0x89, 0x44, 0x04,             // mov [si+4], ax
      0x46,                         // inc si
      0xE2, 0xF6,                   // loop inner
      0x4D,                         // dec bp
      0x75, 0xEE,                   // jnz outer
      0xF4,
    ],
  },
};

function loadShape(vm, shape) {
  const s = SHAPES[shape];
  if (!s) throw new Error(`unknown shape ${shape}; have ${Object.keys(SHAPES).join(', ')}`);
  vm.mem.fill(0);
  // cs = 0, so the guest's linear addresses are its offsets.
  for (let i = 0; i < s.bytes.length; i++) vm.mem[s.org + i] = s.bytes[i];
  // Give the data window something non-zero to chew on, so nothing degenerates
  // into a loop over a page of zeroes.
  for (let i = 0; i < 0x2000; i++) vm.mem[0x1000 + i] = (i * 7 + 13) & 0xFF;
  vm.setAll({ ax: 0, bx: 0, cx: 0, dx: 0, sp: 0xFFFE, bp: 0, si: 0, di: 0, cs: 0, ss: 0, ds: 0, es: 0, flags: isa.FLAGS_RESERVED });
  const prog = compileProgram((lin) => vm.mem[lin], 0, s.org);
  install(vm, prog);
  return prog;
}

async function main() {
  const shape = arg('shape', 'mixed');
  const reps = Number(arg('reps', 7));
  const dispatches = Number(arg('dispatches', 20e6));
  const variants = (arg('variants', VARIANTS.join(','))).split(',');

  const vms = {};
  for (const v of variants) vms[v] = await makeVm(v);

  // Compile once per variant and report the program, so a difference in what is
  // executed cannot masquerade as a difference in speed.
  const progs = {};
  for (const v of variants) progs[v] = loadShape(vms[v], shape);
  const sizes = new Set(variants.map(v => progs[v].words.join(',')));
  if (sizes.size !== 1) {
    console.error('ABORT: variants compiled different op streams');
    process.exit(1);
  }
  const p0 = progs[variants[0]];
  console.log(`shape=${shape}  ops=${p0.words.length} words  blocks=${p0.blocks.size}`
    + `  unresolved=${p0.unresolved}  trace ends at ${p0.unimplemented.map(x => '0x' + x.toString(16)).join(',')}`);
  console.log(`dispatches/run=${(dispatches / 1e6).toFixed(1)}M  reps=${reps}  variants=${variants.join(',')}\n`);

  const times = {};
  for (const v of variants) times[v] = [];

  // Warm up every arm before any of them is timed, so tier-up cost lands
  // outside the measurement for all of them equally.
  for (const v of variants) {
    loadShape(vms[v], shape);
    vms[v].exports.run(progs[v].entryAddr, 2e6);
  }

  for (let r = 0; r < reps; r++) {
    // Rotate the order every rep: a fixed order lets a warming machine credit
    // the same arm every time.
    const order = variants.map((_, i) => variants[(i + r) % variants.length]);
    for (const v of order) {
      loadShape(vms[v], shape);
      const t0 = performance.now();
      vms[v].exports.run(progs[v].entryAddr, dispatches);
      const t1 = performance.now();
      times[v].push(t1 - t0);
    }
  }

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const base = variants[0];
  const baseMin = Math.min(...times[base]);

  console.log('variant          min ms   med ms   ns/dispatch   vs ' + base);
  for (const v of variants) {
    const mn = Math.min(...times[v]);
    console.log(`${v.padEnd(14)} ${mn.toFixed(1).padStart(8)} ${med(times[v]).toFixed(1).padStart(8)}`
      + `   ${(mn * 1e6 / dispatches).toFixed(2).padStart(11)}`
      + `   ${((mn / baseMin - 1) * 100).toFixed(1).padStart(6)}%`);
  }
  console.log('\nMinima, one process, arms alternated with the order rotated each rep.');
  console.log('Do NOT quote these as app-level numbers: multiply by the profile share');
  console.log('of the machinery they exercise (docs/performance-summary.md 4.3).');
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
