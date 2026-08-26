'use strict';

// A DOS/BIOS/VGA machine around the toy VM, big enough to run a real mode-13h
// intro off pouet.
//
// The VM itself knows nothing about DOS. Everything a guest reaches for that is
// not an x86 instruction arrives here by one of two routes:
//
//   * software interrupts. The IVT is real -- INT vectors through it the way
//     the hardware does -- but every vector we service points into a stub
//     segment whose first byte the decoder deliberately refuses. The trace ends
//     there, the run loop sees a guest IP inside the stub region, services the
//     call in JS and performs the IRET itself. A guest that installs its OWN
//     handler (INT 21h/25h) overwrites the vector and stops coming here at all,
//     which is exactly right.
//
//   * ports. Only the handful a demo actually touches are modelled: the VGA DAC
//     write path at 0x3C8/0x3C9, the input status register at 0x3DA (whose
//     retrace bits are what a demo spins on), and the sequencer/CRTC index
//     pairs far enough to not hang a mode set.
//
// Video memory needs no modelling at all: A000:0000 is inside the 1MB of guest
// RAM, so a demo's writes land in the same Uint8Array we screenshot from.

const fs = require('fs');
const isa = require('./isa');

const VGA_BASE = 0xA0000;
const STUB_SEG = 0xF000;      // vector v points at F000:(0x100+v), one refused byte
const STUB_OFF = 0x100;       // ...leaving F000:0000-00FF for driver signatures
const STUB_BYTE = 0xF1;       // ICEBP -- not decoded, so the trace stops on it

// --- the two memory managers a 1994 demo expects to find --------------------
// Four programs in this corpus print "HIMEM.SYS NEEDED !!!" or "Expanded
// Memory Manager required !" and exit, which is a driver gap rather than a CPU
// one: both managers are detected before they are used, and detecting them is
// most of the work.
// The three ROM character generators, as [segment, rows, rows of padding on
// top]. They sit in the ROM area above the EGA/VGA page frame, where the real
// ones do, and nothing else in the 1MB uses those addresses. An 8-row table
// takes the body of a 12-row glyph rather than padding it.
const ROM_FONTS = [
  [0xF400, 16, 2],   // 8x16, BH=6/7
  [0xF500, 14, 1],   // 8x14, BH=2/5
  [0xF600, 8, -2],   // 8x8,  BH=0/1/3/4
];
let ROM_STRIKE;
function romStrike() {
  if (ROM_STRIKE !== undefined) return ROM_STRIKE;
  try {
    const { readStrikes, pickStrike } = require('../fnt-read');
    const file = require('path').join(__dirname, '..', '..', 'fonts', 'Terminal.fon');
    ROM_STRIKE = pickStrike(readStrikes(file), 12) || null;
  } catch {
    ROM_STRIKE = null;    // no font bundled: the tables stay blank, not wrong
  }
  return ROM_STRIKE;
}

const EMS_NAME = 'EMMXXXX0';  // at handler_segment:000A, the classic EMS probe
const EMS_FRAME_SEG = 0xE000; // 64K page frame: four 16K physical pages
const EMS_PAGE = 0x4000;
const EMS_TOTAL_PAGES = 512;  // 8MB of expanded memory, the usual EMM386 answer
const XMS_ENTRY_SEG = 0x00C0; // three bytes below the PSP: int 2Dh; retf
const XMS_INT = 0x2D;
const XMS_TOTAL_KB = 8192;
const PSP_SEG = 0x0100;
const LOAD_SEG = 0x0110;      // PSP is 0x100 bytes = 0x10 paragraphs
// Top of conventional memory. 0x9000 left 572K free between the program and
// the ceiling, which reads as a machine with a lot of TSRs loaded -- and
// ASMINST.EXE prints "Insufficient memory! This demo needs 600k free to run"
// and exits on exactly that. A bare DOS with nothing resident hands the program
// everything up to the video ROM; 0x9F00 is that, less a paragraph or two.
const DEFAULT_ALLOC_TOP = 0x9F00;

// ---------------------------------------------------------------------------
// MZ loader
// ---------------------------------------------------------------------------
// Relocations are the whole reason this cannot be a flat read: an EXE's far
// pointers are stored relative to the load segment and have to be fixed up
// before anything far runs.
function loadExe(mem, buf, { loadSeg = LOAD_SEG, pspSeg = PSP_SEG } = {}) {
  // Dispatch on the signature, not on the file extension. A .COM is a flat
  // image with no header and no relocations -- it loads at PSP:0x100 with every
  // segment register equal, which is why it needs no fixups at all. The corpus
  // has both, and several .COM files are named .EXE and vice versa, so the
  // first two bytes are the only trustworthy test.
  // "ZM" is the other signature DOS accepts, and it is not a curiosity: one
  // program in this corpus (CAVEIRA.COM) is a real EXE carrying it, and read as
  // a .COM it entered at its own MZ header and ran off into the weeds.
  const mz = (buf[0] === 0x4D && buf[1] === 0x5A) || (buf[0] === 0x5A && buf[1] === 0x4D);
  if (!mz) return loadCom(mem, buf, { pspSeg });
  const u16 = (o) => buf.readUInt16LE(o);
  const lastPage = u16(0x02), pages = u16(0x04);
  const relocCount = u16(0x06), headerParas = u16(0x08);
  const ss = u16(0x0E), sp = u16(0x10);
  const ip = u16(0x14), cs = u16(0x16);
  const relocOff = u16(0x18);

  const headerBytes = headerParas * 16;
  let imageBytes = pages * 512 - headerBytes;
  if (lastPage) imageBytes -= (512 - lastPage);
  const image = buf.subarray(headerBytes, headerBytes + imageBytes);

  const loadLin = loadSeg << 4;
  mem.set(image, loadLin);

  for (let i = 0; i < relocCount; i++) {
    const off = u16(relocOff + i * 4);
    const seg = u16(relocOff + i * 4 + 2);
    const at = loadLin + (seg << 4) + off;
    const v = (mem[at] | (mem[at + 1] << 8)) + loadSeg;
    mem[at] = v & 0xFF;
    mem[at + 1] = (v >> 8) & 0xFF;
  }

  // A minimal PSP. INT 20h at offset 0 and the "bytes in segment" word are the
  // two fields a small intro is actually likely to read.
  const psp = pspSeg << 4;
  mem[psp] = 0xCD; mem[psp + 1] = 0x20;
  mem[psp + 2] = DEFAULT_ALLOC_TOP & 0xFF;
  mem[psp + 3] = (DEFAULT_ALLOC_TOP >> 8) & 0xFF;
  mem[psp + 0x80] = 0;              // empty command tail
  mem[psp + 0x81] = 0x0D;

  return {
    cs: (cs + loadSeg) & 0xFFFF, ip,
    ss: (ss + loadSeg) & 0xFFFF, sp,
    ds: pspSeg, es: pspSeg,
    loadSeg, pspSeg, imageBytes,
  };
}

// A .COM image: no header, no relocations, one segment. It is copied straight
// to pspSeg:0x100 and entered there with CS=DS=ES=SS=pspSeg. SP starts at
// 0xFFFE with a zero word pushed, so a `ret` exit lands on the PSP's INT 20h
// exactly the way DOS arranges it.
function loadCom(mem, buf, { pspSeg = PSP_SEG } = {}) {
  const base = pspSeg << 4;
  const max = 0x10000 - 0x100 - 2;                 // segment, less PSP and the pushed word
  const image = buf.subarray(0, Math.min(buf.length, max));
  mem.set(image, base + 0x100);

  const psp = base;
  mem[psp] = 0xCD; mem[psp + 1] = 0x20;
  mem[psp + 2] = DEFAULT_ALLOC_TOP & 0xFF;
  mem[psp + 3] = (DEFAULT_ALLOC_TOP >> 8) & 0xFF;
  mem[psp + 0x80] = 0;
  mem[psp + 0x81] = 0x0D;

  const sp = 0xFFFE;
  mem[base + sp] = 0; mem[base + sp + 1] = 0;      // ret -> PSP:0000 -> INT 20h

  return {
    cs: pspSeg, ip: 0x100,
    ss: pspSeg, sp,
    ds: pspSeg, es: pspSeg,
    loadSeg: pspSeg, pspSeg, imageBytes: image.length, com: true,
  };
}

// ---------------------------------------------------------------------------
// VGA registers
// ---------------------------------------------------------------------------
// Three index/data port pairs decide what a byte written to A000 means. Mode
// 13h is the case where the answer is "one pixel", and that is the only case a
// demo gets for free -- everything else is a tweak of these registers:
//
//   3C4/3C5 sequencer   2 = map mask (which planes a write reaches)
//                       4 = memory mode, bit 3 = chain-4. Clearing it is what
//                           "unchained"/mode X means: the four planes stop
//                           being interleaved per byte and A000 addresses one
//                           byte in each of four 64K planes at once.
//   3CE/3CF graphics    4 = read map select (which plane a read returns)
//                       5 = mode, bits 0-1 write mode (1 = copy the latches)
//                       8 = bit mask
//   3D4/3D5 CRTC        9 = max scan line (bits 0-4: row doubling)
//                    C/D = start address (page flipping)
//                      13 = offset, words per scan line -> logical width
//                   12/07 = vertical display end -> scan lines
//
// Modelling them is nearly free -- the ports are already trapped -- and it is
// what lets the renderer read the real geometry instead of assuming 320x200.
const SEQ_MEMORY_MODE = 4, SEQ_MAP_MASK = 2;
const GC_READ_MAP = 4, GC_MODE = 5, GC_BIT_MASK = 8;
const CRTC_HDE = 0x01;
const CRTC_MAX_SCAN = 0x09, CRTC_START_HI = 0x0C, CRTC_START_LO = 0x0D;
const CRTC_VDE = 0x12, CRTC_OVERFLOW = 0x07, CRTC_OFFSET = 0x13;

// The EGA 16-colour graphics modes. These are planar the way mode X is planar,
// but they are FOUR-bit: a byte in a plane is eight pixels rather than one, and
// a pixel's colour is one bit taken from each of the four planes. Nothing has
// to be unchained to get there -- chain-4 is a 256-colour feature and these
// modes are simply born planar, which is why they were invisible to a model
// that only watched the memory-mode register.
//
//   0Dh 320x200   0Eh 640x200   10h 640x350   12h 640x480
const EGA_MODES = new Map([
  [0x0D, { hde: 0x27, offset: 20, maxScan: 1, vde: 0x8F }],
  [0x0E, { hde: 0x4F, offset: 40, maxScan: 1, vde: 0x8F }],
  [0x10, { hde: 0x4F, offset: 40, maxScan: 0, vde: 0x5D }],
  [0x12, { hde: 0x4F, offset: 40, maxScan: 0, vde: 0xDF }],
]);

