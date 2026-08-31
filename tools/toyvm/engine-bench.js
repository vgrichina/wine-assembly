#!/usr/bin/env node

'use strict';

// Run the SAME JIT tiers on more than one wasm engine.
//
//   node tools/toyvm/engine-bench.js /tmp/demos/1993-d-daretro/daretro.exe
//   node tools/toyvm/engine-bench.js <exe> --engines=node,sm,jsc,v8 --iters=20000
//   node tools/toyvm/engine-bench.js --bundle=/tmp/eb        # re-run a bundle
//
// WHY. Every toy-VM number this project has ever quoted came out of node's V8.
// "compiling the loop is worth N%" is therefore a statement about one compiler,
// and the two obvious ways it could be an artifact -- V8 already doing the work
// our tier does, or V8 declining an optimization another engine takes -- are
// both invisible from inside it. This hands byte-identical modules and a
// byte-identical starting state to whatever shells are installed and prints one
// row per engine.
//
// It also answers "how does it do WITHOUT a JIT": every engine here can be told
// to stop at its baseline compiler (SpiderMonkey `--wasm-compiler=baseline`,
// d8 `--liftoff --no-wasm-tier-up`, JSC `--useOMGJIT=false`). That is the arm
// that says how much of a tier's win is our own code generation and how much is
// the engine's optimizer finishing the job for us.
//
// WHAT IS MEASURED. tools/toyvm/trace-jit.js's snapshot benchmark, unchanged:
// the hottest block's ops, run from the memory and registers they really had,
// as threaded code (tier 0) and as compiled wasm (tiers 1-3). It does NOT
// measure side exits or compile cost -- see the header of that file. The
// whole-program answer lives in region-jit.js, and it cannot be shipped to a
// shell because it needs the node-side decoder in the loop.
//
// The runner is generated with its parameters baked in as literals, because
// argv reaches a shell script differently in every one of these engines and a
// mis-parsed argument would silently benchmark a default.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { jitTiers } = require('./trace-jit');

function arg(name, d) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? d : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

// `--dispatches=12m`. Number('12m') is NaN, and a NaN budget profiles nothing
// while reporting "no samples", which reads as a program that never ran.
function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`cannot read a count from ${s}`);
  return Math.round(Number(m[1]) * { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()]);
}

// Each entry: how to find the shell, and the flags that select its optimizing
// tier and its baseline-only tier. `null` means the engine has no way to ask.
const ENGINES = [
  { id: 'node', bin: [process.execPath], jit: [], base: ['--liftoff-only'] },
  { id: 'sm', bin: [path.join(os.homedir(), '.jsvu', 'bin', 'sm'), '/opt/homebrew/bin/sm'],
    jit: ['--wasm-compiler=ion'], base: ['--wasm-compiler=baseline'] },
  { id: 'jsc', bin: [path.join(os.homedir(), '.jsvu', 'bin', 'jsc')],
    jit: [], base: ['--useOMGJIT=false'] },
  { id: 'v8', bin: [path.join(os.homedir(), '.jsvu', 'bin', 'v8')],
    jit: [], base: ['--liftoff-only'] },
  { id: 'bun', bin: ['/opt/homebrew/bin/bun', '/usr/local/bin/bun'], jit: [], base: null },
];

function resolve(engine) {
  for (const b of engine.bin) if (b === process.execPath || fs.existsSync(b)) return b;
  return null;
}

