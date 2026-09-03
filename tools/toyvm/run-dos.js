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
const { Machine, loadExe, vgaGeometry, parseKeys, VGA_BASE } = require('./dos');
const { DosSession } = require('./dos-loop');
const { asking, complaint } = require('./demo-status');
const {
  conCells, conText, screenSurface, nonBlack, frameScore, frameHash, rgbaFrame, rgbaConsole,
} = require('./framebuffer');

// --- screenshot -------------------------------------------------------------
// What is on the screen, how much of it there is, and what the console grid
// says -- all of it in ./framebuffer.js, which the live page shares, so a
// screenshot and the page's canvas cannot disagree about what the screen is.
// Only the PNG encoding stays here, because only a Node driver writes files.

// --click=X:Y[@FRAC] -- press the left button at one point in the guest's
// mouse coordinate space, FRAC of the way through the dispatch budget (0.3 by
// default). Repeatable, and several clicks can share one flag separated by
// commas. Colons rather than commas inside one click because that is what
// every other coordinate flag here uses and what argAll splits on.
// A keyboard is no use to a program whose whole interface is
// drawn: AQUAPHOB.EXE puts up a 640x480 VESA setup screen with a START DEMO
// button and ignores every key, so without this its picture is its menu.
// The coordinates are the ones int 33h reports, which is not always the pixel
// grid -- that program asks for a 0..1278 horizontal range over 640 pixels, so
// its x is doubled. Read the range the guest sets with fn 07/08 first.
function parseClicks(spec) {
  return String(spec || '').split(';').filter(Boolean).map((item) => {
    const [where, at] = item.split('@');
    const [x, y] = where.split(':').map(Number);
    return { x: x | 0, y: y | 0, at: at === undefined ? 0.3 : Number(at), done: false };
  });
}

// Where a segment register's contents actually point. In protected mode that
// is a descriptor base and not a paragraph, and reading it as a paragraph does
// not land near the right place -- CONTAGIO.EXE stops at 868:13d, whose
// paragraph reading is all zeros and whose descriptor base is in the middle of
// the extender's error strings. The first says "the depacker never wrote here"
// and the second says "the far jump went wrong"; only one is true.
function segBaseOf(vm, seg) {
  const ex = vm.exports;
  // V86 is real-mode segmentation with PE set, so it takes the same answer.
  if (!(ex.get_cr0() & 1) || ex.get_vm86()) return (seg << 4) & 0xFFFFF;
  if (seg === (vm.get('cs') & 0xFFFF)) return ex.get_csb() >>> 0;
  const at = (ex.get_gdtb() >>> 0) + (seg & ~7);
  // Past the limit there is no descriptor to read, and a selector the guest
  // never loaded is usually the caller naming a real-mode paragraph anyway.
  if ((seg & ~7) + 7 > (ex.get_gdtl() >>> 0)) return (seg << 4) & 0xFFFFF;
  const b = vm.mem;
  return (b[at + 2] | (b[at + 3] << 8) | (b[at + 4] << 16) | (b[at + 7] << 24)) >>> 0;
}

// One hexdump, in the format --dump has always printed and tools/dump2png.js
// parses. Shared so a mid-run dump and an at-exit one are the same picture.
function hexdump(mem, seg, off, len, base, linmask) {
  const at = (base + off) & linmask;
  console.log(`\n  ${seg.toString(16)}:${off.toString(16).padStart(4, '0')}`
    + `${base !== ((seg << 4) & 0xFFFFF) ? ` (base ${base.toString(16)})` : ''}  ${len} bytes`);
  for (let i = 0; i < len; i += 16) {
    const row = [...mem.subarray(at + i, at + i + Math.min(16, len - i))];
    console.log(`  ${(off + i).toString(16).padStart(4, '0')}  `
      + row.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48)
      + row.map(b => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join(''));
  }
}