// The attribute palette the BIOS leaves behind. A 4-bit pixel indexes these 16
// registers; the register's value then indexes the DAC. Note it does NOT point
// at the first sixteen DAC entries: 6 is at 0x14 and 8-15 are at 0x38-0x3F.
const EGA_ATTR = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x14, 0x07,
                  0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F];

// ...which is only true because the VGA BIOS fills the first 64 DAC entries
// with the EGA's own 6-bit colour space, so that an attribute value written by
// EGA-era code means on a VGA what it meant on an EGA. The value is `rgbRGB`:
// bits 2-0 select primary red/green/blue, bits 5-3 the secondary (half
// intensity) ones, and a component lit by both is full brightness.
//
// Seeding all 64 rather than just the 16 the default palette names is what
// makes a demo that reprograms the attribute palette come out the right colour
// -- and reprogramming it is exactly what an EGA demo does instead of touching
// the DAC, because on an EGA there was no DAC to touch.
function egaDacTable() {
  const t = new Uint8Array(64 * 3);
  const level = (pri, sec) => pri * 0x2A + sec * 0x15;
  for (let n = 0; n < 64; n++) {
    t[n * 3] = level((n >> 2) & 1, (n >> 5) & 1);
    t[n * 3 + 1] = level((n >> 1) & 1, (n >> 4) & 1);
    t[n * 3 + 2] = level(n & 1, (n >> 3) & 1);
  }
  return t;
}
const EGA_DAC = egaDacTable();

function newVgaState() {
  const v = {
    seqIndex: 0, seq: new Uint8Array(8),
    gcIndex: 0, gc: new Uint8Array(16),
    crtcIndex: 0, crtc: new Uint8Array(32),
    // Attribute controller: one index/data port sharing a flip-flop that a read
    // of the status register resets. Its low 16 registers are the palette a
    // 4-bit pixel is looked up in.
    attrIndex: 0, attrFlip: 0, attr: new Uint8Array(32),
    misc: 0x63,
    planar: false,
    bpp: 0,
    // Set from the registers each time a graphics mode is left, so a frame
    // survives the mode-3 restore a well-behaved demo does before exiting.
    lastGraphics: null,
    // Counters, so a sweep can tell a program that merely indexed the
    // sequencer from one that actually drove an unchained mode.
    unchainCount: 0, maskWrites: 0, masksSeen: 0,
  };
  // Power-on state is mode 3, the same mode `Machine.videoMode` starts in --
  // *not* mode 13h. Seeding 13h here left `bpp` at 8 before the guest had set
  // any mode at all, and `bpp === 0` is what the capture path asks to decide
  // whether there is a frame to read: every program that never calls
  // INT 10h AH=00 was photographed off A000 and came back black.
  resetVgaMode(v, 3);
  return v;
}

// The register state mode 13h leaves behind, which is what every mode-X tweak
// starts from. Only the fields the renderer reads are worth setting exactly.
function resetVgaMode(v, mode) {
  const ega = EGA_MODES.get(mode);
  // A demo that restores mode 3 on its way out still has its last frame sitting
  // in A000, and the registers that describe it are about to be overwritten by
  // this call. Keep a copy: it is the only thing left to photograph for a
  // program that finished rather than one that was stopped mid-frame.
  if (v.bpp !== 0) v.lastGraphics = vgaGeometry(v);
  v.seq.fill(0);
  v.seq[SEQ_MAP_MASK] = 0x0F;
  v.seq[SEQ_MEMORY_MODE] = mode === 0x13 ? 0x0E : 0x06;   // chain-4 on for 13h
  v.gc.fill(0);
  v.gc[GC_BIT_MASK] = 0xFF;
  v.gc[GC_MODE] = mode === 0x13 ? 0x40 : 0x00;            // bit 6 = 256-colour
  v.attr.fill(0);
  v.attr.set(EGA_ATTR);
  v.attrFlip = 0;
  v.crtc.fill(0);
  v.crtc[CRTC_OVERFLOW] = 0x1F;        // VDE bit 8; bit 6 (bit 9) left clear
  if (ega) {
    v.crtc[CRTC_HDE] = ega.hde;
    v.crtc[CRTC_MAX_SCAN] = ega.maxScan;
    v.crtc[CRTC_VDE] = ega.vde;
    v.crtc[CRTC_OFFSET] = ega.offset;
  } else {
    v.crtc[CRTC_HDE] = 0x4F;           // 80 character clocks -> 320 pixels
    v.crtc[CRTC_MAX_SCAN] = 0x41;      // max scan line 1: each row drawn twice
    v.crtc[CRTC_VDE] = 0x8F;
    v.crtc[CRTC_OFFSET] = 40;          // 40 words per line -> 320 pixels
  }
  // An EGA graphics mode is planar from the moment it is set; mode 13h only
  // becomes planar when the guest clears chain-4.
  v.bpp = ega ? 4 : (mode === 0x13 ? 8 : 0);
  v.planar = !!ega;
}

// Geometry, derived the way the CRTC actually derives it rather than assumed.
// 320x200 and 320x240 both fall out of this: mode 13h leaves 400 scan lines
// with every row doubled, and the classic 320x240 tweak sets 480 with the
// doubling left in place.
function vgaGeometry(v) {
  const vde = v.crtc[CRTC_VDE]
    | ((v.crtc[CRTC_OVERFLOW] & 0x02) << 7)
    | ((v.crtc[CRTC_OVERFLOW] & 0x40) << 3);
  const rows = Math.floor((vde + 1) / ((v.crtc[CRTC_MAX_SCAN] & 0x1F) + 1));
  // Horizontal display end counts character clocks. A 256-colour mode runs at
  // half the dot clock, so each of those eight dots is four pixels wide -- and
  // that is separate from the offset register, which gives the LOGICAL row and
  // can be wider than the screen when a demo scrolls a big page.
  // A 4-bit mode runs the full dot clock and packs eight pixels into each
  // plane byte, so the same registers describe twice the pixels per character
  // clock and four times the pixels per offset word.
  const dots = v.bpp === 4 ? 8 : 4;
  const width = (v.crtc[CRTC_HDE] + 1) * dots;
  const stride = v.crtc[CRTC_OFFSET] * (v.bpp === 4 ? 16 : 8);
  const start = (v.crtc[CRTC_START_HI] << 8) | v.crtc[CRTC_START_LO];
  return {
    width: width > 0 && width <= 800 ? width : 320,
    height: rows > 0 && rows <= 600 ? rows : 200,
    stride: stride > 0 ? stride : 320,
    start,
    planar: v.planar,
    bpp: v.bpp,
    // The attribute palette, so the renderer can turn a 4-bit pixel into the
    // DAC entry the hardware would have looked it up in.
    attr: Array.from(v.attr.subarray(0, 16)),
  };
}

// ---------------------------------------------------------------------------
// The text console
// ---------------------------------------------------------------------------
// Four fifths of the demo corpus never leaves mode 3h, and a screenshot of
// those was a black rectangle -- not because they had failed, but because
// nothing was collecting what they wrote. README!.COM is the shape of it: 202
// calls to INT 21h AH=02 carrying `1b 5b 31 3b 33 30 6d`, which is an ANSI
// colour escape. It is painting a text screen correctly and we were dropping it
// a character at a time.
//
// So the console is a real 80x25 grid of {char, attribute} written through a
// cursor, exactly like the hardware's B800 page, plus enough of the ANSI
// sequence set that colour and cursor movement land where the program meant
// them. That makes text-mode programs renderable and, just as usefully,
// measurable: "wrote nothing at all" and "painted a screen we could not see"
// stop looking alike.
const CON_COLS = 80, CON_ROWS = 25;

// The colour text page. This is not a shadow of the screen, it IS the screen:
// a text-mode DOS program is free to write characters through INT 21h, through
// the BIOS, or by storing directly into B800 -- and plenty of the demos in this
// corpus do the last one, because it is the only one that is fast. Backing the
// grid with the guest's own memory is what makes all three land in the same
// place, and it is what the hardware does.
const VRAM_TEXT = 0xB8000;

function newConsole(mem) {
  const cells = CON_COLS * CON_ROWS;
  for (let i = 0; i < cells; i++) { mem[VRAM_TEXT + i * 2] = 0x20; mem[VRAM_TEXT + i * 2 + 1] = 0x07; }
  return {
    cols: CON_COLS, rows: CON_ROWS, cells, mem, base: VRAM_TEXT,
    getCh(at) { return this.mem[this.base + at * 2]; },
    getAt(at) { return this.mem[this.base + at * 2 + 1]; },
    put(at, ch, attr) {
      this.mem[this.base + at * 2] = ch;
      this.mem[this.base + at * 2 + 1] = attr;
    },
    fillCells(from, to, ch, attr) {
      for (let i = from; i < to; i++) this.put(i, ch, attr);
    },
    // Move `n` rows of cells within the page, source row to destination row.
    copyRow(dstRow, srcRow) {
      const b = this.base;
      this.mem.copyWithin(b + dstRow * this.cols * 2, b + srcRow * this.cols * 2,
        b + (srcRow + 1) * this.cols * 2);
    },
    x: 0, y: 0, attr: 0x07,
    // Everything written, in order, so a caller can have the raw stream when a
    // grid is the wrong shape for the question.
    raw: [],
    written: 0,
    // Partial ANSI escape, accumulated across calls -- a program emitting one
    // character per INT 21h splits every sequence it writes.
    esc: null,
    savedX: 0, savedY: 0,
  };
}

// What autoKey answers a blocking read with, in order, rotating.
//
// Enter alone is not enough, and the text screens are what showed it: about ten
// programs in this corpus open on a sound-device menu that ignores Enter
// completely -- "a. PC Speaker / p. No sound / Select an output device :",
// "MUSIC [Y/N]", "[1] a GUS or no Sound card at all or [2] a Soundblaster".
// Each of those wants one specific character, and a headless run wants the
// silent option in every case, so the rotation leads with the keys that mean
// "no sound" and only then tries the generic ones. A menu polling in a loop
// gets a different key each time round and moves on as soon as one is accepted.
//
// AH is the scancode, which the INT 16h forms return alongside the character;
// a program reading only AL never looks at it, but the ones that read the whole
// word do.
// What an option label has to say for the menu reader to pick it. Every one of
// these is on a screen in this corpus; the negations matter, because "No sound
// card" and "Sound card" differ by two characters and select opposite things.
const SILENT_LABEL =
  /\b(no|without|none|neither|not?)\s*(sound|music|sfx|audio|card|soundcard)?\b|^\s*(none|silence|silent|quit|exit|no)\b|pc[- ]?speaker|internal speaker|beeper|no thanks/i;

