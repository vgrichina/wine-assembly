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
const { setCpuLevel } = require('./decode');
const { Machine, loadExe, vgaGeometry, VGA_BASE } = require('./dos');
const { DosSession } = require('./dos-loop');
const {
  conCells, conText, screenSurface, nonBlack, frameHash, rgbaFrame, rgbaConsole,
} = require('./framebuffer');

// --- screenshot -------------------------------------------------------------
// What is on the screen, how much of it there is, and what the console grid
// says -- all of it in ./framebuffer.js, which the live page shares, so a
// screenshot and the page's canvas cannot disagree about what the screen is.
// Only the PNG encoding stays here, because only a Node driver writes files.

const ld32 = (mem, at) =>
  (mem[at] | (mem[at + 1] << 8) | (mem[at + 2] << 16) | (mem[at + 3] << 24)) >>> 0;

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

// The two PNGs, off the same RGBA the page paints to its canvas. A screenshot
// and a live run that disagreed about a colour would be a real bug and an
// unfindable one, so there is one renderer and this only encodes it.
function writeRgbaPng(file, { width, height, rgba }) {
  const { PNG } = require(path.join(__dirname, '..', '..', 'node_modules', 'pngjs'));
  const png = new PNG({ width, height });
  png.data.set(rgba);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

function writeConsolePng(file, con) {
  writeRgbaPng(file, rgbaConsole(con, terminalFont()));
}

function writePng(file, mem, palette, video) {
  writeRgbaPng(file, rgbaFrame(mem, palette, video));
}

// ---------------------------------------------------------------------------
async function runDos(o) {
  const {
    variant = 'tailcall', exe, budget = 200e6, slice = 2e6, seconds = 0,
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

  // --- the loop ------------------------------------------------------------
  // The cycle itself -- compile, run a slice, service, tick, deliver an
  // interrupt, decide whether the thing is stuck -- is ./dos-loop.js, shared
  // with the live page. What stays here is what only a headless run wants:
  // tracing, sampling, and keeping the best frame.
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
  let shotN = 0;
  const entryHist = new Map();
  const ipSamples = new Map();
  const ipSampleLog = [];          // flat [dispatched, ip, dispatched, ip, ...]

  const session = new DosSession(vm, machine, {
    slice, noCache, mouse, irqEvery, dispatchesPerTick, tickScale, stuckLimit,
    cells: conCells,
    hooks: {
      onInt: !traceInt ? undefined : ({ vec, before, ok, retCs, retIp, ax }) => {
        log(`int ${vec.toString(16).padStart(2, '0')}h ax=${before[0].toString(16)}`
          + ` bx=${before[1].toString(16)} cx=${before[2].toString(16)}`
          + ` dx=${before[3].toString(16)}`
          + `  from ${retCs.toString(16)}:${retIp.toString(16)}`
          + `${ax === before[0] ? '' : ` -> ax=${ax.toString(16)}`}`
          + `${ok ? '' : '   UNHANDLED'}`);
      },
      onEntry: (!report && !traceEntry) ? undefined : (cs, ip, handbacks) => {
        if (report) {
          const k = `${cs.toString(16)}:${ip.toString(16)}`;
          entryHist.set(k, (entryHist.get(k) || 0) + 1);
        }
        // The entries IN ORDER, which the histogram cannot show. A program that
        // ends up executing its own data got there by a path, and the path is
        // usually three or four blocks long -- uman.com reaches 100:10a from
        // its first instruction and the histogram says only that both were
        // entered.
        // The base, not just the selector. In protected mode CS names a
        // descriptor and the number itself says nothing about where the code
        // is, so a trace of bare selectors cannot tell a legitimate jump from
        // one through a descriptor that does not exist.
        if (traceEntry && handbacks < traceEntry) {
          const pe = vm.exports.get_cr0() & 1;
          log(`  entry ${cs.toString(16)}:${ip.toString(16)}`
            + (pe ? ` base=${vm.exports.get_csb().toString(16)} pm` : ''));
        }
      },
      beforeSlice: () => { sliceT0 = process.hrtime.bigint(); },
      afterSlice: ({ left, dispatched, cs, ip }) => {
        guestNs += process.hrtime.bigint() - sliceT0;
        // A divide fault ends the trace inside the guest's own INT 0 handler,
        // so it never reaches the stub segment and --trace-int cannot see it.
        // The faulting address is on the guest stack, which is the only place
        // it is recorded: Turbo Pascal turns this into "Runtime error 200" a
        // long way from the DIV that caused it.
        if (traceFault) {
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
        // A budget-expiry return leaves $ip pointing at the next arena word, so
        // it is a genuine program-counter sample -- unlike $gip, which only
        // moves when a trace ENDS and is therefore blind to exactly the hot
        // loops that never end. With a small slice this is a sampling profiler
        // over the arena. `sampleAfter` skips the program's first N dispatches:
        // most of this corpus ships compressed, so a profile from dispatch zero
        // finds the DEPACKER, not the demo -- which is how eight unrelated
        // demos came back with byte-identical "hottest traces".
        if (sample && left < 0 && dispatched >= sampleAfter) {
          const at = vm.raw('ip');
          ipSamples.set(at, (ipSamples.get(at) || 0) + 1);
          // Each sample is also kept WITH the dispatch count it was taken at,
          // so a caller can restrict the profile to the tail of the run after
          // the fact. An absolute `sampleAfter` cannot do that job: pick 4M and
          // every program that finishes in 3M reports no samples at all.
          ipSampleLog.push(dispatched, at);
        }
      },
    },
  });
  let sliceT0 = 0n;

  // A dispatch budget is not a time budget, and the difference is the whole
  // reason six programs in the corpus photographed as nothing. A run that
  // compiles more than it executes retires dispatches slowly enough that 30M
  // of them take longer than any outer timeout is willing to wait, and being
  // SIGKILLed from outside loses the frame as well as the run -- the harness
  // gets no row at all, which reads as "this program has no picture" rather
  // than "this program is slow". Stopping here instead keeps the best frame,
  // writes the PNG, and reports what it managed.
  const stopAt = seconds ? process.hrtime.bigint() + BigInt(Math.round(seconds * 1e9)) : 0n;
  let ranOutOfTime = false;
  let steps = 0;

  while (session.dispatched < budget && !session.done) {
    session.step();
    // Every 64th trip rather than every trip, and counted here rather than off
    // session.handbacks: a slice that ends without handing back would leave
    // that counter still and the deadline unread.
    if (stopAt && (++steps & 63) === 0 && process.hrtime.bigint() >= stopAt) {
      ranOutOfTime = true;
      break;
    }

    // Keep the fullest frame. Sampled rather than continuous: scanning the
    // surface is cheap next to a batch, but not next to a handback, and a
    // program can hand back every hundred dispatches.
    if (bestPng && session.handbacks % 32 === 0) keepBest();

    if (shots && session.handbacks % shotEvery === 0 && machine.videoMode === 0x13) {
      writePng(path.join(shots, `f${String(shotN++).padStart(4, '0')}.png`),
        vm.mem, machine.palette, vgaGeometry(machine.vga));
    }
  }
  const {
    dispatched, handbacks, ints, irqs, smcBreaks, stuckAt, blockedOn32, badSelector,
    compiles, compiledWords, arenaResets, unimplemented, regions, jtab,
  } = session.stats();

  if (bestPng) keepBest();
  const surface = screenSurface(machine);
  return {
    bestScore, bestSurface, bestText,
    variant, exe, vm, machine, jtab,
    secs: Number(process.hrtime.bigint() - t0) / 1e9,
    guestSecs: Number(guestNs) / 1e9,
    dispatched, handbacks, ints, irqs, compiles, compiledWords, arenaResets,
    smcBreaks,
    stuckAt, blockedOn32, badSelector, ranOutOfTime,
    entryHist, unimplemented, ipSamples, ipSampleLog, regions,
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
    seconds: Number(arg('seconds', 0)),
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
  if (r.ranOutOfTime) {
    console.log(`out of time after ${r.secs.toFixed(1)}s `
      + `-- ${(r.dispatched / 1e6).toFixed(1)}M of ${(count(arg('dispatches'), 200e6) / 1e6)}M dispatches`);
  }
  // Distinct from stuck: the guest is running fine, in a 32-bit code segment
  // this decoder does not read. See dos-loop.js for why that is a stop rather
  // than a best guess.
  if (r.blockedOn32) console.log(`blocked at ${r.blockedOn32} -- 32-bit protected-mode code`);
  // Also distinct from stuck: CS names no descriptor, so a real CPU would have
  // faulted here. $segbase falls back to a real-mode paragraph, which is right
  // for an unreal-mode data segment and impossible for code -- so the run would
  // otherwise walk whatever those bytes happen to be for the rest of its budget.
  if (r.badSelector) {
    console.log(`bad CS selector at ${r.badSelector} -- names no GDT descriptor`);
  }
  // Only when the guest actually switched. Which descriptor table is live, and
  // what CS resolved through, is the first question about any of these -- and
  // "cs:ip=9bf0:1" alone cannot distinguish a selector from a paragraph.
  const ex = r.vm.exports;
  if (ex.get_cr0() & 1) {
    const hx = (v) => v.toString(16);
    console.log(`  protected mode: cr0=${hx(ex.get_cr0())} `
      + `gdt=${hx(ex.get_gdtb())}+${hx(ex.get_gdtl())} `
      + `cs=${hx(r.vm.get('cs'))} base=${hx(ex.get_csb())} `
      + `${ex.get_d32() ? '32-bit' : '16-bit'} code`);
  }

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
    // A bare offset means "in the segment the guest is executing", so it takes
    // that segment's real base -- which in protected mode is whatever CS's
    // descriptor says and is not the selector shifted left four. An explicit
    // SEG: is the caller naming a real-mode paragraph and keeps the shift.
    const base = m[1] ? (seg << 4) : r.vm.exports.get_csb();
    const at = (base + off) & r.vm.exports.get_linmask();
    console.log(`\n  ${seg.toString(16)}:${off.toString(16).padStart(4, '0')}`
      + `${base !== (seg << 4) ? `  (base ${base.toString(16)})` : ''}`);
    for (const line of disasmAt(r.vm.mem, at, at, n, null, { bits: 16 })) {
      const g = /^([0-9a-f]+)(\s+)(.*)$/.exec(line.trim());
      if (!g) { console.log(`  ${line}`); continue; }
      const lin = parseInt(g[1], 16);
      console.log(`  ${seg.toString(16)}:`
        + `${(lin - base).toString(16).padStart(4, '0')}  ${g[3]}`);
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

// The frame readers moved to ./framebuffer.js and are re-exported here, since
// several tools import them from this module by name.
module.exports = {
  runDos, writePng, writeConsolePng, nonBlack, frameHash, conText,
  screenSurface, conCells,
  readFrame: require('./framebuffer').readFrame,
};

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