// `--dump-at=2m:232e:17:64` -- the same hexdump, taken the first handback past
// a dispatch count instead of at exit.
//
// Not a convenience. --dump fires when the run is over, which for a program
// that loads code at run time is a picture of whatever replaced the thing you
// were reading: ANGEL.EXE's resident derails around 1.1M dispatches and the
// run goes on for 2M more with 29 self-modify breaks in it, so every reading
// of that block off an at-exit dump is a reading of its successor. This is the
// DOS twin of test/run.js's `BATCH:dump-mem` and exists for the same reason.
function parseDumpAt(spec) {
  const m = /^([0-9.]+[kmb]?):(?:([0-9a-fA-F]+):)?([0-9a-fA-F]+)(?::(\d+))?$/.exec(String(spec));
  if (!m) throw new Error(`bad --dump-at=${spec}, want DISPATCHES:SEG:OFF[:LEN]`);
  return {
    at: count(m[1]), seg: m[2] === undefined ? null : parseInt(m[2], 16),
    off: parseInt(m[3], 16), len: m[4] ? Number(m[4]) : 64, done: false,
  };
}

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
    traceInt = false, traceFault = false, traceEntry = 0, traceV86 = false,
    noCache = false, smcFlush = false, wasmDecode = true, fuse = true,
    lazyFlags = true, fuseCond = true, deadFlags = true, crossFlags = true,
    traceBlocks = true, spinLoops = true, regSpec = false, traceDeadFlags = false,
    volatileCode = true,
    // JIT loop regions: `regions` are the extra handler bodies to build the
    // module with, `regionAt` maps guest ip -> the index the compiler should
    // install there. Both come from tools/toyvm/region-jit.js; a plain run
    // passes neither and is byte-identical to before.
    // (named jitRegions, not regions: run-dos already reports the COMPILED
    // regions the block cache holds, and the two are unrelated)
    jitRegions = null, regionAt = null, regionSucc = null, regionBytes = null,
    regionCodeBits = true,
    smcCensus = false, watch = [],
    stopText = null,
    traceIo = null,
    shots = null, shotEvery = 20,
    mouse = [0, 0], clicks = [], dumpAt = [],
    cpu = 386, report = false, log = console.log, autoKey = false, repFast = true,
    // Build the instrumented dispatch and print the census at exit. `hist` is
    // how many handlers to list, `histPairs` how many pairs; 0 for either
    // suppresses that table. Timings from such a run are meaningless -- three
    // extra memory ops per dispatch -- and the summary says so.
    hist = 0, histPairs = 0,
    tickScale = 1, sample = false, sampleAfter = 0, forceChained = false,
    // How many handbacks at one address with nothing new on screen before the
    // run is called hung. 0 turns the detector off, which is what to reach for
    // when the question is whether a loop is stuck or merely long: a loop that
    // re-decodes itself every iteration hands back at the same address for real
    // reasons and looks identical to a spin from here.
    stuckLimit = 200,
    // ...and the guest work that has to pass under that run of handbacks with
    // nothing observable changing. See DosSession's note: a handback is not a
    // fixed amount of work, so the count alone stopped meaning "a while ago".
    stuckWork = 20e6,
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
    // How much sound card there is. 'full' answers the detection handshake and
    // finishes the transfers a driver starts; 'quiet' answers the handshake but
    // never raises the block-done interrupt; 'none' leaves the ports floating,
    // which is what an empty ISA slot reads as.
    //
    // Three settings because they are three separate answers a demo can be
    // given, and which one a demo does best on is not predictable from the
    // outside: ATTIC.EXE needs 'full' (it will not run without music at all),
    // while BIOLAN.EXE and CEN!FB.EXE drew full screens on 'none' and hang
    // forever on "Initializing ." with a card present. Being able to A/B that
    // in one command is the difference between knowing and guessing.
    sound = 'full', svga = 'none',
    // Render what the card and the speaker play, at this many samples per
    // second, and hand the chunks back (--audio= writes them as a WAV). 0
    // consumes the samples by time and renders nothing.
    audioRate = 0,
    // Derive every guest clock from dispatchesPerTick and the PIT (see
    // DosSession) rather than the sweep's two-clock defaults.
    pitClock = false,
    // 'silent' or 'sb': what the menu answerer picks on a sound menu.
    soundPref = 'silent',
    // [major, minor] the DSP answers to command E1, or null for the SB16 default.
    dspVersion = null,
    // Keys typed once, in order, and keys that replace the auto-key rotation.
    // The rotation exists to get past sound menus and has no ESC in it, which
    // is the key half the text-mode viewers in this corpus are waiting for --
    // ANTARES.EXE sits on `mov ah,8; int 21h; cmp al,1Bh` and was offered
    // 466,766 characters that were not ESC before its budget ran out.
    keys = [], autoKeys = [],
    // Extra environment variables, `NAME=VALUE` each. Nothing is set here by
    // default on purpose: see installEnvironment in dos.js for why announcing
    // hardware nothing is standing behind is worse than staying quiet. This is
    // the lever for finding out what a given announcement costs.
    env = [],
    // Files an earlier run created, carried in. See the --pre option below.
    tempFiles = null,
  } = o;
  setCpuLevel(cpu);
  // Before anything can finish the handler table, because the twins ARE table
  // entries. Asking for them once the table is built is a caller ordering bug
  // and throws rather than quietly running without them.
  if (regSpec) require('./emit').enableRegSpec(true);

  const machine = new Machine(new Uint8Array(0), {
    log: (s) => traceInt && log(`  ${s}`), autoKey, forceChained, sound, svga, soundPref,
    dspVersion, keys, autoKeys, env, tempFiles,
    stopText,
    ioTrace: traceIo === null ? null : (line) => log(`  [io] ${line}`),
    ioPorts: traceIo && traceIo.length ? new Set(traceIo) : null,
    // A DOS program's data sits next to it, and that directory is the whole of
    // the filesystem it gets.
    fileRoot: path.dirname(path.resolve(exe)),
  });
  // What the card and the speaker played, as rendered chunks, when asked.
  const audioChunks = [];
  if (audioRate > 0) {
    machine.audio.rate = audioRate;
    machine.audio.sink = (buf) => audioChunks.push(Float32Array.from(buf));
  }
  const vm = await makeVm(variant, {
    portIn: (p, w) => machine.portIn(p, w),
    portOut: (p, v, w) => machine.portOut(p, v, w),
    hist: hist > 0 || histPairs > 0,
    lazyFlags, fuseCond, regions: jitRegions,
  });
  // The decoder's CPU level and the module's FLAGS shape have to move together:
  // a build that decodes 386 encodings but reports an 8086 FLAGS register fails
  // the CPU detection every one of those demos opens with.
  vm.exports.set_cpu(cpu);
  // The widened REP MOVS/STOS (one memory.copy/memory.fill when the whole run
  // is plain RAM). `--no-rep-fast` is its A/B partner; same registers, same
  // step charge, so the frame and the handback count must agree.
  if (vm.exports.set_rep_fast) vm.exports.set_rep_fast(repFast ? 1 : 0);
  machine.setMemory(vm.mem, vm.exports);
  machine.installIvt();
  machine.setTicks(0, { force: true });
  machine.syncVga();     // the VM's buffer, not the throwaway one from before

  const info = loadExe(vm.mem, fs.readFileSync(exe));
  // What the program was given is what is NOT free. A .COM has no header to
  // say, so the loader leaves this undefined and the machine keeps its "owns
  // everything" default.
  if (info.allocTop !== undefined) machine.allocTop = info.allocTop;
  machine.imageTop = info.minTop;
  machine.installEnvironment(path.basename(exe), guestArgs);
  // IF set, because that is what DOS hands a program. The flags global starts at
  // zero, which is interrupts DISABLED -- so until a program executed an STI of
  // its own it got no timer tick, no keystroke and no sound IRQ, and a program
  // that never executes one got none at all. Turbo Pascal's startup does, which
  // is why this hid for so long. BLAND.EXE's MIDAS driver does not: it unmasks
  // IRQ 2/5/7 at the PICs, asks the DSP to force an IRQ and spins on a flag its
  // handlers set, all with IF still clear, then reports "failed to load MSE"
  // for a card it had already reset and identified.
  vm.setAll({ cs: info.cs, ip: info.ip, ss: info.ss, sp: info.sp, ds: info.ds, es: info.es,
    flags: isa.FLAGS_RESERVED | (1 << isa.F.IF) });
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
  // `bestScore` orders the frames and `bestContent` is what that frame actually
  // held -- pixels for a graphics frame, non-blank cells for a text one. They
  // are two numbers because the ordering is banded (see frameScore) and a band
  // number is not a quantity: reporting the rank as the pixel count is what
  // turned ACME-VIC.EXE's full screen into "60 px" and moved it to `blank`.
  let bestScore = -1, bestContent = 0, bestSurface = null, bestText = '';
  // What the program SAID, kept apart from what it showed. The banding below
  // ranks a refusal under content, which is right for the photograph and wrong
  // for the diagnosis: AMBIENT.EXE prints `MIDAS Error: NO GUS FOUND... USE
  // "AMBIENT /NO_SND" FOR SILENT MODE` and the sweep has a rung that reads that
  // switch back out and re-runs it -- so demoting the frame carrying those
  // words cost the demo its whole picture. Complaints are collected here
  // whatever their frame scored.
  let saidText = '', saidCells = -1;
  function keepBest() {
    const s = screenSurface(machine);
    const cells = s.text ? conCells(machine.con) : 0;
    const text = s.text ? conText(machine.con) : '';
    const f = s.text ? null : frameScore(vm.mem, s.geom);
    // Text frames are banded the way the sweep bands its rows: a screen the
    // program is refusing on loses to one it is not, whatever the cell counts
    // say. BLAND.EXE is why. It is a textmode intro, so its starfield competes
    // with its own setup menu for the same slot, and the menu -- six sound
    // cards and four sampling rates -- is four times as many lit cells as the
    // stars are. The demo ran; the photograph was of the question it asked on
    // the way in. The band is small enough to stay under frameScore's, so any
    // graphics frame still outranks any text one.
    // An empty page gets no band: zero has to keep meaning "nothing here".
    if (cells > saidCells && complaint(text)) { saidCells = cells; saidText = text; }
    const score = s.text ? (cells ? cells + (asking(text) ? 0 : 4000) : 0) : f.score;
    if (score <= bestScore) return;
    bestScore = score;
    bestContent = s.text ? cells : f.count;
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
  let guestCpuUs = 0;
  let v86Was = 0;
  let shotN = 0;
  const entryHist = new Map();
  const ipSamples = new Map();
  const ipSampleLog = [];          // flat [dispatched, ip, dispatched, ip, ...]

  const session = new DosSession(vm, machine, {
    slice, noCache, smcFlush, wasmDecode, fuse, deadFlags, crossFlags, traceBlocks, spinLoops,
    regSpec, regionAt, regionSucc, regionBytes, regionCodeBits, volatileCode,
    traceDeadFlags: traceDeadFlags ? ((s) => log(s)) : null,
    mouse, irqEvery, dispatchesPerTick, tickScale, stuckLimit, pitClock,
    stuckWork,
    // A watch reports through the census, so asking for one turns it on.
    smcCensus: smcCensus || watch.length > 0, watch,
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
      onEntry: (!report && !traceEntry && !traceV86) ? undefined : (cs, ip, handbacks, dispatched) => {
        // Every crossing of the virtual-8086 boundary, in both directions, with
        // the vector that caused the one going in and the ring-0 stack pointer
        // it landed on. A V86 guest and its monitor are two programs sharing a
        // machine, and neither --trace-entry nor --trace-int can show the seam:
        // entries are just addresses, and a trap that goes through the guest's
        // own IDT never reaches the host at all, so the interrupt census counts
        // none of them. The stack pointer is on the line because the failure
        // this was written for is a leak -- daretro.exe lost 0x100 bytes of
        // ring-0 stack per round trip and only fell over 1825 traps later, by
        // which point nothing about the crash names the cause.
        if (traceV86) {
          const now = vm.exports.get_vm86() ? 1 : 0;
          if (now !== v86Was) {
            const hx = (v) => v.toString(16);
            log(now
              ? `  v86 enter ${hx(cs)}:${hx(ip)}`
                + ` flags=${hx(vm.get('flags'))} iopl=${(vm.get('flags') >> 12) & 3}`
              : `  v86 trap vec=${hx(vm.get('intno'))} -> ${hx(cs)}:${hx(ip)}`
                + ` ss:esp=${hx(vm.get('ss'))}:${hx(vm.get('sp'))}`);
            v86Was = now;
          }
        }
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
          // The registers as well as the address. An extender's protected-mode
          // INT 21h dispatcher is one long compare ladder on AH, and which rung
          // it takes -- which is the whole question when the run derails inside
          // it -- is invisible from the entry address alone.
          const h4 = (v) => v.toString(16).padStart(4, '0');
          log(`  entry ${cs.toString(16)}:${ip.toString(16)}`
            + (pe ? ` base=${vm.exports.get_csb().toString(16)} pm` : '')
            + `  ax=${h4(vm.get('ax'))} bx=${h4(vm.get('bx'))}`
            + ` cx=${h4(vm.get('cx'))} dx=${h4(vm.get('dx'))}`
            // DS and ES too. A near memory reference is DS-relative and the
            // instruction carries only the offset, so an entry line without DS
            // cannot say WHERE a store landed, and a 16-bit program that swaps
            // data segments -- an overlay swapper, a far-pointer walk, a copy
            // between two of its own segments -- reads as a wild write without
            // them. BLINKY.EXE's copier writes DS:0x486d over a region that
            // holds live code; only DS says whether that is intentional.
            + ` ds=${h4(vm.get('ds'))} es=${h4(vm.get('es'))}`
            + ` ss:sp=${h4(vm.get('ss'))}:${h4(vm.get('sp'))}`
            // ...and the emulated clock, which is what two arms that reach
            // the same registers at different handbacks disagree about.
            + ` d=${dispatched}`);
        }
      },
      beforeSlice: () => {
        sliceT0 = process.hrtime.bigint();
        sliceCpu0 = process.cpuUsage();
      },
      afterSlice: ({ left, dispatched, cs, ip }) => {
        guestNs += process.hrtime.bigint() - sliceT0;
        // The same fixed work on a meter the rest of the box cannot move. Wall
        // clock inside the slice counts the scheduler too, and this machine sits
        // at load 10-40 with other agents on it -- there the wall number's
        // run-to-run spread is wider than any dispatch effect worth shipping.
        const c = process.cpuUsage(sliceCpu0);
        guestCpuUs += c.user + c.system;
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
            // The twelve words above SP. An INT pushes flags/cs/ip, so whatever
            // called the routine that faulted is still on the stack right
            // behind them along with its arguments -- and that caller is the
            // question every one of these prompts. Reading it out here beats a
            // --dump, which fires at exit with the frame long gone.
            const w = [];
            for (let i = 0; i < 12; i++) w.push(rd(i * 2).toString(16).padStart(4, '0'));
            log(`    stack ${ss.toString(16)}:${sp.toString(16)}  ${w.join(' ')}`
              + `  int0=${v2.toString(16)}:${v0.toString(16)}`);
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
  let sliceCpu0 = null;

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
    // Every trip. Sampling this every 64th was a real overrun and not a small
    // one: a step is a whole slice, and a program whose loops the compiler
    // cannot resolve spends most of its wall clock in JS compiling them, so 64
    // steps is minutes rather than milliseconds. daretro.exe ran 693s against a
    // 60s deadline that way. One hrtime read per handback is about 2% on the
    // handback-heaviest program in the corpus, which is what a bound that holds
    // costs.
    steps++;
    if (stopAt && process.hrtime.bigint() >= stopAt) {
      ranOutOfTime = true;
      break;
    }

    // Scripted clicks. The button is held for a stretch of handbacks rather
    // than a single one because a program polling fn 03 samples it whenever it
    // gets round to it, and a press that is up again by the next poll never
    // happened. Release is the same event backwards -- a button the guest
    // never sees go up leaves its button-down handler running.
    for (const c of clicks) {
      if (c.done) continue;
      if (session.dispatched < c.at * budget) continue;
      if (c.held === undefined) {
        machine.mouse.x = c.x;
        machine.mouse.y = c.y;
        machine.mouse.buttons = 1;
        machine.mouse.pressed[0]++;
        c.held = 0;
        log(`click at ${c.x},${c.y}`);
      } else if (++c.held > 200) {
        machine.mouse.buttons = 0;
        machine.mouse.released[0]++;
        c.done = true;
      }
    }

    for (const d of dumpAt) {
      if (d.done || session.dispatched < d.at) continue;
      d.done = true;
      const seg = d.seg === null ? (vm.get('cs') & 0xFFFF) : d.seg;
      console.log(`  (at ${session.dispatched} dispatches, cs:ip=`
        + `${vm.get('cs').toString(16)}:${vm.get('gip').toString(16)})`);
      hexdump(vm.mem, seg, d.off, d.len, segBaseOf(vm, seg), vm.exports.get_linmask());
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
    dispatched, handbacks, ints, irqs, smcBreaks, traps, icebps, stuckAt, blockedOn32, badSelector,
    compiles, compiledWords, arenaResets, unimplemented, regions, jtab, smcSites, retiredPatches,
    deadFlagsDropped, tracedBlocks, spinBlocks, specOps, rep, volatile,
  } = session.stats();

  if (bestPng) keepBest();
  const surface = screenSurface(machine);
  return {
    bestScore, bestContent, bestSurface, bestText, saidText,
    variant, exe, vm, machine, jtab,
    audioChunks, audioRate,
    // Read before the caller can touch guest memory again. The census lives in
    // the same linear memory the guest runs in, so it is only meaningful while
    // this instance is alive.
    hist: (hist > 0 || histPairs > 0)
      ? require('./handler-hist').readHist(vm.mem) : null,
    histTop: hist, histPairs,
    secs: Number(process.hrtime.bigint() - t0) / 1e9,
    guestSecs: Number(guestNs) / 1e9,
    guestCpuSecs: guestCpuUs / 1e6,
    dispatched, handbacks, ints, irqs, compiles, compiledWords, arenaResets, deadFlagsDropped,
    tracedBlocks, spinBlocks, specOps, rep, volatile,
    smcBreaks, traps, icebps, smcSites, retiredPatches,
    stuckAt, blockedOn32, badSelector, ranOutOfTime,
    entryHist, unimplemented, ipSamples, ipSampleLog, regions,
    // A program that never put the adapter in a graphics mode has no frame to
    // count, and reading A000 anyway is how ACME-SUX.EXE and AKM_DOB.EXE came
    // back with ~61,700 "pixels" each while sitting in text mode the whole run.
    // See screenSurface() for which of the two surfaces this program's picture
    // is on.
    surface,
    pixels: surface.text ? 0 : nonBlack(vm.mem, surface.geom),
    // The surface's own geometry, not the CRTC's. In a VESA mode the registers
    // describe the 64KB window rather than the picture, so reporting them says
    // "320x200" about a 640x480 screen and hashes a fifth of it.
    frame: frameHash(vm.mem, surface.geom || vgaGeometry(machine.vga)),
    video: {
      mode: machine.videoMode,
      // The VBE mode number, not the BIOS one -- in a VESA mode $videoMode is
      // still 0x13 and the geometry below is the picture's, not the CRTC's.
      vesa: machine.vesa ? machine.vesa.mode : 0,
      ...(surface.geom || vgaGeometry(machine.vga)),
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

// Run a prerequisite program first, then the real one, and let the second see
// the files the first wrote.
//
// Some demos ship a configurator and will not start without it. BYETRO.EXE
// prints "Please run SETUP.EXE to configure." and stops; its SETUP.EXE is a
// two-item menu whose "Save and Exit" writes SOUND.CFG. On a real machine you
// run it once and the file stays. Here every program is photographed cold and
// the corpus directory is deliberately read-only -- createFile keeps what a
// guest writes in memory and nothing ever reaches the host disk, which is the
// right call for a corpus and exactly what breaks this pair.
//
// So the two runs share one tempFiles map. Two separate machines, one file
// system between them, and the corpus directory still never written to. The
// prerequisite gets a small budget and the answerer, because a configurator
// that needs more than a few million dispatches is not one.
async function runDosWithPre(o) {
  const pre = path.resolve(path.dirname(path.resolve(o.exe)), o.pre);
  if (!fs.existsSync(pre)) throw new Error(`--pre: no such program: ${o.pre}`);
  const first = await runDos({
    // dumpAt goes with the pictures rather than the machine: a dispatch count
    // asked about the program means the program, and the prerequisite would
    // otherwise reach it first and answer for it.
    ...o, exe: pre, bestPng: null, shots: null, png: null, dumpAt: [],
    // The full budget, not a token slice of it. A configurator is not a quick
    // hello: ANGEL's SETUP.EXE sweeps C000-F000 for a video BIOS signature and
    // needs ~810M dispatches to give up and exit(0). Capped at 20M it was still
    // mid-scan when we moved on, so it wrote nothing and ANGEL still refused to
    // start. Wall clock is what bounds a pre that never exits, so that it can
    // cost at most a third of the run rather than the whole child slot.
    // `--pre-dispatches=` when the two runs want different budgets, and the
    // case that needs it is cutting the MAIN run short: --dump fires at exit,
    // so reading a block before the guest overwrote it means truncating the
    // run -- and a smaller --dispatches used to starve the prerequisite too,
    // which just means it never writes its file and the real program refuses
    // at the gate rather than reaching the instruction being asked about.
    budget: o.preBudget || o.budget || 200e6,
    seconds: o.seconds ? Math.max(15, Math.floor(o.seconds / 3)) : 0,
    autoKey: true, keys: o.preKeys || [],
  });
  return runDos({ ...o, pre: undefined, tempFiles: first.machine.tempFiles });
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

// `SEG:OFF` or `SEG:OFF:LEN` -> the [lo, hi] linear byte range it names. Both
// halves of the address are hex, because every address a run prints is; the
// length is decimal and defaults to one byte, matching --dump.
function parseWatch(spec) {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::(\d+))?$/i.exec(spec.trim());
  if (!m) throw new Error(`not a watch address (want SEG:OFF[:LEN]): ${spec}`);
  const lo = (parseInt(m[1], 16) << 4) + parseInt(m[2], 16);
  return [lo, lo + (m[3] === undefined ? 1 : Number(m[3])) - 1];
}

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
  const pre = arg('pre', '');
  // The port-poll twin for `in al,dx / cmp al,imm / jcc head`, which turns the
  // retrace wait inside one handler against the VGA clock. `--no-port-spin` is
  // ITS A/B partner (same clock, same frame, fewer dispatches); `--no-spin`
  // turns every collapse off. A compile-time switch, like `--no-fusecond`.
  require('./compile').setPortSpin(!flag('no-port-spin'));
  const r = await (pre ? runDosWithPre : runDos)({
    exe,
    // `--pre=SETUP.EXE`, resolved next to the executable, with `--pre-keys=`
    // for a configurator that needs more than the auto-key rotation.
    pre, preKeys: parseKeys(arg('pre-keys', '')),
    preBudget: count(arg('pre-dispatches'), 0),
    variant: arg('variant', 'tailcall'),
    // `--handler-hist` alone lists 20 handlers; `=N` sets the depth.
    // `--handler-pairs[=N]` adds the pair table, which is the one worth
    // reading -- it defaults on whenever the histogram is asked for, because a
    // flat census on its own has already been the wrong answer twice.
    hist: flag('handler-hist') ? 20 : Number(arg('handler-hist', 0)),
    histPairs: flag('handler-pairs') ? 20
      : Number(arg('handler-pairs', (flag('handler-hist') || arg('handler-hist')) ? 20 : 0)),
    budget: count(arg('dispatches'), 200e6),
    slice: count(arg('slice'), 2e6),
    seconds: Number(arg('seconds', 0)),
    traceInt: flag('trace-int'),
    traceFault: flag('trace-fault'),
    traceV86: flag('trace-v86'),
    traceEntry: flag('trace-entry') ? 40 : count(arg('trace-entry'), 0),
    noCache: flag('no-cache'),
    smcFlush: flag('smc-flush'),
    // The wasm decoder is on by default. Its A/B partner: what it decodes is
    // byte-identical to the JS decoder's output, so this changes cost, not
    // behaviour -- a run that differs between the two arms is a bug in one of
    // them and tools/toyvm/decode-diff.js is where to look.
    wasmDecode: !flag('no-wasm-decode'),
    // Superinstruction formation, on by default. Its A/B partner, and the same
    // rule applies: a fused pair charges the step the removed dispatch used to,
    // so the two arms must agree frame for frame and a difference is a bug.
    fuse: !flag('no-fuse'),
    // Lazy flags, on by default. `--no-lazy` builds the eager arm. Nothing about
    // the op stream changes here -- a compare records its inputs instead of
    // computing six bits -- so the two arms must agree exactly, arena included,
    // and a difference is a bug in the deferred rules rather than a retiming.
    lazyFlags: !flag('no-lazy'),
    // A fused compare-and-branch answers its own condition from the record the
    // compare just wrote, with no getter and no test on which rule is pending --
    // the rule is a generation-time constant inside a fused pair. `--no-fusecond`
    // is its A/B partner and, like the others, must agree frame for frame.
    fuseCond: !flag('no-fusecond'),
    // Dead flag write elimination in the compiler, on by default. Most flag
    // writes are never read: a block is some arithmetic and then a compare and
    // a branch, and only the compare's flags are looked at. Where the block
    // proves nobody reads them, the op is swapped for the copy of itself that
    // does not write them. `--no-deadflags` is its A/B partner and must agree
    // frame for frame -- the two arms run the same ops, retire the same steps
    // and lay out the same arena.
    deadFlags: !flag('no-deadflags'),
    // ...and whether that liveness question is asked across a block edge, from
    // the successors this compile emitted, or gives up at the block end.
    // `--no-crossflags` is the narrower arm.
    crossFlags: !flag('no-crossflags'),
    // Compile through a conditional branch, laying its not-taken edge out
    // inline so the common direction pays no block transfer.
    // `--no-trace-blocks` is the A/B partner; the two arms retire the same
    // dispatches and differ only in how much arena they take.
    traceBlocks: !flag('no-trace-blocks'),
    // Collapse a block that is one pure branch back to its own head instead of
    // spinning it to the end of the slice. `--no-spin` is the A/B partner: the
    // two arms retire the same steps and reach the same frame, and differ only
    // in the dispatch count it took to get there.
    spinLoops: !flag('no-spin'),
    // Stop caching code the guest keeps rewriting, and compile it fresh at
    // every entry instead (dos-loop.js CodeCache.noteSmc). `--no-volatile`
    // is the A/B partner: same guest, same breaks, and the arms differ in
    // what each break costs -- a drop-and-retrace of everything around the
    // store against one uncached compile of the block it is in.
    volatileCode: !flag('no-volatile'),
    repFast: !flag('no-rep-fast'),
    // Swap each register access on a runtime index for the twin that has the
    // register as a literal. OPT-IN: the two arms dispatch the same handlers in
    // the same order and differ only in whether the register file is reached
    // through a br_table, and the difference measured as a null. See
    // docs/toyvm-reg-specialization.md.
    regSpec: flag('reg-spec'),
    // Every op that lost its flag write, with the whole block it was in. A
    // wrong answer is always a later op wrongly believed to overwrite the
    // flags, and the block is the only place that shows which one.
    traceDeadFlags: flag('trace-deadflags'),
    smcCensus: flag('smc-census'),
    // `--watch=0:84`, `--watch=0:84:4`, `--watch=5ab:191:2,0:84` -- report every
    // guest store into these bytes, with the CS:IP that made it, through the
    // same census line a self-modifying store gets. SEG:OFF, length in bytes
    // (default 1). The answer to "who overwrote this", which is otherwise
    // unaskable: --smc-census only sees stores that land on compiled code, and
    // --dump only ever shows the state at exit.
    watch: argAll('watch').map(parseWatch),
    sound: arg('sound', 'full'),
    // `--audio=out.wav` renders what the Sound Blaster and the speaker played
    // (`--audio-rate=`, default 22050) and writes it at exit. It is the
    // headless twin of the page's sound: the same samples through the same
    // DMA model, so "is there anything to hear" can be answered by a file.
    audioRate: arg('audio') ? count(arg('audio-rate'), 22050) : 0,
    // `--pit-clock` runs every guest clock off dispatchesPerTick and the PIT's
    // reload, which is what the page does; the sweep's defaults keep the timer
    // interrupt at irqEvery.
    pitClock: flag('pit-clock'),
    // `--sound-pref=sb` has the menu answerer take a Sound Blaster when a
    // menu offers one, as the page does with sound on.
    soundPref: arg('sound-pref', 'silent'),
    // `--dsp-version=2.1` answers DSP command E1 with a plain SB 2.0's number
    // (3.1 for an SB Pro) instead of the SB16's 4.5 the card gives by default:
    // the A/B for a program that changes its mind on the version.
    dspVersion: arg('dsp-version', '') ? String(arg('dsp-version')).split('.').map(Number) : null,
    // `--svga=trident` gives the machine a TVGA8900 instead of a plain VGA:
    // the CRTC 0x1F read-back every detector of the era tests, the version
    // byte at sequencer 0x0E, and that register as a working bank selector.
    // Default off, and deliberately so -- a program that finds a chipset uses
    // its modes, so this is a machine configuration and not an improvement.
    svga: arg('svga', 'none'),
    // `--env=ULTRASND=240,1,1,11,7` -- semicolons separate variables, because
    // commas are inside the values these variables carry.
    env: arg('env', '').split(';').filter(Boolean),
    keys: parseKeys(arg('keys', '')),
    autoKeys: parseKeys(arg('auto-keys', '')),
    shots: arg('shots'),
    shotEvery: count(arg('shot-every'), 20),
    mouse: (arg('mouse', '0:0')).split(':').map(Number),
    clicks: argAll('click').flatMap(parseClicks),
    dumpAt: argAll('dump-at').map(parseDumpAt),
    cpu: Number(arg('cpu', 386)),
    report,
    // Naming a rotation is asking for one, so --auto-keys implies --auto-key.
    autoKey: flag('auto-key') || !!arg('auto-keys', ''),
    forceChained: flag('chain4'),
    tickScale: Number(arg('tick-scale', 1)),
    irqEvery: count(arg('irq-every'), 100e3),
    dispatchesPerTick: count(arg('dispatches-per-tick'), 550e3),
    stuckLimit: count(arg('stuck'), 200),
    stuckWork: count(arg('stuck-work'), 20e6),
    // --stop-on-text='Runtime error 200' -- end the run the instant the guest
    // prints this, so --dump and --disasm photograph the failure instead of
    // whatever reused its memory afterwards. See Machine.conWatch.
    stopText: arg('stop-on-text') || null,
    // --trace-io[=220,22c,0a] -- every port read and write, or only these
    // ports. Bare, it is everything, which on a demo polling 0x3DA is a lot;
    // the list is how a sound-card or chipset conversation gets read on its
    // own. Ports are hex, with or without an 0x.
    traceIo: flag('trace-io') ? []
      : (arg('trace-io') === undefined ? null
        : String(arg('trace-io')).split(',').filter(Boolean)
          .map((x) => parseInt(x.replace(/^0x/i, ''), 16))),
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
  const audioOut = arg('audio');
  if (audioOut) {
    const { wavBytes } = require('./audio');
    let frames = 0, peak = 0;
    for (const c of r.audioChunks) {
      frames += c.length >> 1;
      for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    }
    fs.writeFileSync(audioOut, wavBytes(r.audioChunks, r.audioRate));
    const sb = r.machine.sb;
    console.log(`audio: ${audioOut} ${(frames / r.audioRate).toFixed(2)}s at ${r.audioRate}Hz, `
      + `peak ${peak.toFixed(3)}, sb ${sb.irqs} block irqs at ${sb.rate}Hz `
      + `${sb.bits}-bit${sb.stereo ? ' stereo' : ''}, dma writes ${r.machine.audio.dma.writes}, `
      + `speaker writes ${r.machine.audio.speakerWrites}, `
      + `opl2 writes ${r.machine.audio.opl.writes} (${r.machine.audio.opl.keyOns} key-ons)`);
  }

  // `--save-files=DIR` -- copy out every file the guest created. Those live in
  // memory and never reach the host disk, which is right for a corpus and
  // leaves a configurator's output unreadable: ANGEL.EXE rejects the
  // drivers.vga its own SETUP.EXE just wrote, and the bytes in it are the
  // whole question.
  const saveFiles = arg('save-files');
  if (saveFiles) {
    fs.mkdirSync(saveFiles, { recursive: true });
    for (const [name, rec] of r.machine.tempFiles) {
      const out = path.join(saveFiles, path.basename(name));
      fs.writeFileSync(out, Buffer.from(rec.data.subarray(0, rec.len)));
      console.log(`  saved ${out} (${rec.len} bytes)`);
    }
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
      + `${ex.get_d32() ? '32-bit' : '16-bit'} code`
      + `${ex.get_vm86() ? ' -- virtual-8086' : ''}`);
  }

  console.log(`\n${path.basename(exe)}  variant=${r.variant}  ${r.secs.toFixed(2)}s`);
  console.log(`  ${r.handbacks} handbacks, ${r.ints} interrupts`
    // Every vector the host raises, not just the timer: single-step traps and
    // stepped-over ICEBPs go through the same path and are broken out below.
    + `${r.irqs ? ` (+${r.irqs} vectors raised by the host)` : ''}, ${r.compiles} traces `
    + `(${(r.compiledWords * 4 / 1024).toFixed(0)}KB of arena, ${r.arenaResets} recycles`
    // Static, not dynamic: how many compiled ops lost their flag write, out of
    // how many ops were laid down. A hot loop counts once here and every time
    // at run time, so read --handler-hist for what it is worth in dispatches.
    + `${r.deadFlagsDropped ? `, ${r.deadFlagsDropped} flagless ops`
      + ` of ${r.compiledWords}` : ''}`
    // How many block edges were removed by compiling on through a conditional.
    + `${r.tracedBlocks ? `, ${r.tracedBlocks} traced edges` : ''}`
    // ...and how many one-branch loops back to their own head were collapsed
    // instead of run. These retire the same STEPS as before -- see
    // docs/toyvm-spin-loops.md -- so the count is the only thing that moves.
    + `${r.spinBlocks ? `, ${r.spinBlocks} spin loops` : ''}`
    // ...and how many ops had their register index pinned to a literal. Also
    // step-neutral: the same handler runs, reaching the same register.
    + `${r.specOps ? `, ${r.specOps} regs pinned` : ''})`
    // A handful of these is a packed program unpacking itself and is expected.
    // Thousands, against a compile count that keeps climbing, is recompile
    // thrash: a program storing data into a paragraph a region happens to have
    // decoded, one bitmap bit away from its code.
    + (r.smcBreaks ? `\n  ${r.smcBreaks} self-modify breaks` : '')
    // Where the JIT switched itself off: paragraphs the guest rewrote often
    // enough to stop caching, and how many uncached compiles those cost. A
    // demotion is a paragraph that turned out to be entered far more than it
    // was written and went back to the cache.
    + (r.volatile && r.volatile[2]
      ? ` (${r.volatile[0]} volatile paragraph(s): ${r.volatile[1]} uncached compiles,`
        + ` ${r.volatile[4]} without code bits, ${r.volatile[5]} exits linked,`
        + ` ${r.volatile[2]} promoted, ${r.volatile[3]} demoted)`
      : '')
    // The widened REP MOVS/STOS: runs that became one memory.copy/fill, the
    // bytes they moved, and every run that fell back to the byte loop, by the
    // guard that sent it there. A big `vga` count is a planar-mode program
    // writing its screen through the graphics controller -- the byte path is
    // the only one that knows the write modes -- not a missed case.
    + (r.rep && (r.rep[0] || r.rep.slice(2).some(Boolean))
      ? `\n  rep widened: ${r.rep[0]} runs, ${r.rep[1]} bytes; declined:`
        + ['off', 'df', 'big', 'wrap', 'vga/mask', 'code', 'overlap']
            .map((k, i) => r.rep[i + 2] ? ` ${k}=${r.rep[i + 2]}` : '').join('') + (r.rep[9] ? ` (${r.rep[9]} bytes)` : '')
      : '')
    // Store sites where "a CS override means self-patching code" was watched
    // being wrong and withdrawn. Nonzero means this run took the benignPatch
    // path at all; zero means the decoder behaved exactly as it always did.
    + (r.retiredPatches ? ` (${r.retiredPatches} CS-store site(s) retired)` : '')
    // --smc-census turns that one number into the sites behind it. A storm is
    // almost always one line with nearly the whole count against it.
    // A watch is a question about one address, so its hits are never allowed to
    // fall off the end of the top-12: an unlisted watch reads as "nothing wrote
    // there", which is the opposite of what a truncated list means.
    + (r.smcSites && r.smcSites.size
      ? '\n' + [...r.smcSites].sort((a, b) => b[1] - a[1]).slice(0, argAll('watch').length ? Infinity : 12)
          .map(([k, n]) => `    ${String(n).padStart(8)}  ${k}`).join('\n')
      : '')
    // Both say the guest is being debugged by its own protector: TF set with a
    // hooked INT 1 is a trace decryptor, and an F1 in the instruction stream is
    // the same trick without the flag. Zero of each means neither is happening,
    // which is worth knowing before blaming a decryptor for a wrong jump.
    + (r.traps ? `\n  ${r.traps} single-step traps (guest set TF)` : '')
    + (r.icebps ? `\n  ${r.icebps} guest ICEBP (F1) instructions` : ''));
  const v = r.video;
  // What was rendered, then what the CRTC says when that is something else --
  // for a chained program those differ on purpose. See readFrame.
  // CGA is neither: its picture is at B800, its geometry comes from the mode
  // number, and calling it "320x200 linear" names the wrong buffer.
  // A VESA mode is linear too, but its size comes from the VBE mode, not from
  // the 320x200 the mode-13h window would imply -- print the picture's own.
  const rw = v.planar || v.cga || v.vesa ? v.width : 320;
  const rh = v.planar || v.cga || v.vesa ? v.height : 200;
  console.log(`  video mode ${v.vesa ? `${v.vesa.toString(16)}h VBE` : `${v.mode.toString(16)}h`} `
    + `${v.cga ? `CGA ${v.bpp}bpp ${rw}x${rh}`
      : v.planar ? `${v.bpp === 4 ? 'EGA planar' : 'unchained'} ${rw}x${rh}` : `${rw}x${rh} linear`}`
    + `${v.planar && v.start ? ` start=${v.start}` : ''}`
    + `${v.planar && v.stride !== v.width ? ` stride=${v.stride}` : ''}`
    + `${!v.planar && !v.vesa && (v.width !== 320 || v.height !== 200 || v.start)
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
  if (v.bpp === 8) {
    // The same question the attribute line asks, one level up, and the one the
    // pixel count cannot answer on its own: "N non-black pixels" counts
    // non-zero *indices*, and an index is only a colour after the DAC. A demo
    // caught mid-fade-in, or one whose palette writes we dropped, draws a full
    // picture that saves as a uniformly black PNG -- indistinguishable from a
    // demo that drew nothing at all. BLINKY.EXE is the corpus's example: 1114
    // non-zero pixels that change every frame, every one through a black entry.
    const p = r.machine.palette;
    let dacSet = 0;
    for (let i = 0; i < 256; i++) if (p[i * 3] || p[i * 3 + 1] || p[i * 3 + 2]) dacSet++;
    const used = new Set();
    let dark = 0;
    for (let i = 0; i < rw * rh; i++) {
      const c = r.vm.mem[VGA_BASE + i];
      if (!c) continue;
      used.add(c);
      if (!(p[c * 3] || p[c * 3 + 1] || p[c * 3 + 2])) dark++;
    }
    console.log(`  dac ${dacSet}/256 entries set; frame uses ${used.size}`
      + ` index(es), ${dark} pixel(s) through a black entry`);
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
  // Whether the program went looking for a sound card and what it found. A
  // demo that prints "no soundcard" having never written to 226h is asking a
  // different chip than the one we answer, which is a completely different
  // investigation from one that ran the handshake and rejected the answer.
  if (m.sb.detects || m.sb.commands || m.adlibIndex !== undefined) {
    console.log(`  sb ${m.sb.detects} reset(s), ${m.sb.commands} DSP command(s)`
      + `, ${m.sb.irqs} irq(s), speaker ${m.sb.speaker ? 'on' : 'off'}`
      + (m.adlibIndex !== undefined
        ? `; opl2 ${m.audio.opl.writes} register write(s), ${m.audio.opl.keyOns} key-on(s)` : ''));
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
  // A SEG: in one of these specs is whatever the guest would make of it, which
  // stops being `seg << 4` the moment the guest is in protected mode: there a
  // selector indexes the GDT and the base is written in the descriptor. Reading
  // it as a paragraph is not an approximation, it lands somewhere unrelated --
  // CONTAGIO.EXE stops at 868:13d, whose paragraph reading is all zeros and
  // whose descriptor base puts it in the middle of the extender's error
  // strings. The first reading says "the depacker never wrote here" and the
  // second says "the far jump went to the wrong place"; only one is true.
  const segBase = (seg) => segBaseOf(r.vm, seg);
  // How wide the code in that segment is, out of the same descriptor. A
  // 32-bit segment disassembled as 16-bit is not close to right: the operand
  // and address sizes are both wrong, so every instruction after the first
  // multi-byte one is read at the wrong offset and the listing is fiction.
  const segBits = (seg) => {
    const ex = r.vm.exports;
    if (!(ex.get_cr0() & 1) || ex.get_vm86()) return 16;
    if (seg === (r.vm.get('cs') & 0xFFFF)) return ex.get_d32() ? 32 : 16;
    if ((seg & ~7) + 7 > (ex.get_gdtl() >>> 0)) return 16;
    return (r.vm.mem[(ex.get_gdtb() >>> 0) + (seg & ~7) + 6] & 0x40) ? 32 : 16;
  };
  for (const spec of argAll('dump')) {
    const m = /^(?:([0-9a-fA-F]+):)?([0-9a-fA-F]+)(?::(\d+))?$/.exec(spec);
    if (!m) { console.log(`  bad --dump=${spec}, want SEG:OFF[:LEN]`); continue; }
    const seg = m[1] ? parseInt(m[1], 16) : r.vm.get('cs');
    const off = parseInt(m[2], 16), len = m[3] ? Number(m[3]) : 64;
    const base = segBase(seg);
    const at = (base + off) & r.vm.exports.get_linmask();
    console.log(`\n  ${seg.toString(16)}:${off.toString(16).padStart(4, '0')}`
      + `${base !== ((seg << 4) & 0xFFFFF) ? ` (base ${base.toString(16)})` : ''}  ${len} bytes`);
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
    const base = segBase(seg);
    const at = (base + off) & r.vm.exports.get_linmask();
    console.log(`\n  ${seg.toString(16)}:${off.toString(16).padStart(4, '0')}`
      + `${base !== ((seg << 4) & 0xFFFFF) ? `  (base ${base.toString(16)})` : ''}`);
    for (const line of disasmAt(r.vm.mem, at, at, n, null, { bits: segBits(seg) })) {
      const g = /^([0-9a-f]+)(\s+)(.*)$/.exec(line.trim());
      if (!g) { console.log(`  ${line}`); continue; }
      const lin = parseInt(g[1], 16);
      console.log(`  ${seg.toString(16)}:`
        + `${(lin - base).toString(16).padStart(4, '0')}  ${g[3]}`);
    }
  }
  // Every CPU fault the guest took with the vector still ours, and where it
  // was. A blank screen and a stuck address rarely name each other; this does.
  if (r.machine.faults.size) {
    console.log(`  faults: ${[...r.machine.faults]
      .map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`).join(', ')}`);
  }
  console.log(`  exited=${r.machine.exited}${r.machine.exited ? ` code=${r.machine.exitCode}` : ''}`
    + `${r.machine.blockedOnKey ? '  waiting for a key' : ''}`
    + `${r.machine.stopHit ? '  stopped on text' : ''}`
    + `  cs:ip=${r.vm.get('cs').toString(16)}:${r.vm.get('gip').toString(16)}`);
  console.log(`  ${(r.dispatched / 1e6).toFixed(1)}M dispatches, `
    + `${(r.dispatched / r.guestSecs / 1e6).toFixed(1)}M/s in wasm `
    + `(${(100 * r.guestSecs / r.secs).toFixed(0)}% of wall), `
    + `${(r.dispatched / r.handbacks).toFixed(0)} per handback`);

  if (r.hist) {
    console.log(require('./handler-hist')
      .formatHist(r.hist, { top: r.histTop || 20, pairs: r.histPairs || 0 }));
    // Said every time, because the number right above it is a throughput
    // figure from a build carrying three extra memory ops per dispatch. It is
    // the counts that are exact.
    console.log('    (instrumented build -- the counts are exact, the M/s above is not)');
  }

  if (report) {
    const eh = [...r.entryHist].sort((a, b) => b[1] - a[1]).slice(0, 8);
    // `jt=hit` means the address IS in the indirect-jump cache, so whatever
    // handed back at it was not an indirect jump -- which is the difference
    // between "add a cache" and "the wrong handler is bailing".
    console.log(`  slice entries: ${eh.map(([k, n]) => {
      const [c, i] = k.split(':').map(x => parseInt(x, 16));
      // Stride 4, and the key is two separate words -- the same layout the
      // writer (DosCache.entryFor) and $jlook use. This probe used to assume a
      // stride of 2 and a key packed as (cs<<16)|ip, which no longer describes
      // the table and cannot describe it: a 32-bit code segment's IP does not
      // fit in the low half. Every address it was asked about therefore read
      // MISS, including the ones the cache was serving perfectly, and the
      // column meant to separate "add a cache" from "the wrong handler bails"
      // pointed at the first answer every time.
      // Two of the three terms $jlook checks. The third is the linear base the
      // block was compiled at, and this cannot check it: the only base to hand
      // at report time is the one CS had when the run stopped, and these
      // entries are from all over the program. So the column can say a slot is
      // occupied by this cs:ip, which is the question it was written to answer,
      // and would over-report a hit only for an address whose selector has
      // since been given a new descriptor.
      const slot = isa.jhash(c, i) * 4;
      const hit = r.jtab[slot] === i && r.jtab[slot + 1] === (c & 0xFFFF)
        && r.jtab[slot + 2] !== 0;
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
        // Through the descriptor, not the paragraph -- see segBase. This reads
        // the GDT as it stands at exit, so a selector the guest has since
        // rewritten gives the current base rather than the one in force when
        // the decoder balked; every zero row this used to print was that bug.
        const base = segBase(cs);
        const lin = (base + ip) & r.vm.exports.get_linmask();
        const bytes = [...r.vm.mem.subarray(lin, lin + 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`    ${k}  x${n}  bytes=${bytes}`
          + (base !== ((cs << 4) & 0xFFFFF) ? `  (base ${base.toString(16)})` : ''));
      }
    }
  }
}

// The frame readers moved to ./framebuffer.js and are re-exported here, since
// several tools import them from this module by name.
module.exports = {
  runDos, runDosWithPre, writePng, writeConsolePng, nonBlack, frameHash, conText,
  screenSurface, conCells,
  readFrame: require('./framebuffer').readFrame,
};

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
