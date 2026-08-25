#!/usr/bin/env node

'use strict';

// Run a real DOS executable on the toy VM.
//
//   node tools/toyvm/run-dos.js mars.exe --png=/tmp/mars.png --dispatches=200m
//   node tools/toyvm/run-dos.js mars.exe --variant=switch --mouse=6:0 --shots=/tmp/m
//   node tools/toyvm/run-dos.js mars.exe --trace-int --report
//
// The point of this is not emulation for its own sake -- it is to get the
// dispatch variants running the same real workload. Everything that is not the
// VM lives in tools/toyvm/dos.js; everything that is not dispatch lives on the
// host, including the decoder. What is left inside wasm is a loop over the
// thread arena, which is the thing under comparison.
//
// Traces are compiled per (cs, entry ip) and cached. A guest that rewrites its
// own code after a trace was built would run the stale copy; --no-cache
// recompiles on every handback and is the way to find out whether that is
// happening.
//
// Importable: `require('./run-dos').runDos({ variant, exe, budget })` returns
// the same numbers the CLI prints, which is what tools/toyvm/bench-dos.js uses
// to alternate arms inside one process.

const fs = require('fs');
const path = require('path');
const isa = require('./isa');
const { makeVm } = require('./vm');
const { compileProgram } = require('./compile');
const { setCpuLevel } = require('./decode');
const { Machine, loadExe, VGA_BASE, STUB_SEG } = require('./dos');

