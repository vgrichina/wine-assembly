#!/usr/bin/env node

'use strict';

// Run a real DOS executable on the toy VM.
//
//   node tools/toyvm/run-dos.js mars.exe --png=/tmp/mars.png --dispatches=200m
//   node tools/toyvm/run-dos.js mars.exe --variant=switch --mouse=6:0 --shots=/tmp/m
//   node tools/toyvm/run-dos.js mars.exe --trace-int --report
//   node tools/toyvm/run-dos.js DASH.EXE --chain4    # pretend it never unchained
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
const { Machine, loadExe, vgaGeometry, VGA_BASE, STUB_SEG } = require('./dos');

// --- screenshot -------------------------------------------------------------
// One frame of 8-bit pixels, read the way the VGA registers currently say to
// read it. Everything downstream -- the PNG, the pixel count, the frame hash --
// goes through this, so none of them can disagree about what the screen is.
//
// Chained mode 13h is the easy half: A000 is the picture, one byte per pixel.
// Unchained mode X is not addressable that way at all -- pixel (x, y) is byte
// `start + y*(stride/4) + (x>>2)` of plane `x & 3` -- and reading it linearly
// is what made those demos screenshot as a quarter of a picture stretched over
// the frame.
const LINEAR = { width: 320, height: 200, stride: 320, start: 0, planar: false };

const ld32 = (mem, at) =>
  (mem[at] | (mem[at + 1] << 8) | (mem[at + 2] << 16) | (mem[at + 3] << 24)) >>> 0;

// Cells of the console grid that are not a blank on a black ground. A screen
// full of spaces coloured by a background is still a screen, so a cell counts
// when either its character or its attribute says something.
function conCells(con) {
  let n = 0;
  for (let i = 0; i < con.cells; i++) {
    const ch = con.getCh(i);
    if ((ch !== 0x20 && ch !== 0) || (con.getAt(i) & 0xF0) !== 0) n++;
  }
  return n;
}

