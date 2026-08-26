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
const { disasmAt } = require('../disasm');
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
// Which of the two surfaces is this program's picture.
//
// `vga.bpp` is 0 until a graphics mode is established and 0 again once the
// guest goes back to text, which is the question worth asking -- the mode
// number alone is not, since a demo can reprogram the CRTC underneath mode 13h
// and still be in graphics. Two cases hang off the text answer: a program with
// something on the text page is photographed there, and a program with a blank
// text page that HAS been in graphics is photographed off its last frame, which
// is still sitting in A000 after the mode-3 restore a well-behaved demo does on
// its way out.
function screenSurface(machine) {
  if (machine.vga.bpp !== 0) return { text: false, geom: vgaGeometry(machine.vga) };
  if (conCells(machine.con) > 0 || !machine.vga.lastGraphics) return { text: true, geom: null };
  return { text: false, geom: machine.vga.lastGraphics };
}

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
    traceInt = false, traceFault = false, traceEntry = 0, noCache = false,
    shots = null, shotEvery = 20,
    mouse = [0, 0], cpu = 386, report = false, log = console.log, autoKey = false,
    tickScale = 1, sample = false, sampleAfter = 0, forceChained = false,
    // How many handbacks at one address with nothing new on screen before the
    // run is called hung. 0 turns the detector off, which is what to reach for
    // when the question is whether a loop is stuck or merely long: a loop that
    // re-decodes itself every iteration hands back at the same address for real
    // reasons and looks identical to a spin from here.
    stuckLimit = 200,
    // The DOS command tail, verbatim. Several demos in this corpus name their
    // own silent-mode switch on the screen they refuse to start from.
    guestArgs = '',
    // One timer interrupt per this many dispatches. 100k is about 10ms of a
    // real 486, so it lands near the 18.2Hz the BIOS programs -- and a demo
    // that reprogrammed the PIT for music gets a slower clock than it asked
    // for, which costs it tempo and nothing else. Raise it and an ISR-heavy
    // demo gets more of its own budget; lower it and its animation is smoother
    // per dispatch. It is a knob for the same reason tickScale is.
    irqEvery = 100e3, dispatchesPerTick = 550e3,
    // Where to keep the best frame the run ever had, rather than the last one.
    //
    // The last frame is the wrong one surprisingly often. manhatan.exe draws a
    // full-screen ANSI advertisement, pans it, and quits on a keypress -- and
    // since the answerer supplies that keypress, the photograph at the end of
    // the run is the two-line sign-off it exits on. Same story for a demo that
    // clears the screen on its way out. Fullness is the tiebreak: non-black
    // pixels in a graphics mode, non-blank cells in text.
    bestPng = null,
  } = o;
  setCpuLevel(cpu);

  const machine = new Machine(new Uint8Array(0), {
    log: (s) => traceInt && log(`  ${s}`), autoKey, forceChained,
    // A DOS program's data sits next to it, and that directory is the whole of
    // the filesystem it gets.
    fileRoot: path.dirname(path.resolve(exe)),
  });
  const vm = await makeVm(variant, {
    portIn: (p, w) => machine.portIn(p, w),
    portOut: (p, v, w) => machine.portOut(p, v, w),
  });
  // The decoder's CPU level and the module's FLAGS shape have to move together:
  // a build that decodes 386 encodings but reports an 8086 FLAGS register fails
  // the CPU detection every one of those demos opens with.
  vm.exports.set_cpu(cpu);
  machine.setMemory(vm.mem, vm.exports);
  machine.installIvt();
  machine.setTicks(0);
  machine.syncVga();     // the VM's buffer, not the throwaway one from before

  const info = loadExe(vm.mem, fs.readFileSync(exe));
  // What the program was given is what is NOT free. A .COM has no header to
  // say, so the loader leaves this undefined and the machine keeps its "owns
  // everything" default.
  if (info.allocTop !== undefined) machine.allocTop = info.allocTop;
  machine.imageTop = info.minTop;
  machine.installEnvironment(path.basename(exe), guestArgs);
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
  const codeBits = new Uint8Array(vm.mem.buffer, isa.CODE_BITMAP, isa.CODE_BITMAP_SIZE);
  codeBits.fill(0);

  // Everything compiled is now suspect, because the guest wrote into code that
  // had been compiled. Cheaper answers exist (invalidate just the paragraph),
  // but this happens a handful of times in a run -- once when a packed program
  // unpacks itself -- and being obviously right matters more than being quick.
  function flushCompiled() {
    regions.clear();
    vm.set('rtop', 0);
    jtab.fill(0);
    codeBits.fill(0);
  }

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
    // Mark what was decoded, so a store into it is noticed. Paragraph
    // granularity, which is what $wr8 tests -- a store within 16 bytes of
    // compiled code counts as touching it, and over-reporting only costs a
    // recompile.
    for (const [from, to] of prog.covered) {
      for (let p = from >> 4; p <= (to - 1) >> 4; p++) {
        codeBits[p >> 3] |= 1 << (p & 7);
      }
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
  let bestScore = -1, bestSurface = null, bestText = '';
  function keepBest() {
    const s = screenSurface(machine);
    const score = s.text ? conCells(machine.con) : nonBlack(vm.mem, s.geom);
    if (score <= bestScore) return;
    bestScore = score;
    bestSurface = s;
    // The words that go with the picture. Taken here rather than at the end
    // for the same reason the picture is: they have to describe the same
    // moment, or a caption ends up under a screen it was never on.
    bestText = s.text ? conText(machine.con) : '';
    if (s.text) writeConsolePng(bestPng, machine.con);
    else writePng(bestPng, vm.mem, machine.palette, s.geom);
  }

  const t0 = process.hrtime.bigint();
  let guestNs = 0n;
  let dispatched = 0, handbacks = 0, ints = 0, irqs = 0, shotN = 0, stuck = 0, stuckAt = null;
  let smcBreaks = 0;
  let lastIrq = 0, lastKbIrq = 0;
  let lastKey = '', lastWritten = 0, lastRegs = 0;
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
        // Where this INT returns to, and the SP it returns with. EXEC needs it:
        // the caller's own CS:IP at service time is the stub, and the address
        // the parent resumes at lives in the IRET frame.
        ret: { cs: rd(2), ip: rd(0), sp: (sp + 6) & 0xFFFF },
      };
      // The registers as they ARRIVED. Logging them after the call showed the
      // answer where the question belongs: an INT 16h AH=00 that returned 'a'
      // printed as `ax=1e61`, which reads exactly like a program calling a
      // function 1Eh that does not exist. The call is what the log is for, so
      // the return goes after an arrow instead.
      const before = ['ax', 'bx', 'cx', 'dx'].map(n => vm.get(n));
      const ok = machine.service(vec, r);
      if (traceInt) {
        const at = `${rd(2).toString(16)}:${rd(0).toString(16)}`;
        const now = vm.get('ax');
        log(`int ${vec.toString(16).padStart(2, '0')}h ax=${before[0].toString(16)}`
          + ` bx=${before[1].toString(16)} cx=${before[2].toString(16)}`
          + ` dx=${before[3].toString(16)}`
          + `  from ${at}${now === before[0] ? '' : ` -> ax=${now.toString(16)}`}`
          + `${ok ? '' : '   UNHANDLED'}`);
      }
      // IRET, performed here so the stub is one byte and never executes.
      vm.set('gip', rd(0));
      vm.set('cs', rd(2));
      vm.set('flags', rd(4));
      vm.set('sp', (sp + 6) & 0xFFFF);
      // A service that transfers control -- EXEC into a child program, or a
      // child's exit back into its parent -- says so here rather than editing
      // the registers behind the IRET's back, which would just be overwritten
      // by the three loads above.
      if (machine.transfer) {
        const t = machine.transfer;
        machine.transfer = null;
        for (const k of ['cs', 'ss', 'ds', 'es']) vm.set(k, t[k]);
        vm.set('gip', t.ip);
        vm.set('sp', t.sp);
        if (t.ax !== undefined) vm.set('ax', t.ax);
      }
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
    // The entries IN ORDER, which the histogram cannot show. A program that
    // ends up executing its own data got there by a path, and the path is
    // usually three or four blocks long -- uman.com reaches 100:10a from its
    // first instruction and the histogram says only that both were entered.
    if (traceEntry && handbacks < traceEntry) {
      log(`  entry ${cs.toString(16)}:${ip.toString(16)}`);
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
    // A block that patched its own code hands back with $smc set. The block it
    // patched is the one it was about to fall into, so that is the cache entry
    // to drop -- a full flush would be correct too, and would re-decode the
    // whole program on every Turbo Pascal BIOS call.
    // $smc = 2 is the other kind, and the broad one: some store landed in a
    // paragraph that had already been compiled. That is a packed program
    // unpacking itself, so everything compiled from before the unpack is stale
    // and goes.
    if (vm.raw('smc')) {
      const kind = vm.raw('smc');
      vm.set('smc', 0);
      if (kind === 2) {
        flushCompiled();
      } else {
        const ncs = vm.get('cs'), nip = vm.get('gip') & 0xFFFF;
        for (const r of (regions.get(ncs) || [])) r.blocks.delete(nip);
        jtab[isa.jhash(ncs, nip) * 2] = 0;
      }
      smcBreaks++;
    }

    // A divide fault ends the trace inside the guest's own INT 0 handler, so
    // it never reaches the stub segment and --trace-int cannot see it. The
    // faulting address is on the guest stack, which is the only place it is
    // recorded: Turbo Pascal turns this into "Runtime error 200" a long way
    // from the DIV that caused it.
    if (traceFault && cs !== STUB_SEG) {
      const v0 = vm.mem[0] | (vm.mem[1] << 8), v2 = vm.mem[2] | (vm.mem[3] << 8);
      if (vm.get('cs') === v2 && vm.get('gip') === v0) {
        const ss = vm.get('ss'), sp = vm.get('sp');
        const at = (of) => ((ss << 4) + ((sp + of) & 0xFFFF)) & 0xFFFFF;
        const rd = (of) => vm.mem[at(of)] | (vm.mem[at(of + 1)] << 8);
        log(`  divide fault at ${rd(2).toString(16)}:${rd(0).toString(16)}`
          + ` (ax=${vm.get('ax').toString(16)} dx=${vm.get('dx').toString(16)}`
          + ` from ${cs.toString(16)}:${ip.toString(16)} at ${dispatched} dispatches)`);
      }
    }

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
    // Guest time, billed in guest WORK rather than in handbacks.
    //
    // A handback is not a unit of anything: this corpus ranges from 31
    // dispatches per handback to 1.4M, so a tick per handback runs the guest
    // clock five orders of magnitude apart between two programs, and the same
    // program's clock changes speed when its code shape does. Turbo Pascal's
    // CRT unit is what makes that fatal rather than merely wrong -- it times a
    // calibration loop against the BIOS tick word at 0040:006C and divides by
    // what it counted, so a clock that ticks every few hundred instructions
    // makes the count zero and the division by zero is runtime error 200.
    // BIOLAN, BRIAN, CREATION and DIGILAB all died there.
    //
    // 550,000 dispatches to a 55ms tick is a 10-MIPS machine, which is a fast
    // 486 -- the part these were written for, and comfortably below the ~200MHz
    // where the same Pascal bug bites in the other direction.
    machine.setClock(dispatched / dispatchesPerTick * tickScale);
    machine.mouse.dx += mouse[0]; machine.mouse.dy += mouse[1];

    // Deliver the timer interrupt, if the program asked to be called.
    //
    // Advancing the tick word is not the same service: a demo that hooks INT
    // 08h waits on a counter ITS handler increments, and with nothing ever
    // calling it the program spins on a value that can never change. This is
    // the one place in the loop where the guest's cs:gip is a real instruction
    // boundary -- mid-trace it is not -- so it is the only place an interrupt
    // can be pushed in front of it.
    //
    // IF is the whole re-entrancy guard, and it is the same one the hardware
    // uses: the injected frame clears it exactly as `int` does, and the ISR's
    // own IRET puts it back. So an ISR cannot be interrupted by the next tick
    // unless it re-enabled interrupts itself, which is a decision the program
    // is entitled to make.
    // The rate is in guest WORK, not in handbacks. Once per handback is not a
    // rate at all: an ISR that ends in IRET ends its trace, so the very next
    // handback is the one it just returned on, and injecting there again gives
    // the interrupted program zero instructions between interrupts. brainbug
    // spent 30M dispatches that way -- 3.6M interrupts, 8 dispatches apiece,
    // and the main loop never ran once.
    const raise = (vec) => {
      const push = (v) => {
        const sp = (vm.get('sp') - 2) & 0xFFFF;
        vm.set('sp', sp);
        const at = ((vm.get('ss') << 4) + sp) & 0xFFFFF;
        vm.mem[at] = v & 0xFF; vm.mem[at + 1] = (v >> 8) & 0xFF;
      };
      push(vm.get('flags'));
      push(vm.get('cs'));
      push(vm.get('gip'));
      vm.set('flags', vm.get('flags') & ~0x300);       // IF and TF, as `int` does
      const at = vec << 2;
      vm.set('gip', vm.mem[at] | (vm.mem[at + 1] << 8));
      vm.set('cs', vm.mem[at + 2] | (vm.mem[at + 3] << 8));
      irqs++;
    };
    const tvec = machine.timerVector();
    if (tvec && dispatched - lastIrq >= irqEvery && (vm.get('flags') & 0x200)) {
      lastIrq = dispatched;
      raise(tvec);
    // IRQ1. A program with its own INT 9 handler reads the keyboard as
    // hardware and never calls the BIOS, so answering INT 16h reaches it not at
    // all -- BTW.EXE sits on a sound menu having made zero INT 16h calls in 11M
    // dispatches. The machine decides whether there is anything to send and
    // leaves the scancode where port 60h will find it; here we only deliver it,
    // and only between traces where cs:gip is a real instruction boundary.
    // Slower than the timer on purpose: this is a person typing.
    } else if (dispatched - lastKbIrq >= irqEvery * 4 && (vm.get('flags') & 0x200)) {
      const kvec = machine.keyboardIrq();
      if (kvec) { lastKbIrq = dispatched; raise(kvec); }
    }

    // Keep the fullest frame. Sampled rather than continuous: scanning the
    // surface is cheap next to a batch, but not next to a handback, and a
    // program can hand back every hundred dispatches.
    if (bestPng && handbacks % 32 === 0) keepBest();

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
    //
    // A delivered timer interrupt counts as progress on its own. An IRQ-driven
    // demo re-enters its wait loop at one fixed address forever by design --
    // that is what waiting on a counter LOOKS like -- so the address test
    // declares every one of them hung within 200 handbacks. brainbug.exe was
    // cut off after 0.6M of its 30M dispatches for exactly this reason, one
    // handback after the first interrupt it had ever been sent.
    //
    // The registers count too, and they are what stops the last false positive:
    // a loop that writes into a paragraph some compiled region decoded hands
    // control back on EVERY iteration, at the same address, with nothing on the
    // console -- indistinguishable from a spin by address alone. IHANMUU.EXE
    // was cut off after 0.5M of 30M dispatches inside a loop whose SI and BP
    // were advancing the whole time, and runs to a full mode 13h screen without
    // this. A real spin re-enters with the same registers it left with.
    const key = `${cs.toString(16)}:${vm.get('gip').toString(16)}`;
    const wrote = machine.con.written + irqs
      + (machine.videoMode === 3 ? conCells(machine.con) : 0);
    let regs = 2166136261;
    for (const n of ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'ds', 'es']) {
      regs = (Math.imul(regs, 16777619) ^ vm.get(n)) >>> 0;
    }
    stuck = (key === lastKey && wrote === lastWritten && regs === lastRegs) ? stuck + 1 : 0;
    lastKey = key;
    lastWritten = wrote;
    lastRegs = regs;
    if (stuckLimit && stuck > stuckLimit) { stuckAt = key; break; }
  }

  if (bestPng) keepBest();
  const surface = screenSurface(machine);
  return {
    bestScore, bestSurface, bestText,
    variant, exe, vm, machine, jtab,
    secs: Number(process.hrtime.bigint() - t0) / 1e9,
    guestSecs: Number(guestNs) / 1e9,
    dispatched, handbacks, ints, irqs, compiles, compiledWords, arenaResets,
    smcBreaks,
    stuckAt, entryHist, unimplemented, ipSamples, ipSampleLog, regions,
    // A program that never put the adapter in a graphics mode has no frame to
    // count, and reading A000 anyway is how ACME-SUX.EXE and AKM_DOB.EXE came
    // back with ~61,700 "pixels" each while sitting in text mode the whole run.
    // See screenSurface() for which of the two surfaces this program's picture
    // is on.
    surface,
    pixels: surface.text ? 0 : nonBlack(vm.mem, surface.geom),
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
// Repeatable, and comma-separated within one flag, so several regions can be
// asked for in one run without repeating the option four times.
const argAll = (name) => process.argv.slice(2)
  .filter(a => a.startsWith(`--${name}=`))
  .flatMap(a => a.slice(name.length + 3).split(','))
  .filter(Boolean);

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
    traceFault: flag('trace-fault'),
    traceEntry: flag('trace-entry') ? 40 : count(arg('trace-entry'), 0),
    noCache: flag('no-cache'),
    shots: arg('shots'),
    shotEvery: count(arg('shot-every'), 20),
    mouse: (arg('mouse', '0:0')).split(':').map(Number),
    cpu: Number(arg('cpu', 386)),
    report,
    autoKey: flag('auto-key'),
    forceChained: flag('chain4'),
    tickScale: Number(arg('tick-scale', 1)),
    irqEvery: count(arg('irq-every'), 100e3),
    dispatchesPerTick: count(arg('dispatches-per-tick'), 550e3),
    stuckLimit: count(arg('stuck'), 200),
    guestArgs: arg('args', ''),
  });

  // A text-mode program's picture is its console, not the graphics window --
  // capturing A000 for one of those is how 159 of the 199 demos in this corpus
  // used to screenshot as identical black rectangles.
  const png = arg('png');
  if (png) {
    if (r.surface.text) writeConsolePng(png, r.machine.con);
    else writePng(png, r.vm.mem, r.machine.palette, r.surface.geom);
  }

  // The text page as text. A screenshot of a menu is a picture of words, and
  // the question being asked of it -- "what is this program waiting for" -- is
  // answerable by grep only if the words come out as words.
  if (flag('text')) {
    const t = conText(r.machine.con);
    console.log(`\ntext page (${r.machine.con.cols}x${r.machine.con.rows})`);
    console.log(t ? t.split('\n').map(l => `  |${l}`).join('\n') : '  (blank)');
    console.log('');
  }

  if (r.stuckAt) console.log(`stuck at ${r.stuckAt} -- no progress in 200 handbacks`);

  // What the guest is executing, read out of ITS memory rather than out of the
  // file. dos-disasm.js loads the image statically, which answers a different
  // question: half this corpus decrypts itself, relocates itself or runs code a
  // child EXEC wrote, and for those the file says nothing about the address a
  // run stopped at. `--disasm` with no argument takes the address the run ended
  // on, which is the one being asked about nine times out of ten.
  const dis = process.argv.slice(2).find(a => a === '--disasm' || a.startsWith('--disasm='));
  if (dis) {
    const { disasmAt } = require('../disasm');
    const spec = dis.includes('=') ? dis.slice(9) : '';
    const [addr, n] = spec.split(':').length > 2
      ? [spec.split(':').slice(0, 2).join(':'), Number(spec.split(':')[2])]
      : [spec, 24];
    const [segS, offS] = (addr || `${r.vm.get('cs').toString(16)}:`
      + `${r.vm.get('gip').toString(16)}`).split(':');
    const seg = parseInt(segS, 16), off = parseInt(offS, 16);
    const start = ((seg << 4) + off) & 0xFFFFF;
    console.log(`\ndisassembly at ${seg.toString(16)}:${off.toString(16)} (live memory)`);
    for (const line of disasmAt(r.vm.mem, start, start, n || 24, null, { bits: 16 })) {
      const m = /^([0-9a-f]+)(\s+)(.*)$/.exec(line.trim());
      if (!m) { console.log(line); continue; }
      console.log(`  ${seg.toString(16)}:`
        + `${(parseInt(m[1], 16) - (seg << 4)).toString(16).padStart(4, '0')}  ${m[3]}`);
    }
  }
  console.log(`\n${path.basename(exe)}  variant=${r.variant}  ${r.secs.toFixed(2)}s`);
  console.log(`  ${r.handbacks} handbacks, ${r.ints} interrupts`
    + `${r.irqs ? ` (+${r.irqs} timer IRQs delivered)` : ''}, ${r.compiles} traces `
    + `(${(r.compiledWords * 4 / 1024).toFixed(0)}KB of arena, ${r.arenaResets} recycles)`
    // A handful of these is a packed program unpacking itself and is expected.
    // Thousands, against a compile count that keeps climbing, is recompile
    // thrash: a program storing data into a paragraph a region happens to have
    // decoded, one bitmap bit away from its code.
    + (r.smcBreaks ? `\n  ${r.smcBreaks} self-modify breaks` : ''));
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
  // Which files the program went looking for, and which of them were not
  // there. A demo that renders an empty screen from an empty buffer looks
  // exactly like a decoder bug until this line names the file it wanted.
  const m = r.machine;
  if (m.filesOpened.length || m.filesMissed.length || m.filesCreated.length) {
    const uniq = (a) => [...new Set(a)];
    console.log(`  files: opened ${uniq(m.filesOpened).join(' ') || 'none'}`
      + (m.filesCreated.length ? `; created ${uniq(m.filesCreated).join(' ')}` : '')
      + (m.filesMissed.length
        ? `; NOT FOUND ${uniq(m.filesMissed).join(' ')}` : ''));
  }
  if (m.xmsBlocks.size || m.xmsMoved || m.emsHandles.size || m.emsMaps) {
    console.log(`  xms ${m.xmsBlocks.size} block(s), ${(m.xmsMoved / 1024).toFixed(0)}KB moved; `
      + `ems ${m.emsHandles.size} handle(s), ${m.emsMaps} page maps`);
  }
  if (flag('text')) {
    const t = conText(r.machine.con);
    console.log(t ? `\n${t}\n` : '  console grid is empty');
  }
  // Guest memory at the end of the run, as bytes and as instructions.
  //
  // Most of this corpus ships packed, so the code that matters is not in the
  // file: dos-disasm.js reads the image on disk and finds zeros at every
  // address a trace names. This is the other half of that pair -- it reads the
  // memory the depacker actually wrote, which is the only place a wild jump's
  // target can be looked at.
  for (const spec of argAll('dump')) {
    const m = /^(?:([0-9a-fA-F]+):)?([0-9a-fA-F]+)(?::(\d+))?$/.exec(spec);
    if (!m) { console.log(`  bad --dump=${spec}, want SEG:OFF[:LEN]`); continue; }
    const seg = m[1] ? parseInt(m[1], 16) : r.vm.get('cs');
    const off = parseInt(m[2], 16), len = m[3] ? Number(m[3]) : 64;
    const at = ((seg << 4) + off) & 0xFFFFF;
    console.log(`\n  ${seg.toString(16)}:${off.toString(16).padStart(4, '0')}  ${len} bytes`);
    for (let i = 0; i < len; i += 16) {
      const row = [...r.vm.mem.subarray(at + i, at + i + Math.min(16, len - i))];
      console.log(`  ${(off + i).toString(16).padStart(4, '0')}  `
        + row.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48)
        + row.map(b => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join(''));
    }
  }
  for (const spec of argAll('disasm')) {
    const m = /^(?:([0-9a-fA-F]+):)?([0-9a-fA-F]+)(?::(\d+))?$/.exec(spec);
    if (!m) { console.log(`  bad --disasm=${spec}, want SEG:OFF[:COUNT]`); continue; }
    const seg = m[1] ? parseInt(m[1], 16) : r.vm.get('cs');
    const off = parseInt(m[2], 16), n = m[3] ? Number(m[3]) : 24;
    const at = ((seg << 4) + off) & 0xFFFFF;
    console.log(`\n  ${seg.toString(16)}:${off.toString(16).padStart(4, '0')}`);
    for (const line of disasmAt(r.vm.mem, at, at, n, null, { bits: 16 })) {
      const g = /^([0-9a-f]+)(\s+)(.*)$/.exec(line.trim());
      if (!g) { console.log(`  ${line}`); continue; }
      const lin = parseInt(g[1], 16);
      console.log(`  ${seg.toString(16)}:`
        + `${(lin - (seg << 4)).toString(16).padStart(4, '0')}  ${g[3]}`);
    }
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
    const uf = [...r.machine.unhandledFn].sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (uf.length) {
      console.log(`  unhandled calls: ${uf.map(([k, n]) =>
        `int ${k.split(':')[0]}h AH=${k.split(':')[1]} x${n}`).join(', ')}`);
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

module.exports = {
  runDos, writePng, writeConsolePng, readFrame, nonBlack, frameHash, conText,
  screenSurface, conCells,
};

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