// One script, five shells. The only thing that differs between them is how to
// read a file, so that is the only thing that is feature-detected.
function runnerSource(dir, iters, reps) {
  return `
function readBin(p) {
  if (typeof readbuffer === 'function') return new Uint8Array(readbuffer(p));       // d8
  if (typeof os !== 'undefined' && os.file && os.file.readFile) {                   // sm
    return os.file.readFile(p, 'binary');
  }
  if (typeof read === 'function') return new Uint8Array(read(p, 'binary'));         // jsc
  return new Uint8Array(require('fs').readFileSync(p));                             // node, bun
}
function readTxt(p) {
  if (typeof readbuffer === 'function') return String.fromCharCode.apply(null, new Uint8Array(readbuffer(p)));
  if (typeof os !== 'undefined' && os.file && os.file.readFile) return os.file.readFile(p);
  if (typeof read === 'function') return read(p);
  return require('fs').readFileSync(p, 'utf8');
}
var say = (typeof print === 'function') ? print : console.log;
var DIR = ${JSON.stringify(dir)}, ITERS = ${iters}, REPS = ${reps};
var st = JSON.parse(readTxt(DIR + '/state.json'));
var snapshot = readBin(DIR + '/mem.bin');
var arena = new Int32Array(readBin(DIR + '/arena.bin').buffer);
var out = [];
for (var ai = 0; ai < st.arms.length; ai++) {
  var arm = st.arms[ai];
  var mem = new WebAssembly.Memory({ initial: st.pages, maximum: st.pages });
  var inst = new WebAssembly.Instance(new WebAssembly.Module(readBin(DIR + '/' + arm.name + '.wasm')), {
    host: {
      memory: mem,
      port_in: function (p, w) { return w === 16 ? 0xFFFF : 0xFF; },
      port_out: function () {},
      fmath: function () { return 0; },
    },
  });
  var ex = inst.exports, bytes = new Uint8Array(mem.buffer);
  var best = Infinity;
  for (var rep = 0; rep < REPS; rep++) {
    bytes.set(snapshot);
    for (var k in st.machine) if (ex['mset_' + k]) ex['mset_' + k](st.machine[k]);
    for (var r in st.regs) if (ex['set_' + r]) ex['set_' + r](st.regs[r]);
    if (arm.entry === 'run') new Int32Array(mem.buffer, st.arenaBase, arena.length).set(arena);
    var t0 = Date.now();
    if (arm.entry === 'run') { for (var i = 0; i < ITERS; i++) ex.run(st.arenaBase, st.budget); }
    else { for (var j = 0; j < ITERS; j++) ex.spin(1); }
    var ms = Date.now() - t0;
    if (ms < best) best = ms;
  }
  out.push({ name: arm.name, ms: best });
}
say('RESULT' + JSON.stringify(out));
`;
}

async function main() {
  const exe = process.argv.slice(2).find(a => !a.startsWith('--'));
  // One directory per program, so building a second bundle does not quietly
  // overwrite the first and re-run it under another program's name.
  const dir = path.resolve(arg('bundle', path.join(os.tmpdir(),
    `toyvm-eb-${exe ? path.basename(exe).replace(/\W+/g, '_') : 'last'}`)));
  const iters = count(arg('iters'), 1e6);
  const reps = Number(arg('reps', 5));

  if (exe) {
    // Building the bundle runs the profiler and the in-process tier bench; its
    // agreement check is the only thing that says these arms compute the same
    // answer, so it is not skippable.
    const res = await jitTiers(exe, {
      budget: count(arg('dispatches'), 12e6), bench: true, iters: 2000, reps: 1,
      bundle: dir, log: flag('verbose') ? console.log : () => {},
    });
    if (!res.ok) { console.log(`could not build a bundle: ${res.reason}`); process.exit(2); }
    console.log(`${path.basename(exe)}: bundle in ${dir}`);
  } else if (!fs.existsSync(path.join(dir, 'state.json'))) {
    console.log('usage: node tools/toyvm/engine-bench.js <exe> [--engines=...] [--iters=N]');
    process.exit(1);
  }

  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, runnerSource(dir, iters, reps));
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const wanted = arg('engines', 'node,sm,jsc,v8,bun').split(',');

  const load = () => os.loadavg()[0].toFixed(2);
  console.log(`${state.ops} ops x ${iters} iterations, best of ${reps}; load ${load()} at start`);
  console.log('');
  console.log(`  engine            ${state.arms.map(a => a.name.padStart(9)).join('')}   `
    + 'tier3 vs tier0');

  for (const spec of ENGINES.filter(e => wanted.includes(e.id))) {
    const bin = resolve(spec);
    if (!bin) { console.log(`  ${spec.id.padEnd(16)}  not installed`); continue; }
    for (const [label, flags] of [['', spec.jit], [' (baseline)', spec.base]]) {
      if (flags === null) continue;
      let rows;
      try {
        const out = execFileSync(bin, [...flags, runner],
          { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600e3 });
        const line = out.split('\n').find(l => l.startsWith('RESULT'));
        if (!line) throw new Error(out.trim().split('\n').slice(-1)[0] || 'no result line');
        rows = JSON.parse(line.slice(6));
      } catch (e) {
        console.log(`  ${(spec.id + label).padEnd(16)}  failed: `
          + String(e.message).split('\n')[0].slice(0, 60));
        continue;
      }
      const by = new Map(rows.map(r => [r.name, r.ms]));
      const ratio = by.get('tier0') / by.get('tier3');
      console.log(`  ${(spec.id + label).padEnd(16)}  `
        + state.arms.map(a => `${by.get(a.name)}ms`.padStart(9)).join('')
        + `   ${ratio.toFixed(2)}x`);
    }
  }
  console.log('');
  console.log(`  load ${load()} at end`);
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