// The console grid as plain text, trailing blank rows and columns trimmed.
function conText(con) {
  const rows = [];
  for (let y = 0; y < con.rows; y++) {
    let s = '';
    for (let x = 0; x < con.cols; x++) {
      const b = con.getCh(y * con.cols + x);
      s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : (b === 0 || b === 0x20 ? ' ' : '·');
    }
    rows.push(s.replace(/\s+$/, ''));
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

function readFrame(mem, video = LINEAR) {
  // A chained program is read exactly the way it always was, even when its
  // CRTC says something other than 320x200. The register model is complete
  // enough to describe the mode X tweaks and no further: BAZIRRE.COM programs a
  // genuine 320x66 chunky mode by stretching each row over six scan lines, and
  // reading its 66 rows back at a 320-byte stride produces overlapping text --
  // so the chained side of that model is not yet worth trusting over the
  // assumption it would replace. video-census.js still reports the derived
  // numbers, which is where that gets picked up again.
  const g = video && video.planar ? { ...LINEAR, ...video } : LINEAR;
  const { width, height, stride, start, planar } = g;
  const out = new Uint8Array(width * height);
  if (!planar) {
    const n = Math.min(width * height, 0x10000);
    out.set(mem.subarray(VGA_BASE, VGA_BASE + n));
    return { width, height, pixels: out };
  }
  if (g.bpp === 4) {
    // EGA 16-colour: eight pixels per plane byte, one bit each, most
    // significant bit leftmost. The colour is the four bits assembled across
    // the planes, and that 0-15 value then indexes the attribute palette to
    // reach the DAC entry the hardware would have displayed.
    const rowBytes = stride >> 3;
    const attr = g.attr || null;
    for (let y = 0; y < height; y++) {
      const row = start + y * rowBytes;
      for (let x = 0; x < width; x++) {
        const at = (row + (x >> 3)) & 0xFFFF;
        const bit = 7 - (x & 7);
        let c = 0;
        for (let p = 0; p < 4; p++) {
          c |= ((mem[isa.VGA_PLANES + (p << 16) + at] >> bit) & 1) << p;
        }
        out[y * width + x] = attr ? (attr[c] & 0x3F) : c;
      }
    }
    return { width, height, pixels: out };
  }
  const rowBytes = stride >> 2;
  for (let y = 0; y < height; y++) {
    const row = start + y * rowBytes;
    for (let x = 0; x < width; x++) {
      out[y * width + x] =
        mem[isa.VGA_PLANES + ((x & 3) << 16) + ((row + (x >> 2)) & 0xFFFF)];
    }
  }
  return { width, height, pixels: out };
}

// --- text-mode rendering ----------------------------------------------------
// The console grid, drawn with the real OEM font. `fonts/Terminal.fon` is the
// CP437 strike Windows shipped for exactly this character set, so the box
// drawing and block glyphs an ANSI screen is made of come out right instead of
// being approximated. Loaded once, lazily, because a graphics-mode run never
// needs it.
let TERMINAL_FONT;
function terminalFont() {
  if (TERMINAL_FONT !== undefined) return TERMINAL_FONT;
  try {
    const { readStrikes, pickStrike } = require(path.join(__dirname, '..', 'fnt-read'));
    const file = path.join(__dirname, '..', '..', 'fonts', 'Terminal.fon');
    TERMINAL_FONT = pickStrike(readStrikes(file), 12) || null;
  } catch {
    TERMINAL_FONT = null;
  }
  return TERMINAL_FONT;
}

// One 8-bit CGA attribute: low nibble foreground, high nibble background, and
// the top bit is blink -- which on a still frame is just a bright background.
function attrRgb(a, fg) {
  const i = fg ? (a & 0x0F) : ((a >> 4) & 0x07);
  const c = CGA_TEXT[i];
  return [c[0] * 255 / 63, c[1] * 255 / 63, c[2] * 255 / 63];
}
const CGA_TEXT = [
  [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42],
  [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
  [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63],
  [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
];

function writeConsolePng(file, con) {
  const { PNG } = require(path.join(__dirname, '..', '..', 'node_modules', 'pngjs'));
  const f = terminalFont();
  const cw = (f && (f.pixWidth || f.maxWidth)) || 8;
  const ch = (f && f.height) || 12;
  const png = new PNG({ width: con.cols * cw, height: con.rows * ch });
  for (let y = 0; y < con.rows; y++) {
    for (let x = 0; x < con.cols; x++) {
      const at = y * con.cols + x;
      const a = con.getAt(at);
      const bg = attrRgb(a, false), fgc = attrRgb(a, true);
      const g = f ? f.glyphs.get(con.getCh(at)) : null;
      for (let py = 0; py < ch; py++) {
        for (let px = 0; px < cw; px++) {
          const on = g && px < g.width && g.bits[py * g.width + px];
          const c = on ? fgc : bg;
          const o = ((y * ch + py) * png.width + x * cw + px) * 4;
          png.data[o] = c[0]; png.data[o + 1] = c[1]; png.data[o + 2] = c[2];
          png.data[o + 3] = 255;
        }
      }
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

// Palette entries are 6-bit, the way the DAC stores them.
function writePng(file, mem, palette, video) {
  const { PNG } = require(path.join(__dirname, '..', '..', 'node_modules', 'pngjs'));
  const { width, height, pixels } = readFrame(mem, video);
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const c = pixels[i];
    const o = i * 4;
    png.data[o] = Math.round(palette[c * 3] * 255 / 63);
    png.data[o + 1] = Math.round(palette[c * 3 + 1] * 255 / 63);
    png.data[o + 2] = Math.round(palette[c * 3 + 2] * 255 / 63);
    png.data[o + 3] = 255;
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

function nonBlack(mem, video) {
  const { pixels } = readFrame(mem, video);
  let n = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i]) n++;
  return n;
}

// A cheap content signature over the frame buffer. Two variants that disagree
// here executed different code, and no timing comparison between them means
// anything -- so the bench checks it before it reports a ratio.
function frameHash(mem, video) {
  const { pixels } = readFrame(mem, video);
  let h = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) h = Math.imul(h ^ pixels[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
async function runDos(o) {
  const {
    variant = 'tailcall', exe, budget = 200e6, slice = 2e6,
    traceInt = false, noCache = false, shots = null, shotEvery = 20,
    mouse = [0, 0], cpu = 386, report = false, log = console.log, autoKey = false,
    tickScale = 1, sample = false, sampleAfter = 0, forceChained = false,
  } = o;
  setCpuLevel(cpu);

  const machine = new Machine(new Uint8Array(0), {
    log: (s) => traceInt && log(`  ${s}`), autoKey, forceChained,
  });
  const vm = await makeVm(variant, {
    portIn: (p, w) => machine.portIn(p, w),
    portOut: (p, v, w) => machine.portOut(p, v, w),
  });
  // The decoder's CPU level and the module's FLAGS shape have to move together:
  // a build that decodes 386 encodings but reports an 8086 FLAGS register fails
  // the CPU detection every one of those demos opens with.
  vm.exports.set_cpu(cpu);
  machine.setMemory(vm.mem);
  machine.installIvt();
  machine.setTicks(0);
  machine.syncVga();     // the VM's buffer, not the throwaway one from before

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
  let lastKey = '', lastWritten = 0;
  const entryHist = new Map();
  const ipSamples = new Map();
  const ipSampleLog = [];          // flat [dispatched, ip, dispatched, ip, ...]

  while (dispatched < budget && !machine.exited && !machine.blockedOnKey) {
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
      if (machine.exited || machine.blockedOnKey) break;
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

    // A budget-expiry return leaves $ip pointing at the next arena word, so it
    // is a genuine program-counter sample -- unlike $gip, which only moves when
    // a trace ENDS and is therefore blind to exactly the hot loops that never
    // end. With a small slice this is a sampling profiler over the arena.
    // `sampleAfter` skips the program's first N dispatches. Most of this corpus
    // ships compressed (LZEXE/PKLITE), so a profile from dispatch zero finds
    // the DEPACKER, not the demo -- and the depacker is the same handful of
    // instructions in every one of them, which is how eight unrelated demos
    // came back with byte-identical "hottest traces".
    if (sample && left < 0 && dispatched >= sampleAfter) {
      const at = vm.raw('ip');
      ipSamples.set(at, (ipSamples.get(at) || 0) + 1);
      // Each sample is also kept WITH the dispatch count it was taken at, so a
      // caller can restrict the profile to the tail of the run after the fact.
      // An absolute `sampleAfter` cannot do that job: pick 4M and every program
      // that finishes in 3M reports no samples at all, which is how 27 programs
      // vanished from a corpus sweep that was only trying to skip their
      // unpackers. A fraction of each program's OWN run costs one array.
      ipSampleLog.push(dispatched, at);
    }

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
      writePng(path.join(shots, `f${String(shotN++).padStart(4, '0')}.png`),
        vm.mem, machine.palette, vgaGeometry(machine.vga));
    }

    // "No progress" means the guest re-entered at the same address AND put
    // nothing new on the console. The address alone is not enough: a program
    // printing its screen one character at a time hands back at the same INT
    // 21h thunk every time, so README!.COM was being cut off after 201 of its
    // characters and reported as hung while it was working perfectly.
    //
    // "Put nothing new on the console" has to mean the text PAGE, not the
    // teletype counter: a program storing straight into B800 never calls INT
    // 21h at all, so counting calls would go back to declaring exactly those
    // programs hung. The page is 4000 bytes and this runs once per handback,
    // which is a few hundred times over a whole run.
    const key = `${cs.toString(16)}:${vm.get('gip').toString(16)}`;
    const wrote = machine.con.written + (machine.videoMode === 3 ? conCells(machine.con) : 0);
    stuck = (key === lastKey && wrote === lastWritten) ? stuck + 1 : 0;
    lastKey = key;
    lastWritten = wrote;
    if (stuck > 200) { stuckAt = key; break; }
  }

  return {
    variant, exe, vm, machine, jtab,
    secs: Number(process.hrtime.bigint() - t0) / 1e9,
    guestSecs: Number(guestNs) / 1e9,
    dispatched, handbacks, ints, compiles, compiledWords, arenaResets,
    stuckAt, entryHist, unimplemented, ipSamples, ipSampleLog, regions,
    pixels: nonBlack(vm.mem, vgaGeometry(machine.vga)),
    frame: frameHash(vm.mem, vgaGeometry(machine.vga)),
    video: {
      mode: machine.videoMode,
      ...vgaGeometry(machine.vga),
      unchainCount: machine.vga.unchainCount,
      maskWrites: machine.vga.maskWrites,
      masksSeen: machine.vga.masksSeen,
      planeWrites: ld32(vm.mem, isa.VGA_CTL_WRITES),
      planeReads: ld32(vm.mem, isa.VGA_CTL_READS),
    },
    // How much text the program put on the console, and how many cells of the
    // 80x25 grid it left non-blank. Two numbers rather than one because a
    // program can write thousands of characters and leave an empty screen --
    // that is what a cleared screen or an animation ending on blank looks like.
    text: { written: machine.con.written, cells: conCells(machine.con) },
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
    forceChained: flag('chain4'),
    tickScale: Number(arg('tick-scale', 1)),
  });

  // A text-mode program's picture is its console, not the graphics window --
  // capturing A000 for one of those is how 159 of the 199 demos in this corpus
  // used to screenshot as identical black rectangles.
  const png = arg('png');
  if (png) {
    if (r.machine.videoMode === 3 && r.text.cells > 0) {
      writeConsolePng(png, r.machine.con);
    } else {
      writePng(png, r.vm.mem, r.machine.palette, vgaGeometry(r.machine.vga));
    }
  }

  if (r.stuckAt) console.log(`stuck at ${r.stuckAt} -- no progress in 200 handbacks`);
  console.log(`\n${path.basename(exe)}  variant=${r.variant}  ${r.secs.toFixed(2)}s`);
  console.log(`  ${r.handbacks} handbacks, ${r.ints} interrupts, ${r.compiles} traces `
    + `(${(r.compiledWords * 4 / 1024).toFixed(0)}KB of arena, ${r.arenaResets} recycles)`);
  const v = r.video;
  // What was rendered, then what the CRTC says when that is something else --
  // for a chained program those differ on purpose. See readFrame.
  const rw = v.planar ? v.width : 320, rh = v.planar ? v.height : 200;
  console.log(`  video mode ${v.mode.toString(16)}h `
    + `${v.planar ? `${v.bpp === 4 ? 'EGA planar' : 'unchained'} ${rw}x${rh}` : `${rw}x${rh} linear`}`
    + `${v.planar && v.start ? ` start=${v.start}` : ''}`
    + `${v.planar && v.stride !== v.width ? ` stride=${v.stride}` : ''}`
    + `${!v.planar && (v.width !== 320 || v.height !== 200 || v.start)
        ? ` (crtc says ${v.width}x${v.height}${v.start ? ` start=${v.start}` : ''})` : ''}, `
    + `${r.pixels} non-black pixels of ${rw * rh}, frame=${r.frame}`);
  if (v.planar) {
    // Where the bytes actually are. Empty planes beside a full linear window
    // mean the guest drew before it unchained, or through a path that never
    // reached the plane store -- and that is not visible from the picture.
    const nz = (from, n) => {
      let c = 0;
      for (let i = 0; i < n; i++) if (r.vm.mem[from + i]) c++;
      return c;
    };
    console.log(`  planes ${[0, 1, 2, 3].map(p =>
      nz(isa.VGA_PLANES + p * isa.VGA_PLANE_SIZE, 0x10000)).join('/')}`
      + `, chained window ${nz(VGA_BASE, 0x10000)}`
      + `, ${r.video.planeWrites} planar writes / ${r.video.planeReads} reads`);
    const g = r.machine.vga;
    if (v.bpp === 4) {
      // Which DAC entry each of the 16 pixel values actually reaches, and how
      // many of those entries the program set itself. A picture whose colours
      // look wrong is one of two different bugs -- an attribute palette we got
      // wrong, or a DAC the program never wrote -- and this separates them.
      const attr = v.attr.map(a => (a & 0x3F).toString(16).padStart(2, '0'));
      const own = v.attr.filter(a => {
        const d = (a & 0x3F) * 3, p = r.machine.palette;
        return p[d] || p[d + 1] || p[d + 2];
      }).length;
      console.log(`  attr palette ${attr.join(' ')} (${own}/16 non-black in the DAC)`);
    }
    console.log(`  seq mask=${(g.seq[2] & 0x0F).toString(2).padStart(4, '0')}`
      + ` gc mode=${g.gc[5] & 3} readmap=${g.gc[4] & 3} bitmask=${g.gc[8].toString(16)}`
      + ` setreset=${g.gc[0].toString(16)}/${g.gc[1].toString(16)}`
      + `, ${g.maskWrites} mask writes`);
  }
  // Two numbers, not one, and the cell count is the one that matters: a demo
  // that stores straight into B800 writes zero characters through DOS and still
  // fills the screen. a-note.exe is the whole corpus's example -- 0 chars, 632
  // cells, and it never calls a single output interrupt.
  if (r.text.written || r.text.cells) {
    console.log(`  console ${r.text.written} chars written, `
      + `${r.text.cells} of ${r.machine.con.cols * r.machine.con.rows} cells non-blank`);
  }
  if (flag('text')) {
    const t = conText(r.machine.con);
    console.log(t ? `\n${t}\n` : '  console grid is empty');
  }
  console.log(`  exited=${r.machine.exited}${r.machine.exited ? ` code=${r.machine.exitCode}` : ''}`
    + `${r.machine.blockedOnKey ? '  waiting for a key' : ''}`
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

module.exports = { runDos, writePng, writeConsolePng, readFrame, nonBlack, frameHash };

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