// Scancodes for the characters the menu reader can produce. A program reading
// only AL never looks at AH, but the ones taking the whole INT 16h word do.
const SCAN = {
  1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05, 5: 0x06, 6: 0x07, 7: 0x08, 8: 0x09, 9: 0x0A, 0: 0x0B,
  q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19,
  a: 0x1E, s: 0x1F, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26,
  z: 0x2C, x: 0x2D, c: 0x2E, v: 0x2F, b: 0x30, n: 0x31, m: 0x32,
};

const AUTO_KEYS = [
  { ah: 0x19, al: 0x70 },   // p -- "No sound" in every GoldPlay setup here
  { ah: 0x31, al: 0x6E },   // n -- "MUSIC [Y/N]", "do you have a GUS"
  { ah: 0x02, al: 0x31 },   // 1 -- first entry of a numbered menu
  { ah: 0x1C, al: 0x0D },   // Enter
  { ah: 0x39, al: 0x20 },   // space
  { ah: 0x15, al: 0x79 },   // y
  { ah: 0x1E, al: 0x61 },   // a
];

// The 16 CGA text colours as 6-bit DAC triples, in attribute-byte order.
const CGA_DAC = [
  [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42],
  [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
  [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63],
  [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
];
// ANSI SGR colour numbers are ordered R/G/B where the attribute byte is B/G/R.
const ANSI_TO_CGA = [0, 4, 2, 6, 1, 5, 3, 7];

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------
class Machine {
  constructor(mem, opts = {}) {
    this.mem = mem;
    this.log = opts.log || (() => {});
    this.videoMode = 3;
    this.palette = new Uint8Array(768);
    this.dacWriteIndex = 0;
    this.dacSubIndex = 0;
    this.retraceToggle = 0;
    this.vga = newVgaState();
    this.con = newConsole(mem);
    this.ticks = 0;
    this.exited = false;
    this.exitCode = 0;
    // Set the first time a BLOCKING key read finds an empty queue. These calls
    // used to hand back AL=0 and let the guest carry on, which silently answers
    // every "press any key" prompt in the corpus with a NUL -- a-note.exe put
    // its whole screen up, took the phantom key, restored mode 3 (clearing the
    // screen) and exited, all inside 5434 dispatches, and looked from the
    // outside like a program that had never drawn anything. The driver stops
    // the run here instead, which is both closer to a real blocking read and
    // the moment worth photographing.
    this.blockedOnKey = false;
    this.keys = opts.keys ? [...opts.keys] : [];   // queued as {ah, al}
    this.autoKey = !!opts.autoKey;
    this.autoKeyAt = 0;
    this.autoKeyScreen = null;   // the screen the last menu answer was read off
    this.autoKeyQueue = [];      // the rest of a multi-character typed answer
    this.autoKeyRead = 0;        // keys chosen by reading, not by rotating
    this.forceChained = !!opts.forceChained;
    this.mouse = { x: 160, y: 100, buttons: 0, dx: 0, dy: 0 };
    // A freshly loaded .EXE owns every paragraph up to the ceiling, so the
    // free pool starts empty and fills when the program shrinks its own block.
    this.allocTop = DEFAULT_ALLOC_TOP;
    // XMS blocks and EMS handles, both backed by host buffers. Counters so a
    // run can say whether a manager was merely detected or actually used.
    // Open files, and a record of what was asked for -- "which file could it
    // not find" is the first question when a demo renders an empty screen.
    this.fileRoot = opts.fileRoot || null;
    this.files = new Map(); this.fileNext = 5;   // 0-4 are the standard handles
    this.filesOpened = []; this.filesMissed = [];
    this.xmsBlocks = new Map(); this.xmsNext = 1; this.xmsMoved = 0;
    this.emsHandles = new Map(); this.emsNext = 1; this.emsMaps = 0;
    this.emsMapped = [null, null, null, null];
    this.unhandled = new Map();
    this.intCount = new Map();
    // Which clock, if any, a program is pacing itself off. A demo that never
    // touches any of these cannot be waiting for time and is compute-bound by
    // construction; one that hammers retrace is frame-paced. Does NOT see a
    // program polling the BIOS tick word in memory directly -- that one is
    // only visible by changing tickScale and watching the frame move. The
    // interrupt-driven clocks (INT 1Ah, 15h, 16h) are already in `intCount`.
    this.clock = { retrace: 0, pit: 0 };
    // The 8253, as three down-counters rather than a number that goes up.
    //
    // Channel 0 is the one that matters: it divides 1.193182 MHz by its latch,
    // and a latch of 0 means 65536, which is where 18.2 Hz comes from. Programs
    // read the counter for sub-tick resolution -- Turbo Pascal's CRT unit times
    // its delay loop that way and divides by what it measured, so a counter
    // that does not count produced runtime error 200 in four demos here.
    // `phase` is the fractional BIOS tick the driver bills against guest work.
    this.pit = {
      latch: [0x10000, 0x10000, 0x10000],
      pending: [0, 0, 0],       // bytes of a latch written so far
      readHi: [false, false, false],
      access: [3, 3, 3],        // 1 = lo only, 2 = hi only, 3 = lo then hi
      phase: 0,
    };

    this.installIvt();
    // BIOS data area: video mode byte and the 55ms tick counter at 0040:006C,
    // which is where a demo reads time from when it does not hook INT 8.
    mem[0x449] = this.videoMode;
    this.setTicks(0);
  }

  // The real guest memory arrives after construction, once the wasm instance
  // exists. The text page lives inside it, so the console has to be re-pointed
  // and the page re-blanked rather than left addressing the throwaway buffer.
  // --- the file side of DOS ------------------------------------------------
  // Every program here runs from the directory its data is in, so the whole of
  // "the filesystem" is that one directory. Read-only on purpose: a sweep runs
  // 199 programs unattended and none of them has any business writing to the
  // corpus.
  guestPath(r) {
    const at = ((r.get('ds') << 4) + (r.get('dx') & 0xFFFF)) & 0xFFFFF;
    let s = '';
    for (let i = at; i < this.mem.length && this.mem[i] && s.length < 128; i++) {
      s += String.fromCharCode(this.mem[i]);
    }
    return s;
  }

  // DOS is case-insensitive and the corpus is not: the name in the binary is
  // usually upper case and the file on disk usually is not, or the other way
  // round in the same directory. Drive letters and directories are dropped --
  // a demo that says C:\SOUND\FILE.DAT means the file next to it.
  hostPath(name) {
    if (!this.fileRoot || !name) return null;
    const base = name.replace(/^[A-Za-z]:/, '').split(/[\\/]/).filter(Boolean).pop();
    if (!base) return null;
    if (this.dirCache === undefined) {
      try { this.dirCache = fs.readdirSync(this.fileRoot); } catch { this.dirCache = []; }
    }
    const hit = this.dirCache.find(f => f.toLowerCase() === base.toLowerCase());
    return hit ? `${this.fileRoot}/${hit}` : null;
  }

  openFile(name) {
    const p = this.hostPath(name);
    if (!p) { this.filesMissed.push(name); return 0; }
    let buf;
    try { buf = fs.readFileSync(p); } catch { this.filesMissed.push(name); return 0; }
    const h = this.fileNext++;
    this.files.set(h, { buf, pos: 0, name });
    this.filesOpened.push(name);
    return h;
  }

  // What is on the text page, as lines. The autoKey menu reader works off this,
  // and so does any caller that wants to know what a program said.
  screenText() {
    const c = this.con, rows = [];
    for (let y = 0; y < c.rows; y++) {
      let s = '';
      for (let x = 0; x < c.cols; x++) {
        const b = c.getCh(y * c.cols + x);
        s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : ' ';
      }
      rows.push(s.replace(/\s+$/, ''));
    }
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows;
  }

  // Read the menu instead of guessing at it.
  //
  // The rotation below gets past a prompt eventually, but "eventually" means
  // several wrong keys first, and a menu that redraws on a bad key never
  // settles. The screen is right there and it says what it wants: BLINKY.EXE
  // prints "a. PC Speaker / p. No sound / Select an output device :", BUDENZA
  // prints "1) No Music 2) DAC/Covox on LPT1 ...", CULT asks "Do YOU have a
  // sound card Called Gravis Ultra Sound [GUS]". A headless run wants silence
  // in every one of those, so the option whose label says so is the answer.
  //
  // Returns null when the screen is not a menu, which is the common case and
  // leaves the rotation to it.
  menuKey() {
    const lines = this.screenText();
    if (!lines.length) return null;
    const key = (ch) => ({ ah: SCAN[ch.toLowerCase()] ?? 0, al: ch.charCodeAt(0) });

    // The last line first, because it is the question actually being asked.
    // Everything above it is scrollback: cchop.exe leaves its "a. PC Speaker /
    // p. No sound" menu on screen while it asks "Enter mix speed:", and a
    // reader that scans the whole screen answers the question it already
    // answered a moment ago.
    //
    // A line ending in a colon wants a NUMBER typed, and one keystroke is the
    // wrong shape of answer entirely -- every single character cchop was
    // offered ended in "Runtime error 006", Turbo Pascal for "not a number".
    // The prompt usually names the value it wants in the sentence above it
    // ("10000 is recommended for most computers"), so use that when it is
    // there.
    const all = lines.join('\n');
    const tail = lines[lines.length - 1] || '';
    if (/\b(enter|input|type)\b[^:]{0,40}:\s*$/i.test(tail) && !/press/i.test(tail)) {
      const rec = /(\d{2,6})\s*(?:is\s+)?(?:recommended|default|suggested)/i.exec(all);
      return [...(rec ? rec[1] : '1')].map(ch => key(ch)).concat([{ ah: 0x1C, al: 0x0D }]);
    }

    // "[1] a GUS or no Sound card at all" and "p. No sound" are the same shape:
    // a single-character selector, then the label it selects.
    const opts = [];
    for (const line of lines) {
      const re = /(?:^|\s{2,})[\[(]?([0-9A-Za-z])[\]).:)]\s*([^[(]{2,40})/g;
      for (let m; (m = re.exec(line));) opts.push({ ch: m[1], label: m[2].trim() });
    }
    const silent = opts.find(o => SILENT_LABEL.test(o.label));
    if (silent) return key(silent.ch);

    // A yes/no question. Answer it the way that avoids hardware we do not
    // have; every one of these in the corpus is asking about a sound card.
    if (/\[\s*y\s*\/\s*n\s*\]|\(\s*y\s*\/\s*n\s*\)|\by\s*\/\s*n\b/i.test(all)) {
      return key(/sound|music|gus|sb|adlib|card|midi/i.test(all) ? 'n' : 'y');
    }
    if (/press\s+(any\s+key|a\s+key|enter|return|\[?enter\]?)/i.test(all)) {
      return { ah: 0x1C, al: 0x0D };
    }
    if (/press\s+(space|the\s+space\s*bar)/i.test(all)) return { ah: 0x39, al: 0x20 };
    // A selector list with no silent option: take the first one offered rather
    // than a key that is not on the menu at all.
    if (opts.length >= 2) return key(opts[0].ch);
    return null;
  }

  // One synthetic keystroke, or null when autoKey is off. Rotates, so a menu
  // that refuses the first answer is offered the next one on its next poll.
  autoKeyNext() {
    if (!this.autoKey) return null;
    // Read the menu first, but only once per screen: if the program is still
    // showing the same thing after being sent the key it asked for, that key
    // was not the answer and repeating it forever is how a run hangs politely.
    // A typed answer is more than one keystroke, so it queues; the program
    // reads it one INT 16h at a time exactly as it would from a real typist.
    if (this.autoKeyQueue.length) return this.autoKeyQueue.shift();
    const shown = this.screenText().join('\n');
    if (shown !== this.autoKeyScreen) {
      this.autoKeyScreen = shown;
      const k = this.menuKey();
      if (Array.isArray(k)) {
        this.autoKeyRead++;
        this.autoKeyQueue = k.slice(1);
        return k[0];
      }
      if (k) { this.autoKeyRead++; return k; }
    }
    return AUTO_KEYS[this.autoKeyAt++ % AUTO_KEYS.length];
  }

  // One typed line, terminated with CR LF, or null when nothing is waiting and
  // nothing is answering. Characters come from the injected queue first and the
  // menu reader second, exactly as a single-key read does -- so a screen that
  // asks a question in the shape the reader understands gets its answer typed
  // in full, and one that does not gets the rotation, one character per line.
  typedLine(max) {
    let s = '';
    for (let i = 0; i < Math.max(0, Math.min(max, 255) - 2); i++) {
      const k = this.keys.shift() || this.autoKeyNext();
      if (!k) return s ? `${s}\r\n` : null;
      if (k.al === 0x0D) break;
      if (k.al >= 0x20 && k.al < 0x7F) s += String.fromCharCode(k.al);
    }
    return `${s}\r\n`;
  }

  setMemory(mem) {
    this.mem = mem;
    this.con.mem = mem;
    this.con.fillCells(0, this.con.cells, 0x20, 0x07);
  }

  installIvt() {
    for (let v = 0; v < 256; v++) {
      const at = v * 4;
      // Offset is 0x100 + the vector, not the vector itself: the run loop
      // recovers the vector as `ip & 0xFF` either way, and this leaves the
      // first 256 bytes of the stub segment free for the driver signatures a
      // program reads out of a handler's own segment. That is how an expanded
      // memory manager is detected -- get the INT 67h vector, then compare
      // ES:000A against "EMMXXXX0" -- and with the stubs at offset v those
      // eight bytes sat on top of the stubs for INT 0Ah through INT 11h,
      // INT 10h among them.
      this.mem[at] = STUB_OFF + v;
      this.mem[at + 1] = (STUB_OFF + v) >> 8;
      this.mem[at + 2] = STUB_SEG & 0xFF;
      this.mem[at + 3] = STUB_SEG >> 8;
      this.mem[(STUB_SEG << 4) + STUB_OFF + v] = STUB_BYTE;
    }
    const base = STUB_SEG << 4;
    for (let i = 0; i < EMS_NAME.length; i++) this.mem[base + 0x0A + i] = EMS_NAME.charCodeAt(i);

    this.installRomFonts();

    // The XMS control function is not reached through an interrupt: INT 2Fh
    // hands back a far pointer and the program CALLs it. So it has to be three
    // real instructions rather than a stub byte -- `int 2Dh` to get here, then
    // `retf` to go back to the caller, since a far call pushed two words where
    // the interrupt's IRET frame has three.
    const xms = XMS_ENTRY_SEG << 4;
    this.mem[xms] = 0xCD; this.mem[xms + 1] = XMS_INT; this.mem[xms + 2] = 0xCB;
  }

  // The character generator, where the ROM would have it.
  //
  // INT 10h AH=11 AL=30 hands back a pointer to the BIOS font, and a demo that
  // draws its own text in a graphics mode asks for it rather than shipping a
  // font: it is the single commonest unhandled call in this corpus. Returning
  // nothing is not neutral -- ANARCHY.EXE takes the garbage pointer, draws 400
  // scanlines of nothing and sits there.
  //
  // The glyphs come from the bundled Terminal.fon, which is the VGA face at 12
  // rows. The 14- and 16-row tables pad it vertically rather than stretching
  // it, so the shapes stay the shapes; the 8-row one takes the body rows. Each
  // is reported at the height it really is, which is what CX is for.
  installRomFonts() {
    const strike = romStrike();
    for (const [seg, height, top] of ROM_FONTS) {
      const at = seg << 4;
      for (let c = 0; c < 256; c++) {
        const g = strike && strike.glyphs.get(c);
        for (let row = 0; row < height; row++) {
          let byte = 0;
          const src = row - top;
          if (g && src >= 0 && src < g.height) {
            for (let x = 0; x < 8 && x < g.width; x++) {
              if (g.bits[src * g.width + x]) byte |= 0x80 >> x;
            }
          }
          this.mem[at + c * height + row] = byte;
        }
      }
    }
  }

  // Guest time as a fraction of a BIOS tick. The driver bills this against
  // guest work, and everything time-shaped reads off it: the 55ms counter at
  // 0040:006C is its integer part, and the PIT counter is its fraction --
  // 65536 counts to the tick, which is where 18.2 Hz comes from in the first
  // place, so the two cannot drift apart by construction.
  setClock(t) {
    this.pit.phase = t;
    this.setTicks(Math.floor(t));
  }

  // Where channel `ch` has counted down to. Counts are 1..latch, never 0 --
  // the hardware reloads on the way past, and a program that divides by what
  // it read must not see a zero.
  pitCount(ch) {
    const latch = this.pit.latch[ch] || 0x10000;
    const elapsed = Math.floor(this.pit.phase * 65536);
    return latch - (((elapsed % latch) + latch) % latch);
  }

  setTicks(t) {
    this.ticks = t >>> 0;
    const at = 0x46C;
    this.mem[at] = this.ticks & 0xFF;
    this.mem[at + 1] = (this.ticks >> 8) & 0xFF;
    this.mem[at + 2] = (this.ticks >> 16) & 0xFF;
    this.mem[at + 3] = (this.ticks >> 24) & 0xFF;
  }

  // Has the guest taken a vector over, or is it still ours?
  //
  // Every vector starts out pointing into the stub segment, so "not the stub
  // segment" is exactly "the program installed its own handler". No bookkeeping
  // in the INT 21h AH=25 path is needed, and a program that writes the IVT
  // directly -- which several here do, since it is two stores -- is caught too.
  hookedVector(v) {
    const at = v << 2;
    return (this.mem[at + 2] | (this.mem[at + 3] << 8)) !== STUB_SEG;
  }

  // Which vector a timer tick should be delivered through, or 0 for none.
  //
  // A demo that hooks INT 08h is not asking for the BIOS tick word -- it is
  // asking to be CALLED. brainbug.exe installs a handler, clears the screen and
  // then waits for a counter its own ISR increments; with no interrupt ever
  // delivered it sat on a black mode X frame for 20M dispatches and read
  // exactly like a broken decoder. INT 1Ch is the same deal one level up: the
  // BIOS timer handler chains to it, so a program that only hooks 1Ch expects
  // the same call.
  timerVector() {
    if (this.hookedVector(0x08)) return 0x08;
    if (this.hookedVector(0x1C)) return 0x1C;
    return 0;
  }

  // --- ports ---------------------------------------------------------------
  portIn(port, w) {
    if (port === 0x3DA) {
      // Bit 3 is vertical retrace, bit 0 "display disabled". A demo that waits
      // for retrace to start needs to see the bit both clear and set or it
      // spins forever, so this alternates on every read.
      this.clock.retrace++;
      this.retraceToggle ^= 1;
      // Reading the status register is also how the attribute controller's
      // shared index/data flip-flop is put back into "next write is an index".
      this.vga.attrFlip = 0;
      return this.retraceToggle ? 0x09 : 0x00;
    }
    if (port === 0x3C9) {
      const v = this.palette[this.dacWriteIndex * 3 + this.dacSubIndex] & 0x3F;
      if (++this.dacSubIndex === 3) { this.dacSubIndex = 0; this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF; }
      return v;
    }
    // Read-back of the register files. Code that tweaks one bit of the memory
    // mode does IN/OR/OUT, so returning 0xFF here would set every other bit
    // as a side effect -- including chain-4, which would undo a mode X set.
    if (port === 0x3C5) return this.vga.seq[this.vga.seqIndex];
    if (port === 0x3CF) return this.vga.gc[this.vga.gcIndex];
    if (port === 0x3D5 || port === 0x3B5) return this.vga.crtc[this.vga.crtcIndex];
    if (port === 0x3C4) return this.vga.seqIndex;
    if (port === 0x3CE) return this.vga.gcIndex;
    if (port === 0x3D4 || port === 0x3B4) return this.vga.crtcIndex;
    if (port === 0x3CC) return this.vga.misc;
    if (port === 0x60) return 0;            // keyboard data: no key down
    if (port >= 0x40 && port <= 0x42) {
      this.clock.pit++;
      const ch = port - 0x40;
      const n = this.pitCount(ch);
      const acc = this.pit.access[ch];
      if (acc === 1) return n & 0xFF;
      if (acc === 2) return (n >> 8) & 0xFF;
      const hi = this.pit.readHi[ch];
      this.pit.readHi[ch] = !hi;
      return hi ? (n >> 8) & 0xFF : n & 0xFF;
    }
    return w === 16 ? 0xFFFF : 0xFF;
  }

  portOut(port, value, w) {
    if (w === 16) { this.portOut(port, value & 0xFF, 8); this.portOut(port + 1, (value >> 8) & 0xFF, 8); return; }
    value &= 0xFF;
    // The PIT. A demo reprogramming channel 0 is asking for a faster music
    // interrupt, and one reprogramming channel 2 is driving the speaker; both
    // change what a read of the counter means, so the latch has to be kept.
    if (port === 0x43) {
      const ch = (value >> 6) & 3;
      if (ch !== 3) {                       // 3 is the read-back command
        const acc = (value >> 4) & 3;
        if (acc === 0) this.pit.readHi[ch] = false;   // latch-for-read, no state
        else { this.pit.access[ch] = acc; this.pit.pending[ch] = 0; this.pit.readHi[ch] = false; }
      }
      return;
    }
    if (port >= 0x40 && port <= 0x42) {
      const ch = port - 0x40, p = this.pit;
      if (p.access[ch] === 1) p.latch[ch] = value || 0x100;
      else if (p.access[ch] === 2) p.latch[ch] = (value << 8) || 0x10000;
      else if (p.pending[ch] === 0) { p.latch[ch] = value; p.pending[ch] = 1; }
      else { p.latch[ch] = ((value << 8) | (p.latch[ch] & 0xFF)) || 0x10000; p.pending[ch] = 0; }
      return;
    }
    if (port === 0x3C8) { this.dacWriteIndex = value; this.dacSubIndex = 0; return; }
    if (port === 0x3C7) { this.dacWriteIndex = value; this.dacSubIndex = 0; return; }
    if (port === 0x3C9) {
      this.palette[this.dacWriteIndex * 3 + this.dacSubIndex] = value & 0x3F;
      if (++this.dacSubIndex === 3) { this.dacSubIndex = 0; this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF; }
      return;
    }
    const v = this.vga;
    // Index/data pairs. A write to the index port with a 16-bit OUT carries
    // the data in AH, and the recursion at the top of this function has
    // already split that into two 8-bit writes, so both spellings land here.
    switch (port) {
      case 0x3C4: v.seqIndex = value & 0x07; return;
      case 0x3C5: this.vgaSeqWrite(v.seqIndex, value); return;
      case 0x3CE: v.gcIndex = value & 0x0F; return;
      case 0x3CF:
        v.gc[v.gcIndex] = value;
        // Every graphics register now feeds the write pipeline, so mirror the
        // whole file rather than picking out the two mode X happened to need.
        this.syncVga();
        return;
      case 0x3C0:
        // Index and data alternate through one port.
        if (v.attrFlip === 0) { v.attrIndex = value & 0x1F; v.attrFlip = 1; }
        else { v.attr[v.attrIndex] = value; v.attrFlip = 0; }
        return;
      case 0x3D4: case 0x3B4: v.crtcIndex = value & 0x1F; return;
      case 0x3D5: case 0x3B5: v.crtc[v.crtcIndex] = value; return;
      case 0x3C2: v.misc = value; return;
      default: return;                       // everything else is dropped
    }
  }

  vgaSeqWrite(index, value) {
    const v = this.vga;
    v.seq[index] = value;
    if (index === SEQ_MAP_MASK) {
      v.maskWrites++;
      v.masksSeen |= 1 << (value & 0x0F);
      if (v.planar) this.syncVga();
      return;
    }
    if (index !== SEQ_MEMORY_MODE) return;
    // Chain-4 off in a 256-colour mode is the whole definition of mode X. It
    // changes what a byte at A000 means, so the plane store has to be told.
    //
    // `forceChained` (--chain4) pins the old behaviour -- every A000 byte is one
    // pixel in guest RAM -- so a program whose behaviour changes when it
    // unchains can be A/B'd without a rebuild. It is a lie about the hardware
    // and purely a debugging aid.
    //
    // A 4-bit EGA mode is planar whatever this register says -- chain-4 is a
    // 256-colour feature and the bit is not even meaningful there -- so only
    // mode 13h is allowed to change its mind here.
    if (v.bpp === 4) return;
    const planar = !this.forceChained && this.videoMode === 0x13 && !(value & 0x08);
    if (planar === v.planar) return;
    v.planar = planar;
    if (planar) v.unchainCount++;
    this.log(`vga ${planar ? 'unchained (mode X)' : 'chained'}`);
    this.vgaRechain(planar);
    this.syncVga();
  }

  // --- the plane store -----------------------------------------------------
  // The VM reads its four control words straight out of shared memory, so
  // keeping the hardware model in step is four stores and no import. Call it
  // after anything that moves the map mask, the read map, the write mode or
  // the chain-4 bit -- and after run-dos.js swaps in the VM's own buffer.
  syncVga() {
    const v = this.vga, m = this.mem;
    if (m.length <= isa.VGA_CTL_KEY) return;      // a bare Machine, no VM yet
    const st = (at, val) => {
      m[at] = val & 0xFF; m[at + 1] = (val >> 8) & 0xFF;
      m[at + 2] = (val >> 16) & 0xFF; m[at + 3] = (val >>> 24) & 0xFF;
    };
    st(isa.VGA_CTL_KEY, v.planar ? isa.VGA_KEY_ON : isa.VGA_KEY_OFF);
    st(isa.VGA_CTL_MASK, v.seq[SEQ_MAP_MASK] & 0x0F);
    for (let i = 0; i < 9; i++) st(isa.VGA_CTL_GC + i * 4, v.gc[i]);
  }

  // --- the text console ----------------------------------------------------
  // One character, through the cursor, with ANSI sequences interpreted rather
  // than printed. Everything that writes text -- DOS teletype, DOS string
  // print, the BIOS TTY call -- funnels here so there is one cursor and one
  // grid no matter which route a program picked.
  conPutc(b) {
    const c = this.con;
    c.written++;
    c.raw.push(b);
    if (c.esc !== null) { this.conEsc(b); return; }
    switch (b) {
      case 0x1B: c.esc = ''; return;
      case 0x0D: c.x = 0; return;
      case 0x0A: c.y++; this.conClamp(); return;
      case 0x08: if (c.x > 0) c.x--; return;
      case 0x07: return;                                   // bell
      case 0x09: c.x = Math.min(c.cols - 1, (c.x + 8) & ~7); return;
      default: break;
    }
    c.put(c.y * c.cols + c.x, b, c.attr);
    if (++c.x >= c.cols) { c.x = 0; c.y++; this.conClamp(); }
  }

  // Scroll rather than run off the bottom, which is what a real console does
  // and what an 80x25 ANSI screen is drawn assuming.
  conClamp() {
    const c = this.con;
    while (c.y >= c.rows) {
      c.mem.copyWithin(c.base, c.base + c.cols * 2, c.base + c.cells * 2);
      c.fillCells(c.cells - c.cols, c.cells, 0x20, c.attr);
      c.y--;
    }
    if (c.y < 0) c.y = 0;
  }

  // The ANSI subset this corpus actually emits: SGR colour, cursor position and
  // movement, save/restore, and the three erase forms. An unrecognised final
  // byte ends the sequence and is dropped rather than printed, which is what a
  // terminal does and keeps a stray escape from spraying the grid.
  conEsc(b) {
    const c = this.con;
    if (c.esc === '' && b !== 0x5B) {                      // not a CSI
      c.esc = null;
      return;
    }
    if (b >= 0x40 && b !== 0x5B) {                         // final byte
      const seq = c.esc.slice(1);
      const n = seq.split(';').map(s => (s === '' ? null : parseInt(s, 10) | 0));
      const a = (i, d) => (n[i] == null ? d : n[i]);
      switch (String.fromCharCode(b)) {
        case 'm':
          for (const raw of n.length ? n : [0]) {
            const v = raw == null ? 0 : raw;
            if (v === 0) c.attr = 0x07;
            else if (v === 1) c.attr |= 0x08;              // bold -> intensity
            else if (v === 5) c.attr |= 0x80;              // blink
            else if (v === 7) c.attr = ((c.attr & 0x0F) << 4) | ((c.attr >> 4) & 0x0F);
            else if (v >= 30 && v <= 37) c.attr = (c.attr & 0xF8) | ANSI_TO_CGA[v - 30];
            else if (v >= 40 && v <= 47) c.attr = (c.attr & 0x8F) | (ANSI_TO_CGA[v - 40] << 4);
          }
          break;
        case 'H': case 'f':
          c.y = Math.max(0, a(0, 1) - 1); c.x = Math.max(0, a(1, 1) - 1);
          break;
        case 'A': c.y -= a(0, 1); break;
        case 'B': c.y += a(0, 1); break;
        case 'C': c.x += a(0, 1); break;
        case 'D': c.x -= a(0, 1); break;
        case 's': c.savedX = c.x; c.savedY = c.y; break;
        case 'u': c.x = c.savedX; c.y = c.savedY; break;
        case 'J': {
          const at = c.y * c.cols + c.x;
          const [from, to] = a(0, 0) === 2 ? [0, c.cells]
            : a(0, 0) === 1 ? [0, at] : [at, c.cells];
          c.fillCells(from, to, 0x20, c.attr);
          if (a(0, 0) === 2) { c.x = 0; c.y = 0; }
          break;
        }
        case 'K': {
          const row = c.y * c.cols;
          const [from, to] = a(0, 0) === 2 ? [row, row + c.cols]
            : a(0, 0) === 1 ? [row, row + c.x + 1] : [row + c.x, row + c.cols];
          c.fillCells(from, to, 0x20, c.attr);
          break;
        }
        default: break;
      }
      c.x = Math.max(0, Math.min(c.cols - 1, c.x));
      this.conClamp();
      c.esc = null;
      return;
    }
    c.esc += String.fromCharCode(b);
    if (c.esc.length > 32) c.esc = null;      // runaway: not a sequence
  }

  conPuts(s) { for (let i = 0; i < s.length; i++) this.conPutc(s.charCodeAt(i) & 0xFF); }

  // A mode set on real hardware leaves the planes cleared. Doing it here rather
  // than in vgaRechain keeps the two apart: rechaining CARRIES a picture across
  // an addressing change, this throws one away.
  clearPlanes() {
    const m = this.mem;
    if (m.length <= isa.VGA_PLANES) return;
    m.fill(0, isa.VGA_PLANES, isa.VGA_PLANES + isa.VGA_PLANE_SIZE * 4);
  }

  // Carry the picture across a chain-4 change instead of dropping it.
  //
  // Chain-4 is not a different memory, it is a different *addressing* of the
  // same four planes: byte `off` of the A000 window is plane `off & 3` at plane
  // offset `off >> 2`. The chained path writes the interleaved form straight
  // into guest RAM, so switching modes is a de-interleave one way and a
  // re-interleave the other. Demos routinely clear the screen in plain 13h and
  // only then unchain, and without this that clear -- or a whole loaded image
  // -- would vanish at the mode switch.
  vgaRechain(toPlanar) {
    const m = this.mem;
    if (m.length <= isa.VGA_PLANES) return;
    for (let i = 0; i < 0x10000; i++) {
      const p = isa.VGA_PLANES + ((i & 3) << 16) + (i >> 2);
      if (toPlanar) m[p] = m[VGA_BASE + i];
      else m[VGA_BASE + i] = m[p];
    }
  }

  // --- interrupts ----------------------------------------------------------
  // Returns true if the interrupt was serviced, false if it is one we do not
  // know -- an unknown one is counted and IRETed, which is what a bare machine
  // with no handler installed effectively does.
  service(vec, r) {
    this.intCount.set(vec, (this.intCount.get(vec) || 0) + 1);
    const ah = (r.get('ax') >> 8) & 0xFF, al = r.get('ax') & 0xFF;

    switch (vec) {
      case 0x10: return this.int10(ah, al, r);
      case 0x16: return this.int16(ah, r);
      case 0x1A:
        if (ah === 0x00) {
          r.set('cx', (this.ticks >> 16) & 0xFFFF);
          r.set('dx', this.ticks & 0xFFFF);
          r.set('ax', 0);
          return true;
        }
        return false;
      // The BIOS timer handler, and the user hook it chains to. An ISR that
      // ends by jumping to the vector it saved arrives here, and the honest
      // answer is "nothing left to do": the tick word is already advancing and
      // there is no PIC to acknowledge.
      case 0x08: case 0x1C: return true;
      case 0x20: this.exited = true; this.exitCode = 0; return true;
      case 0x21: return this.int21(ah, al, r);
      case 0x2D: return this.xms(ah, r);        // reached from the XMS stub
      case 0x2F: return this.int2f(ah, al, r);
      case 0x33: return this.int33(r);
      case 0x67: return this.ems(ah, al, r);
      default: {
        const n = this.unhandled.get(vec) || 0;
        this.unhandled.set(vec, n + 1);
        return false;
      }
    }
  }

  int10(ah, al, r) {
    if (ah === 0x00) {
      this.videoMode = al & 0x7F;
      this.mem[0x449] = this.videoMode;
      // Setting a mode clears the display and re-chains the planes -- a demo
      // that unchains does it AFTER asking the BIOS for mode 13h.
      resetVgaMode(this.vga, this.videoMode);
      this.syncVga();
      if (this.videoMode === 0x13) this.mem.fill(0, VGA_BASE, VGA_BASE + 320 * 200);
      if (this.vga.bpp === 4) {
        this.clearPlanes();
        this.palette.set(EGA_DAC);         // the EGA-compatible first 64 entries
      }
      this.log(`int10 set mode ${this.videoMode.toString(16)}h`);
      return true;
    }
    if (ah === 0x0F) {                      // get current mode
      r.set('ax', (this.videoMode & 0xFF) | (80 << 8));
      r.set('bx', (r.get('bx') & 0x00FF));
      return true;
    }
    // The attribute palette, through the BIOS. EGA-era code sets its colours
    // this way rather than through the DAC -- on an EGA the palette registers
    // WERE the colours -- so a demo that never touches port 0x3C9 is not
    // running without a palette, it is setting one we were not listening for.
    if (ah === 0x10 && al === 0x00) {       // set one palette register
      const bx = r.get('bx');
      this.vga.attr[bx & 0x1F] = (bx >> 8) & 0x3F;
      return true;
    }
    if (ah === 0x10 && al === 0x02) {       // set all 16 + overscan, from ES:DX
      const src = ((r.get('es') << 4) + r.get('dx')) & 0xFFFFF;
      for (let i = 0; i < 17; i++) this.vga.attr[i] = this.mem[(src + i) & 0xFFFFF] & 0x3F;
      return true;
    }
    if (ah === 0x10 && al === 0x07) {       // read one palette register
      r.set('bx', (r.get('bx') & 0xFF) | ((this.vga.attr[r.get('bx') & 0x1F]) << 8));
      return true;
    }
    if (ah === 0x10 && al === 0x10) {       // set one DAC register
      const at = (r.get('bx') & 0xFF) * 3, cx = r.get('cx'), dx = r.get('dx');
      this.palette[at] = (dx >> 8) & 0x3F;
      this.palette[at + 1] = (cx >> 8) & 0x3F;
      this.palette[at + 2] = cx & 0x3F;
      return true;
    }
    if (ah === 0x10 && al === 0x12) {       // set block of DAC registers
      const first = r.get('bx') & 0xFFFF, count = r.get('cx') & 0xFFFF;
      const src = ((r.get('es') << 4) + r.get('dx')) & 0xFFFFF;
      for (let i = 0; i < count * 3; i++) this.palette[(first * 3 + i) % 768] = this.mem[(src + i) & 0xFFFFF] & 0x3F;
      return true;
    }
    if (ah === 0x10 && (al === 0x15 || al === 0x17)) {   // read DAC back
      // A fade-out reads the palette, scales it and writes it back. Reading
      // zeros meant the fade started from black and the picture vanished on
      // the first step.
      if (al === 0x15) {
        const at = (r.get('bx') & 0xFF) * 3;
        r.set('dx', (this.palette[at] & 0x3F) << 8);
        r.set('cx', ((this.palette[at + 1] & 0x3F) << 8) | (this.palette[at + 2] & 0x3F));
        return true;
      }
      const first = r.get('bx') & 0xFFFF, count = r.get('cx') & 0xFFFF;
      const dst = ((r.get('es') << 4) + r.get('dx')) & 0xFFFFF;
      for (let i = 0; i < count * 3; i++) {
        this.mem[(dst + i) & 0xFFFFF] = this.palette[(first * 3 + i) % 768] & 0x3F;
      }
      return true;
    }
    if (ah === 0x11) {                              // character generator
      if (al === 0x30) {
        // BH picks which table. 0/1 are the two INT-vector fonts and 3/4 the
        // 8x8 ROM halves; 2 and 5 are 8x14; 6 and 7 are 8x16.
        const bh = (r.get('bx') >> 8) & 0xFF;
        const [seg, height] = ROM_FONTS[bh === 6 || bh === 7 ? 0 : (bh === 2 || bh === 5 ? 1 : 2)];
        r.set('es', seg);
        r.set('bp', 0);
        r.set('cx', height);                        // bytes per character
        r.set('dx', (r.get('dx') & 0xFF00) | (this.con.rows - 1));
        return true;
      }
      return true;                                  // load/select a font: fine
    }
    if (ah === 0x10 && al === 0x03) return true;    // blink/intensity bit
    if (ah === 0x01) return true;                   // cursor shape
    if (ah === 0x05) return true;                   // active display page
    // The BIOS text calls. These used to all be accepted and dropped, which is
    // why a program that wrote its screen through the BIOS instead of DOS came
    // out just as blank as one that wrote nothing.
    if (ah === 0x0E) {                        // teletype output
      this.conPutc(al);
      return true;
    }
    if (ah === 0x02) {                        // set cursor position
      const dx = r.get('dx');
      this.con.y = Math.min(this.con.rows - 1, (dx >> 8) & 0xFF);
      this.con.x = Math.min(this.con.cols - 1, dx & 0xFF);
      return true;
    }
    if (ah === 0x09 || ah === 0x0A) {          // write char (+ attribute) at cursor
      const c = this.con, n = Math.max(1, r.get('cx') & 0xFFFF);
      const attr = ah === 0x09 ? (r.get('bx') & 0xFF) : c.attr;
      for (let i = 0; i < n; i++) {
        c.put(c.y * c.cols + Math.min(c.cols - 1, c.x + i), al, attr);
      }
      c.written += n;
      return true;
    }
    if (ah === 0x06 || ah === 0x07) {          // scroll window up / down
      const c = this.con, cx = r.get('cx'), dx = r.get('dx');
      const top = (cx >> 8) & 0xFF, left = cx & 0xFF;
      const bot = Math.min(c.rows - 1, (dx >> 8) & 0xFF);
      const right = Math.min(c.cols - 1, dx & 0xFF);
      const attr = (r.get('bx') >> 8) & 0xFF;
      const lines = al === 0 ? (bot - top + 1) : al;       // AL=0 means clear
      for (let i = 0; i < lines; i++) {
        // Scrolling up copies from below, so it must walk downwards; scrolling
        // down copies from above and must walk upwards. Getting this backwards
        // smears one row over the whole window instead of moving it.
        for (let k = top; k <= bot; k++) {
          const y = ah === 0x06 ? k : bot - (k - top);
          const src = ah === 0x06 ? y + 1 : y - 1;
          for (let x = left; x <= right; x++) {
            const d = y * c.cols + x, s = src * c.cols + x;
            if (src < top || src > bot) c.put(d, 0x20, attr);
            else c.put(d, c.getCh(s), c.getAt(s));
          }
        }
      }
      c.written++;
      return true;
    }
    if (ah === 0x0B) return true;
    if (ah === 0x08) { r.set('ax', 0x0720); return true; }   // read char+attr: a blank
    if (ah === 0x03) { r.set('cx', 0x0607); r.set('dx', 0); return true; }  // cursor at 0,0
    // "You need a VGA card to run this." Seven programs in this corpus print
    // some version of that line and quit, and none of them is wrong about what
    // it was told: both of the calls a 1994 demo uses to find a VGA were being
    // answered with AX=0, which is precisely the "function not supported" reply
    // an 8086-era CGA BIOS gives. The detection was working; the machine was
    // claiming not to be a VGA.
    //
    // AH=1Ah, get display combination code. AL comes back as 1Ah to say the
    // call exists at all -- that is the presence test -- and BL names the
    // active display: 08h is "VGA with an analogue colour monitor".
    if (ah === 0x1A) {
      if (al === 0x00) {
        r.set('ax', 0x1A00 | 0x1A);
        r.set('bx', (r.get('bx') & 0xFF00) | 0x08);
        return true;
      }
      r.set('ax', (r.get('ax') & 0xFF00) | 0x1A);   // AL=1Ah: set is accepted too
      return true;
    }
    // AH=12h, alternate select. BL=10h is the EGA/VGA information call, and the
    // presence test is that BL comes back CHANGED: an adapter that does not
    // implement the call leaves 10h sitting there. BH=0 is colour mode, BL=3 is
    // 256KB of display memory, CH is the feature-connector bits and CL the
    // configuration switches.
    if (ah === 0x12) {
      const bl = r.get('bx') & 0xFF;
      if (bl === 0x10) { r.set('bx', 0x0003); r.set('cx', 0x0009); return true; }
      // 30h-34h are the VGA-only scan-line/palette/cursor/display selects; AL=12h
      // is the "supported" answer to every one of them.
      r.set('ax', (r.get('ax') & 0xFF00) | 0x12);
      return true;
    }
    return false;
  }

  int16(ah, r) {
    if (ah === 0x00 || ah === 0x10) {
      const k = this.keys.shift()
        // A blocking read with an empty queue is where a "press any key" title
        // screen parks forever. autoKey answers it from AUTO_KEYS so a headless
        // run gets past the prompt; a demo that treats any key as "quit" will
        // quit, which is itself the answer to whether it can be benchmarked.
        || (this.autoKeyNext());
      if (!k) { this.blockedOnKey = true; r.set('ax', 0); return true; }
      r.set('ax', ((k.ah & 0xFF) << 8) | (k.al & 0xFF));
      return true;
    }
    if (ah === 0x01 || ah === 0x11) {
      const k = this.keys[0];
      // ZF set means "no key waiting". The caller reads it out of the flags the
      // IRET restores, so this has to land in the SAVED flags, not the live
      // ones -- runDos handles that via r.setResultZf.
      r.setResultZf(!k);
      if (k) r.set('ax', ((k.ah & 0xFF) << 8) | (k.al & 0xFF));
      return true;
    }
    if (ah === 0x02) { r.set('ax', (r.get('ax') & 0xFF00)); return true; }  // no shift keys
    return false;
  }

  int21(ah, al, r) {
    switch (ah) {
      case 0x4C: this.exited = true; this.exitCode = al; return true;
      case 0x00: this.exited = true; this.exitCode = 0; return true;
      case 0x30: r.set('ax', 0x0006); r.set('bx', 0); r.set('cx', 0); return true;  // "DOS 6.0"
      case 0x25: {                              // set interrupt vector
        const v = al * 4;
        const off = r.get('dx'), seg = r.get('ds');
        this.mem[v] = off & 0xFF; this.mem[v + 1] = off >> 8;
        this.mem[v + 2] = seg & 0xFF; this.mem[v + 3] = seg >> 8;
        return true;
      }
      case 0x35: {                              // get interrupt vector
        const v = al * 4;
        r.set('bx', this.mem[v] | (this.mem[v + 1] << 8));
        r.set('es', this.mem[v + 2] | (this.mem[v + 3] << 8));
        return true;
      }
      case 0x09: {                              // print $-terminated string
        let p = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF, s = '';
        while (this.mem[p] !== 0x24 && s.length < 4096) s += String.fromCharCode(this.mem[p++]);
        this.log(`dos print: ${s}`);
        this.conPuts(s);
        return true;
      }
      case 0x02:
        this.log(`dos putc: ${String.fromCharCode(r.get('dx') & 0xFF)}`);
        this.conPutc(r.get('dx') & 0xFF);
        return true;
      // Console input, the DOS-side twins of INT 16h AH=00. AH=06 with DL!=0xFF
      // is output, not input; only 0xFF asks for a character and it must report
      // "nothing waiting" through ZF rather than blocking.
      case 0x01: case 0x07: case 0x08: {
        const k = this.keys.shift() || (this.autoKeyNext());
        if (!k) this.blockedOnKey = true;
        r.set('ax', (r.get('ax') & 0xFF00) | (k ? k.al & 0xFF : 0));
        return true;
      }
      case 0x06: {
        const dl = r.get('dx') & 0xFF;
        if (dl !== 0xFF) {
          this.log(`dos putc: ${String.fromCharCode(dl)}`);
          this.conPutc(dl);
          return true;
        }
        const k = this.keys.shift() || (this.autoKeyNext());
        r.setResultZf(!k);
        r.set('ax', (r.get('ax') & 0xFF00) | (k ? k.al & 0xFF : 0));
        return true;
      }
      case 0x0A: {                              // buffered input, DS:DX
        const at = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF;
        const max = this.mem[at];
        const line = this.typedLine(max);
        if (line === null) { this.blockedOnKey = true; return true; }
        const body = line.replace(/\r\n$/, '');
        this.mem[at + 1] = body.length;
        for (let i = 0; i < body.length; i++) this.mem[at + 2 + i] = body.charCodeAt(i);
        this.mem[at + 2 + body.length] = 0x0D;   // the CR stays in the buffer
        this.conPuts(`${body}\r\n`);
        return true;
      }
      case 0x0B: {                              // check standard input status
        r.set('ax', (r.get('ax') & 0xFF00) | (this.keys.length ? 0xFF : 0x00));
        return true;
      }
      case 0x0C: {                              // flush buffer, then one of the above
        this.keys.length = 0;
        return al === 0x01 || al === 0x06 || al === 0x07 || al === 0x08 || al === 0x0A
          ? this.int21(al, 0xFF, r) : true;
      }
      case 0x40: {
        // Write to a handle. 1 and 2 are stdout and stderr and go to the
        // console; anything else has no file behind it, so report the bytes as
        // written rather than failing a program over a log it opened.
        const h = r.get('bx') & 0xFFFF, n = r.get('cx') & 0xFFFF;
        const src = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF;
        if (h === 1 || h === 2) {
          for (let i = 0; i < n; i++) this.conPutc(this.mem[(src + i) & 0xFFFFF]);
        }
        r.set('ax', n);
        r.setResultCf(false);
        return true;
      }
      // Get the PSP segment. BLIQ.EXE resizes its block, asks for its PSP and
      // prints "[ERROR]: Can not init file manager..." on the garbage it got
      // back -- a two-line call standing between it and the demo.
      case 0x51: case 0x62: r.set('bx', PSP_SEG); r.setResultCf(false); return true;
      case 0x19: r.set('ax', (r.get('ax') & 0xFF00) | 2); return true;   // drive C:
      case 0x0E: r.set('ax', (r.get('ax') & 0xFF00) | 3); return true;   // 3 drives
      case 0x47: {                              // get current directory -> root
        const at = ((r.get('ds') << 4) + (r.get('si') & 0xFFFF)) & 0xFFFFF;
        this.mem[at] = 0;
        r.setResultCf(false);
        return true;
      }

      // --- files ------------------------------------------------------------
      // A demo keeps its music, its fonts and most of its pictures next to the
      // executable, so with no file calls at all it starts, finds nothing and
      // either prints "File Not Found" or renders an empty screen from an empty
      // buffer. MAINPART.EXE is the second kind: it allocates EMS, maps four
      // pages and reads its data into them, and every one of those reads was
      // going nowhere.
      case 0x3D: {                              // open
        const f = this.openFile(this.guestPath(r), 'r');
        if (!f) { r.setResultCf(true); r.set('ax', 2); return true; }   // not found
        r.set('ax', f);
        r.setResultCf(false);
        return true;
      }
      case 0x3E: {                              // close
        this.files.delete(r.get('bx') & 0xFFFF);
        r.setResultCf(false);
        return true;
      }
      case 0x3F: {                              // read
        const f = this.files.get(r.get('bx') & 0xFFFF);
        const n = r.get('cx') & 0xFFFF;
        // Handle 0 is the keyboard, and a whole line of it. This is how Turbo
        // Pascal's readln reads -- not INT 16h -- so cchop.exe asked "Enter mix
        // speed:", got a failed read on a handle it had never opened, and
        // exited with runtime error 006 before drawing anything. A read that
        // returns no bytes is an empty line, and an empty line is not a number.
        if ((r.get('bx') & 0xFFFF) === 0) {
          const line = this.typedLine(n);
          if (line === null) { this.blockedOnKey = true; r.set('ax', 0); return true; }
          const at0 = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF;
          for (let i = 0; i < line.length; i++) this.mem[at0 + i] = line.charCodeAt(i);
          this.conPuts(line.replace(/\r\n$/, '\r\n'));
          r.set('ax', line.length);
          r.setResultCf(false);
          return true;
        }
        if (!f) { r.setResultCf(true); r.set('ax', 6); return true; }   // bad handle
        const at = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF;
        const got = Math.max(0, Math.min(n, f.buf.length - f.pos));
        // A read that would run off the end of the 1MB address space is a bug
        // in the guest, not something to wrap around silently.
        const room = Math.max(0, Math.min(got, this.mem.length - at));
        this.mem.set(f.buf.subarray(f.pos, f.pos + room), at);
        f.pos += got;
        r.set('ax', got);
        r.setResultCf(false);
        return true;
      }
      case 0x42: {                              // lseek
        const f = this.files.get(r.get('bx') & 0xFFFF);
        if (!f) { r.setResultCf(true); r.set('ax', 6); return true; }
        const off = (((r.get('cx') & 0xFFFF) << 16) | (r.get('dx') & 0xFFFF)) | 0;
        const from = al === 1 ? f.pos : (al === 2 ? f.buf.length : 0);
        f.pos = Math.max(0, Math.min(f.buf.length, from + off));
        r.set('ax', f.pos & 0xFFFF);
        r.set('dx', (f.pos >>> 16) & 0xFFFF);
        r.setResultCf(false);
        return true;
      }
      case 0x43: {                              // get/set file attributes
        const p = this.hostPath(this.guestPath(r));
        if (!p) { r.setResultCf(true); r.set('ax', 2); return true; }
        r.set('cx', 0x20);                      // archive
        r.setResultCf(false);
        return true;
      }
      case 0x44: {
        // IOCTL. Only AL=00, "get device information", is asked often enough to
        // matter: a demo uses it to find out whether stdout is a file or the
        // console. DX bit 7 set means character device.
        if (al === 0x00) { r.set('dx', 0x80D3); r.setResultCf(false); return true; }
        r.setResultCf(true); r.set('ax', 1);    // "invalid function"
        return true;
      }
      case 0x48: {                              // allocate paragraphs
        const want = r.get('bx') & 0xFFFF;
        const have = DEFAULT_ALLOC_TOP - this.allocTop;
        // BX comes back as the largest block available, which is how a program
        // asks how much memory there is: BX=FFFF is guaranteed to fail and the
        // answer is in the error return. That is the call ASMINST.EXE reads,
        // and with the old 0x9000 ceiling it was being told 64K.
        if (want > have) { r.setResultCf(true); r.set('ax', 8); r.set('bx', have); return true; }
        r.set('ax', this.allocTop);
        this.allocTop += want;
        r.setResultCf(false);
        return true;
      }
      case 0x49: r.setResultCf(false); return true;   // free
      case 0x4A: {                              // resize a block
        // A .EXE is loaded owning everything up to the ceiling, so the free
        // pool is empty until it gives some back -- which is what a C or Pascal
        // runtime does first thing. Honouring the shrink is what makes the
        // answer above mean anything.
        const seg = r.get('es') & 0xFFFF, want = r.get('bx') & 0xFFFF;
        if (seg === PSP_SEG) {
          if (PSP_SEG + want > DEFAULT_ALLOC_TOP) {
            r.setResultCf(true); r.set('ax', 8); r.set('bx', DEFAULT_ALLOC_TOP - PSP_SEG);
            return true;
          }
          this.allocTop = PSP_SEG + want;
        }
        r.setResultCf(false);
        return true;
      }
      case 0x1A: this.dta = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF; return true;
      case 0x2C: {                              // get time
        const t = this.ticks * 55;
        r.set('cx', (Math.floor(t / 3600000) << 8) | (Math.floor(t / 60000) % 60));
        r.set('dx', ((Math.floor(t / 1000) % 60) << 8) | (Math.floor(t / 10) % 100));
        return true;
      }
      default: return false;
    }
  }

  // --- XMS (HIMEM.SYS) -----------------------------------------------------
  // The multiplex interrupt is how the driver is found. AX=4300 asks "are you
  // there" and the answer is AL=80h; AX=4310 hands back the far pointer the
  // program will CALL for everything after that.
  int2f(ah, al, r) {
    if (ah === 0x43) {
      if (al === 0x00) { r.set('ax', (r.get('ax') & 0xFF00) | 0x80); return true; }
      if (al === 0x10) {
        r.set('es', XMS_ENTRY_SEG);
        r.set('bx', 0);
        return true;
      }
      return false;
    }
    // "Am I running under Windows?" -- no, and saying so stops a demo looking
    // for a DPMI host it will not find.
    if (ah === 0x16 && al === 0x00) { r.set('ax', r.get('ax') & 0xFF00); return true; }
    return false;
  }

  // Extended memory blocks live in host buffers, not in the guest's 1MB: a
  // real-mode program cannot address them anyway, and everything it can do
  // with one goes through the move call below. That is also why Lock (AH=0Ch)
  // fails rather than inventing a 32-bit address -- a program that wanted one
  // would then write through it into memory that does not exist.
  xms(ah, r) {
    const ok = (dx) => { r.set('ax', 1); if (dx !== undefined) r.set('dx', dx); };
    const fail = (bl) => { r.set('ax', 0); r.set('bx', (r.get('bx') & 0xFF00) | bl); };
    const free = () => XMS_TOTAL_KB - [...this.xmsBlocks.values()].reduce((a, b) => a + b.kb, 0);
    switch (ah) {
      case 0x00: r.set('ax', 0x0300); r.set('bx', 0); r.set('dx', 1); return true;
      case 0x01: case 0x02: ok(); return true;                    // request/release HMA
      case 0x03: case 0x04: case 0x05: case 0x06: ok(); return true;   // A20
      case 0x07: ok(); return true;                               // A20 is enabled
      case 0x08:                                                  // query free
        r.set('ax', free()); r.set('dx', free()); r.set('bx', r.get('bx') & 0xFF00);
        return true;
      case 0x09: {                                                // allocate EMB
        const kb = r.get('dx') & 0xFFFF;
        if (kb > free()) { fail(0xA0); return true; }             // out of memory
        const h = this.xmsNext++;
        this.xmsBlocks.set(h, { kb, buf: new Uint8Array(kb * 1024) });
        ok(h);
        return true;
      }
      case 0x0A: {                                                // free EMB
        const h = r.get('dx') & 0xFFFF;
        if (!this.xmsBlocks.has(h)) { fail(0xA2); return true; }
        this.xmsBlocks.delete(h);
        ok();
        return true;
      }
      case 0x0B: return this.xmsMove(r);
      case 0x0C: fail(0xAD); return true;                         // lock -- see above
      case 0x0D: fail(0xAA); return true;                         // unlock: not locked
      case 0x0E: {                                                // get handle info
        const b = this.xmsBlocks.get(r.get('dx') & 0xFFFF);
        if (!b) { fail(0xA2); return true; }
        r.set('ax', 1); r.set('bx', 0xFF00 | this.xmsBlocks.size); r.set('dx', b.kb);
        return true;
      }
      default: fail(0x80); return true;                           // not implemented
    }
  }

  // AH=0Bh: DS:SI points at {dword length, word srcHandle, dword srcOffset,
  // word dstHandle, dword dstOffset}. Handle 0 means conventional memory and
  // the matching offset is a far pointer rather than a block offset -- which is
  // the whole reason this call exists.
  xmsMove(r) {
    const p = ((r.get('ds') << 4) + (r.get('si') & 0xFFFF)) & 0xFFFFF;
    const m = this.mem;
    const u16 = (o) => m[p + o] | (m[p + o + 1] << 8);
    const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
    const len = u32(0);
    const side = (ho, oo) => {
      const h = u16(ho);
      if (h === 0) {
        const far = u32(oo);
        return { buf: m, at: ((((far >>> 16) & 0xFFFF) << 4) + (far & 0xFFFF)) & 0xFFFFF };
      }
      const b = this.xmsBlocks.get(h);
      return b ? { buf: b.buf, at: u32(oo) } : null;
    };
    const src = side(4, 6), dst = side(10, 12);
    // An odd length is an error on a real driver, and so is a handle nobody
    // allocated. Both are worth reporting rather than papering over: a program
    // that gets a success it did not earn goes wrong further away.
    if (!src || !dst || (len & 1)) {
      r.set('ax', 0);
      r.set('bx', (r.get('bx') & 0xFF00) | (len & 1 ? 0xA7 : 0xA3));
      return true;
    }
    if (src.at + len <= src.buf.length && dst.at + len <= dst.buf.length) {
      dst.buf.set(src.buf.subarray(src.at, src.at + len), dst.at);
      this.xmsMoved += len;
    }
    r.set('ax', 1);
    return true;
  }

  // --- EMS (EMM386) --------------------------------------------------------
  // Expanded memory is a 64K window at E000 through which four 16K pages of a
  // much larger store are visible. Mapping a page copies it into the window and
  // copies whatever was there back out first, which is exactly what the
  // hardware does with an address line and costs a memcpy here.
  ems(ah, al, r) {
    const st = (code) => r.set('ax', (code << 8) | (r.get('ax') & 0xFF));
    const free = () => EMS_TOTAL_PAGES - [...this.emsHandles.values()]
      .reduce((a, b) => a + b.pages, 0);
    switch (ah) {
      case 0x40: st(0); return true;                              // manager status
      case 0x41: r.set('bx', EMS_FRAME_SEG); st(0); return true;  // page frame
      case 0x42:                                                  // page counts
        r.set('bx', free()); r.set('dx', EMS_TOTAL_PAGES); st(0); return true;
      case 0x43: {                                                // allocate
        const pages = r.get('bx') & 0xFFFF;
        if (pages > free()) { st(0x88); return true; }            // not enough pages
        const h = this.emsNext++;
        this.emsHandles.set(h, { pages, buf: new Uint8Array(pages * EMS_PAGE) });
        r.set('dx', h); st(0);
        return true;
      }
      case 0x44: return this.emsMap(al, r.get('bx') & 0xFFFF, r.get('dx') & 0xFFFF, r);
      case 0x45: {                                                // deallocate
        const h = r.get('dx') & 0xFFFF;
        if (!this.emsHandles.has(h)) { st(0x83); return true; }    // no such handle
        for (let i = 0; i < 4; i++) if (this.emsMapped[i]?.h === h) this.emsFlush(i);
        this.emsHandles.delete(h);
        st(0);
        return true;
      }
      case 0x46: r.set('ax', 0x40); return true;                  // EMS 4.0
      case 0x47: case 0x48: st(0); return true;                   // save/restore map
      case 0x4B: r.set('bx', this.emsHandles.size); st(0); return true;
      case 0x4C: {
        const b = this.emsHandles.get(r.get('dx') & 0xFFFF);
        if (!b) { st(0x83); return true; }
        r.set('bx', b.pages); st(0);
        return true;
      }
      case 0x51: {                                                // reallocate
        const h = r.get('dx') & 0xFFFF, want = r.get('bx') & 0xFFFF;
        const b = this.emsHandles.get(h);
        if (!b) { st(0x83); return true; }
        const buf = new Uint8Array(want * EMS_PAGE);
        buf.set(b.buf.subarray(0, Math.min(b.buf.length, buf.length)));
        this.emsHandles.set(h, { pages: want, buf });
        r.set('bx', want); st(0);
        return true;
      }
      default: st(0x84); return true;                             // unknown function
    }
  }

  // Copy physical page `phys` out of the frame and back into whichever logical
  // page is currently sitting there, so a remap does not lose writes.
  emsFlush(phys) {
    const cur = this.emsMapped[phys];
    if (!cur) return;
    const b = this.emsHandles.get(cur.h);
    if (!b) return;
    const at = (EMS_FRAME_SEG << 4) + phys * EMS_PAGE;
    b.buf.set(this.mem.subarray(at, at + EMS_PAGE), cur.page * EMS_PAGE);
  }

  emsMap(phys, logical, handle, r) {
    const st = (code) => r.set('ax', (code << 8) | (r.get('ax') & 0xFF));
    const b = this.emsHandles.get(handle);
    if (!b) { st(0x83); return true; }
    if (phys > 3) { st(0x8B); return true; }                      // no such phys page
    this.emsFlush(phys);
    const at = (EMS_FRAME_SEG << 4) + phys * EMS_PAGE;
    if (logical === 0xFFFF) {                                     // unmap
      this.emsMapped[phys] = null;
      this.mem.fill(0, at, at + EMS_PAGE);
      st(0);
      return true;
    }
    if (logical >= b.pages) { st(0x8A); return true; }            // logical out of range
    this.mem.set(b.buf.subarray(logical * EMS_PAGE, (logical + 1) * EMS_PAGE), at);
    this.emsMapped[phys] = { h: handle, page: logical };
    this.emsMaps++;
    st(0);
    return true;
  }

  // Microsoft mouse driver. mars is driven entirely by this.
  int33(r) {
    const fn = r.get('ax') & 0xFFFF;
    switch (fn) {
      case 0x00: r.set('ax', 0xFFFF); r.set('bx', 2); return true;   // present, 2 buttons
      case 0x01: case 0x02: return true;                             // show/hide cursor
      case 0x03:
        r.set('bx', this.mouse.buttons);
        r.set('cx', this.mouse.x); r.set('dx', this.mouse.y);
        return true;
      case 0x04: this.mouse.x = r.get('cx'); this.mouse.y = r.get('dx'); return true;
      case 0x0B:
        // Read motion counters. These are DELTAS and are cleared by the read,
        // which is what makes a "move the mouse to fly" demo work at all.
        r.set('cx', this.mouse.dx & 0xFFFF); r.set('dx', this.mouse.dy & 0xFFFF);
        this.mouse.dx = 0; this.mouse.dy = 0;
        return true;
      case 0x07: case 0x08: case 0x0F: case 0x10: return true;       // ranges, mickeys
      default: return false;
    }
  }
}

module.exports = {
  Machine, loadExe, vgaGeometry,
  VGA_BASE, STUB_SEG, STUB_BYTE, LOAD_SEG, PSP_SEG,
};

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/toyvm/dos.js <file.exe>   # MZ header summary'); process.exit(2); }
  const mem = new Uint8Array(1 << 20);
  const info = loadExe(mem, fs.readFileSync(file));
  console.log(info);
}