// --- screenshot -------------------------------------------------------------
// Mode 13h only: 320x200, one byte per pixel, palette entries are 6-bit.
function writePng(file, mem, palette, { width = 320, height = 200 } = {}) {
  const { PNG } = require(path.join(__dirname, '..', '..', 'node_modules', 'pngjs'));
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const c = mem[VGA_BASE + i];
    const o = i * 4;
    png.data[o] = Math.round(palette[c * 3] * 255 / 63);
    png.data[o + 1] = Math.round(palette[c * 3 + 1] * 255 / 63);
    png.data[o + 2] = Math.round(palette[c * 3 + 2] * 255 / 63);
    png.data[o + 3] = 255;
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

function nonBlack(mem) {
  let n = 0;
  for (let i = 0; i < 320 * 200; i++) if (mem[VGA_BASE + i]) n++;
  return n;
}

// A cheap content signature over the frame buffer. Two variants that disagree
// here executed different code, and no timing comparison between them means
// anything -- so the bench checks it before it reports a ratio.
function frameHash(mem) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 320 * 200; i++) h = Math.imul(h ^ mem[VGA_BASE + i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
async function runDos(o) {
  const {
    variant = 'tailcall', exe, budget = 200e6, slice = 2e6,
    traceInt = false, noCache = false, shots = null, shotEvery = 20,
    mouse = [0, 0], cpu = 386, report = false, log = console.log, autoKey = false,
    tickScale = 1,
  } = o;
  setCpuLevel(cpu);

  const machine = new Machine(new Uint8Array(0), {
    log: (s) => traceInt && log(`  ${s}`), autoKey,
  });
  const vm = await makeVm(variant, {
    portIn: (p, w) => machine.portIn(p, w),
    portOut: (p, v, w) => machine.portOut(p, v, w),
  });
  machine.mem = vm.mem;
  machine.installIvt();
  machine.setTicks(0);

  const info = loadExe(vm.mem, fs.readFileSync(exe));
  vm.setAll({ cs: info.cs, ip: info.ip, ss: info.ss, sp: info.sp, ds: info.ds, es: info.es });
  // The stack must hold a return address: a .COM-style `ret` exit lands on the
  // PSP's INT 20h. An EXE that ends with INT 21h/4C never touches it.
  vm.set('sp', (info.sp - 2) & 0xFFFF);
  const spLin = ((info.ss << 4) + ((info.sp - 2) & 0xFFFF)) & 0xFFFFF;
  vm.mem[spLin] = 0; vm.mem[spLin + 1] = 0;

  // --- trace cache ---------------------------------------------------------
  // One compiled region per (cs, entry ip). compileProgram walks the whole
  // reachable subgraph within that cs, so most entries hit an existing region's
  // block map and cost nothing.
  const regions = new Map();     // cs -> [prog]
  let arenaNext = isa.THREAD_BASE;
  const arenaEnd = isa.THREAD_BASE + isa.THREAD_SIZE - 4096;
  let compiles = 0, compiledWords = 0, arenaResets = 0;
  const jtab = new Int32Array(vm.mem.buffer, isa.JTAB_BASE, isa.JTAB_SIZE >> 2);
  const unimplemented = new Map();

  function entryFor(cs, ip) {
    if (!noCache) {
      for (const r of (regions.get(cs) || [])) {
        const a = r.blocks.get(ip & 0xFFFF);
        if (a !== undefined) return a;
      }
    }
    // Recycling the arena invalidates every arena address the guest-visible
    // caches hold, so both are emptied here -- a stale entry would resume in
    // whatever got compiled over the block it named.
    if (arenaNext >= arenaEnd) {
      regions.clear(); arenaNext = isa.THREAD_BASE; arenaResets++;
      vm.set('rtop', 0); jtab.fill(0);
    }
    const prog = compileProgram((lin) => vm.mem[lin], cs, ip, {
      arenaBase: arenaNext,
      maxWords: (arenaEnd - arenaNext) >> 2,
    });
    new Int32Array(vm.mem.buffer, prog.arenaBase, prog.words.length).set(prog.words);
    arenaNext += prog.words.length * 4;
    compiles++; compiledWords += prog.words.length;
    for (const at of prog.unimplemented) {
      const key = `${cs.toString(16)}:${at.toString(16)}`;
      unimplemented.set(key, (unimplemented.get(key) || 0) + 1);
    }
    // Publish every block head into the indirect-jump cache. Direct-mapped, so
    // a later block simply evicts an earlier one -- the key check in $jlook
    // turns that into a handback rather than a wrong jump.
    for (const [bip, addr] of prog.blocks) {
      const slot = isa.jhash(cs, bip) * 2;   // jtab is a view starting AT JTAB_BASE
      jtab[slot] = ((cs & 0xFFFF) << 16) | (bip & 0xFFFF);
      jtab[slot + 1] = addr;
    }
    if (!regions.has(cs)) regions.set(cs, []);
    regions.get(cs).push(prog);
    return prog.entryAddr;
  }

  // --- the loop ------------------------------------------------------------
  const t0 = process.hrtime.bigint();
  let guestNs = 0n;
  let dispatched = 0, handbacks = 0, ints = 0, shotN = 0, stuck = 0, stuckAt = null;
  let lastKey = '';
  const entryHist = new Map();

  while (dispatched < budget && !machine.exited) {
    const cs = vm.get('cs'), ip = vm.get('gip');

    // A guest IP inside the stub segment is a serviced interrupt: the vector
    // sent us to a byte the decoder refuses, so control is here rather than in
    // guest code.
    if (cs === STUB_SEG) {
      const vec = ip & 0xFF;
      ints++;
      // The IRET frame the INT handler pushed. Servicing may want to change the
      // flags the guest gets back (CF for a DOS error, ZF for "no key"), so it
      // is edited in place on the stack rather than in the live register.
      const ss = vm.get('ss'), sp = vm.get('sp');
      const lin = (of) => ((ss << 4) + ((sp + of) & 0xFFFF)) & 0xFFFFF;
      const rd = (of) => vm.mem[lin(of)] | (vm.mem[lin(of + 1)] << 8);
      const wr = (of, v) => { vm.mem[lin(of)] = v & 0xFF; vm.mem[lin(of + 1)] = (v >> 8) & 0xFF; };
      const r = {
        get: (n) => vm.get(n),
        set: (n, v) => vm.set(n, v),
        setResultCf: (on) => wr(4, on ? (rd(4) | 1) : (rd(4) & ~1)),
        setResultZf: (on) => wr(4, on ? (rd(4) | 0x40) : (rd(4) & ~0x40)),
      };
      const ok = machine.service(vec, r);
      if (traceInt) {
        log(`int ${vec.toString(16).padStart(2, '0')}h ax=${vm.get('ax').toString(16)}`
          + ` bx=${vm.get('bx').toString(16)} cx=${vm.get('cx').toString(16)}`
          + ` dx=${vm.get('dx').toString(16)}`
          + `  from ${rd(2).toString(16)}:${rd(0).toString(16)}${ok ? '' : '   UNHANDLED'}`);
      }
      // IRET, performed here so the stub is one byte and never executes.
      vm.set('gip', rd(0));
      vm.set('cs', rd(2));
      vm.set('flags', rd(4));
      vm.set('sp', (sp + 6) & 0xFFFF);
      if (machine.exited) break;
      continue;
    }

    // Where a slice re-enters is the whole cost model of this harness: each one
    // is a JS round trip, and a hot loop whose back edge the compiler could not
    // resolve turns into hundreds of thousands of them.
    if (report) {
      const k = `${cs.toString(16)}:${ip.toString(16)}`;
      entryHist.set(k, (entryHist.get(k) || 0) + 1);
    }
    const entry = entryFor(cs, ip);
    const g0 = process.hrtime.bigint();
    vm.exports.run(entry, slice);
    guestNs += process.hrtime.bigint() - g0;
    // $left is -1 when the slice ran to exhaustion and holds the unspent budget
    // when a handler handed control back early. Billing the slice either way
    // makes a demo that bounces off an unresolved jump every few instructions
    // look like it burned the whole budget.
    const left = vm.raw('left');
    dispatched += left < 0 ? slice : slice - left;
    handbacks++;

    // Time moves with work, not with the wall clock: a demo that spins on the
    // BIOS tick has to see it advance, and a wall clock would make a headless
    // run's speed change what the guest computes.
    //
    // But note WHAT it moves with: one tick per HANDBACK, and handbacks vary by
    // five orders of magnitude across the corpus (31 dispatches for CORE-ADD,
    // 1.4M for COPPER). So the guest clock runs at wildly different speeds
    // relative to guest work depending on the program -- exactly the trap
    // documented for the main emulator's `batch * TICK_MS_PER_BATCH`. tickScale
    // is the A/B knob: run the same program at 0, 1 and 16 and compare frames.
    // Identical across all three means the program never reads a clock and is
    // purely compute-bound; a frame that advances at 16 means it was waiting.
    machine.setTicks(machine.ticks + tickScale);
    machine.mouse.dx += mouse[0]; machine.mouse.dy += mouse[1];

    if (shots && handbacks % shotEvery === 0 && machine.videoMode === 0x13) {
      writePng(path.join(shots, `f${String(shotN++).padStart(4, '0')}.png`), vm.mem, machine.palette);
    }

    const key = `${cs.toString(16)}:${vm.get('gip').toString(16)}`;
    stuck = (key === lastKey) ? stuck + 1 : 0;
    lastKey = key;
    if (stuck > 200) { stuckAt = key; break; }
  }

  return {
    variant, exe, vm, machine, jtab,
    secs: Number(process.hrtime.bigint() - t0) / 1e9,
    guestSecs: Number(guestNs) / 1e9,
    dispatched, handbacks, ints, compiles, compiledWords, arenaResets,
    stuckAt, entryHist, unimplemented,
    pixels: nonBlack(vm.mem), frame: frameHash(vm.mem),
  };
}

// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

async function main() {
  const exe = process.argv[2];
  if (!exe || exe.startsWith('--')) {
    console.log('usage: node tools/toyvm/run-dos.js <file.exe> [--variant=] [--png=] [--dispatches=]');
    process.exit(2);
  }
  const report = flag('report');
  const r = await runDos({
    exe,
    variant: arg('variant', 'tailcall'),
    budget: count(arg('dispatches'), 200e6),
    slice: count(arg('slice'), 2e6),
    traceInt: flag('trace-int'),
    noCache: flag('no-cache'),
    shots: arg('shots'),
    shotEvery: count(arg('shot-every'), 20),
    mouse: (arg('mouse', '0:0')).split(':').map(Number),
    cpu: Number(arg('cpu', 386)),
    report,
    autoKey: flag('auto-key'),
    tickScale: Number(arg('tick-scale', 1)),
  });

  const png = arg('png');
  if (png) writePng(png, r.vm.mem, r.machine.palette);

  if (r.stuckAt) console.log(`stuck at ${r.stuckAt} -- no progress in 200 handbacks`);
  console.log(`\n${path.basename(exe)}  variant=${r.variant}  ${r.secs.toFixed(2)}s`);
  console.log(`  ${r.handbacks} handbacks, ${r.ints} interrupts, ${r.compiles} traces `
    + `(${(r.compiledWords * 4 / 1024).toFixed(0)}KB of arena, ${r.arenaResets} recycles)`);
  console.log(`  video mode ${r.machine.videoMode.toString(16)}h, `
    + `${r.pixels} non-black pixels of ${320 * 200}, frame=${r.frame}`);
  console.log(`  exited=${r.machine.exited}${r.machine.exited ? ` code=${r.machine.exitCode}` : ''}`
    + `  cs:ip=${r.vm.get('cs').toString(16)}:${r.vm.get('gip').toString(16)}`);
  console.log(`  ${(r.dispatched / 1e6).toFixed(1)}M dispatches, `
    + `${(r.dispatched / r.guestSecs / 1e6).toFixed(1)}M/s in wasm `
    + `(${(100 * r.guestSecs / r.secs).toFixed(0)}% of wall), `
    + `${(r.dispatched / r.handbacks).toFixed(0)} per handback`);

  if (report) {
    const eh = [...r.entryHist].sort((a, b) => b[1] - a[1]).slice(0, 8);
    // `jt=hit` means the address IS in the indirect-jump cache, so whatever
    // handed back at it was not an indirect jump -- which is the difference
    // between "add a cache" and "the wrong handler is bailing".
    console.log(`  slice entries: ${eh.map(([k, n]) => {
      const [c, i] = k.split(':').map(x => parseInt(x, 16));
      const slot = isa.jhash(c, i) * 2;
      const hit = r.jtab[slot] === (((c & 0xFFFF) << 16) | (i & 0xFFFF)) && r.jtab[slot + 1] !== 0;
      return `${k} x${n} jt=${hit ? 'hit' : 'MISS'}`;
    }).join(', ')}`);
    const ic = [...r.machine.intCount].sort((a, b) => b[1] - a[1]);
    if (ic.length) console.log(`  interrupts: ${ic.map(([v, n]) => `${v.toString(16)}h x${n}`).join(', ')}`);
    if (r.machine.unhandled.size) {
      console.log(`  UNHANDLED: ${[...r.machine.unhandled].map(([v, n]) => `int ${v.toString(16)}h x${n}`).join(', ')}`);
    }
    const un = [...r.unimplemented].sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (un.length) {
      console.log(`  decoder gave up at ${r.unimplemented.size} site(s); top:`);
      for (const [k, n] of un) {
        const [cs, ip] = k.split(':').map(x => parseInt(x, 16));
        const lin = ((cs << 4) + ip) & 0xFFFFF;
        const bytes = [...r.vm.mem.subarray(lin, lin + 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`    ${k}  x${n}  bytes=${bytes}`);
      }
    }
  }
}

module.exports = { runDos, writePng, nonBlack, frameHash };

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
