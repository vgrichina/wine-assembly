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
const { Sound, PIT_HZ } = require('./audio');
const { Gus } = require('./gus');

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

// What DOS prints before aborting a program that took a CPU fault with the
// vector still pointing at its own default handler. The wording is the real
// one, so a run that ends this way reads like the machine it is emulating.
// The names DOS prints for the CPU faults it owns a default handler for. Used
// to report where one happened, not to act on it -- see the fault case in
// serviceCall for why acting on it made things worse.
const FAULT_NAMES = {
  0x00: 'Divide overflow',
  0x04: 'Overflow',            // INTO with OF set
  0x06: 'Invalid opcode',
  0x0D: 'General protection fault',
};
// Names that open as a character device rather than a file. See openFile.
const DEVICES = new Set([EMS_NAME, 'NUL', 'CON', 'AUX', 'PRN', 'CLOCK$']);
// How many operand bytes each DSP command takes after itself. See sbCommand.
const SB_ARGS = {
  0x10: 1, 0x14: 2, 0x15: 2, 0x16: 2, 0x17: 2, 0x24: 2, 0x40: 1, 0x41: 2,
  0x42: 2, 0x48: 2, 0x74: 2, 0x75: 2, 0x76: 2, 0x77: 2, 0x80: 2, 0xE0: 1,
  0xE4: 1,
};
const SB_IRQ_VEC = 0x0F;      // IRQ 7, which is what BLASTER= announces

// An ISA card decodes ten address lines, so port 0xF389 reaches the same
// chip as 0x389. CONTAGIO and COUNTDWN run their AdLib test through `in
// al,dx` with a DX whose high byte was never cleared, and on a real machine
// that works; here the unknown port read 0xFF and both decided there was
// no FM chip. Only the sound card's ports alias -- nothing else in this
// machine is on the ISA bus in a way a program has relied on.
function isaAlias(port) {
  if (port <= 0x3FF) return port;
  const a = port & 0x3FF;
  if ((a >= 0x220 && a <= 0x22F) || a === 0x388 || a === 0x389 || a === 0x330 || a === 0x331) return a;
  return port;
}
// A transfer of at most this many samples is a probe, not audio: even at the
// slowest rate a real card retires it in well under a millisecond. See sbRun.
const SB_SHORT_BLOCK = 64;
const EMPTY = new Uint8Array(0);
const EMS_FRAME_SEG = 0xE000; // 64K page frame: four 16K physical pages
const EMS_PAGE = 0x4000;
const EMS_TOTAL_PAGES = 512;  // 8MB of expanded memory, the usual EMM386 answer
const XMS_ENTRY_SEG = 0x00C0; // three bytes below the PSP: int 2Dh; retf
const XMS_INT = 0x2D;
const XMS_TOTAL_KB = 8192;
// VBE's window-positioning far call, in the same free paragraph as the XMS
// entry point and clear of its three bytes. See installIvt.
const VESA_WIN_SEG = XMS_ENTRY_SEG;
const VESA_WIN_OFF = 0x0010;
const PSP_SEG = 0x0100;
// The nine words DOS's INT 21h prologue pushes onto the caller's stack, in the
// order it pushes them, plus the flags its IRET hands back. See pspSaveStack.
const PSP_SAVED_REGS = ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'ds', 'es', 'flags'];
const LOAD_SEG = 0x0110;      // PSP is 0x100 bytes = 0x10 paragraphs
// The environment block, in the gap between the BIOS data area and the PSP.
// 0x0060..0x00C0 is 1.5K, which is more than any of these programs reads.
const ENV_SEG = 0x0060;
// How many paragraphs the environment block's own MCB claims. One less than
// the 0x60 the gap is wide, because the paragraph at 0x00BF is the header of
// the block that follows it -- see installArena.
const ENV_PARAS = 0x5F;
// The owner word a block belonging to DOS itself carries. Real DOS writes 8
// for its own resident data and for device drivers, and 0 for a free block;
// a program walking the chain to add up free memory tells the two apart by
// exactly this word. Everything between the environment and the PSP is that:
// on a real machine it is the kernel, its buffers and whatever drivers
// CONFIG.SYS loaded, and none of it is available.
const MCB_SYSTEM = 0x0008;
// DOS's "list of lists", which INT 21h AH=52h hands back in ES:BX. The one
// field of it anything here wants is the word two bytes BELOW it: the segment
// of the first MCB in the chain. Parked in the dead space between the BIOS
// data area (which ends at 0x0500) and the environment block.
// The offset is not free to pick: the field a caller wants is BELOW the
// pointer, so an offset of 0 makes `mov ax, es:[bx-2]` wrap to the top of the
// segment and read something else entirely. Real DOS 4+ hands back offset
// 0x26 for the same reason; this keeps that.
const LOL_SEG = 0x0058;
const LOL_OFF = 0x0026;
// The first arena header. Its data is the environment block.
const MCB_FIRST = ENV_SEG - 1;
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
  const minAlloc = u16(0x0A), maxAlloc = u16(0x0C);
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
  // How much of memory this program owns. The header's max-alloc field is the
  // paragraphs it wants ON TOP of its image, and DOS hands over that much and
  // no more -- the usual 0xFFFF means "everything", but a loader stub that
  // intends to allocate its own working set asks for a few kilobytes so the
  // rest stays free. ANGEL.EXE is 1.5KB of exactly that, and taking the whole
  // 636KB for it left its own 546KB request nothing to come from: "Not enough
  // memory ! You'll need 538 Kb low memory free !".
  const imageParas = (imageBytes + 15) >> 4;
  const own = loadSeg + imageParas;
  const allocTop = Math.max(Math.min(own + maxAlloc, DEFAULT_ALLOC_TOP), own + minAlloc);

  const psp = pspSeg << 4;
  mem[psp] = 0xCD; mem[psp + 1] = 0x20;
  mem[psp + 2] = allocTop & 0xFF;
  mem[psp + 3] = (allocTop >> 8) & 0xFF;
  mem[psp + 0x80] = 0;              // empty command tail
  mem[psp + 0x81] = 0x0D;

  return {
    cs: (cs + loadSeg) & 0xFFFF, ip,
    ss: (ss + loadSeg) & 0xFFFF, sp,
    ds: pspSeg, es: pspSeg,
    loadSeg, pspSeg, imageBytes, allocTop,
    // The least memory this program owns: its image plus the paragraphs its
    // header says it needs on top -- BSS and stack, which are not in the file.
    // EXEC puts a child here, and getting it wrong by using the image size
    // alone dropped CATWALK's player straight onto its parent's stack.
    minTop: own + minAlloc,
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
    minTop: pspSeg + 0x1000,             // a .COM owns its whole segment
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
const GC_READ_MAP = 4, GC_MODE = 5, GC_MISC = 6, GC_BIT_MASK = 8;
const CRTC_HDE = 0x01;
const CRTC_MAX_SCAN = 0x09, CRTC_START_HI = 0x0C, CRTC_START_LO = 0x0D;
const CRTC_VDE = 0x12, CRTC_OVERFLOW = 0x07, CRTC_OFFSET = 0x13;
// Vertical Retrace End. Bit 5 is "disable vertical interrupt" -- active low, so
// a program that clears it is asking the CRTC to interrupt it once per frame on
// IRQ2. Bit 7 write-protects CRTC 0-7, which is why the value is usually 0x90
// rather than 0x10 and cannot be tested for equality.
const CRTC_VRETRACE_END = 0x11;

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

// The 256-entry DAC a real VGA BIOS loads when it sets mode 13h. We had none:
// `palette` was 768 zero bytes that only ever got written by a program setting
// its own colours, so a demo that draws in the default palette -- which is most
// of the ones that only want a handful of colours -- filled the screen with
// non-zero indices that every one of them mapped to black. That is
// indistinguishable from a demo that rendered nothing, and it is why BLINKY.EXE
// read as "reaches mode 13h and draws nothing" for a whole session.
//
// The layout is IBM's: 0-15 the CGA sixteen, 16-31 a greyscale ramp, then 216
// colours as three brightness blocks x three saturations x a 24-step hue wheel,
// and 248-255 left black.
function vgaDacTable() {
  const t = new Uint8Array(768);
  const cga = [
    [0, 0, 0], [0, 0, 0x2A], [0, 0x2A, 0], [0, 0x2A, 0x2A],
    [0x2A, 0, 0], [0x2A, 0, 0x2A], [0x2A, 0x15, 0], [0x2A, 0x2A, 0x2A],
    [0x15, 0x15, 0x15], [0x15, 0x15, 0x3F], [0x15, 0x3F, 0x15], [0x15, 0x3F, 0x3F],
    [0x3F, 0x15, 0x15], [0x3F, 0x15, 0x3F], [0x3F, 0x3F, 0x15], [0x3F, 0x3F, 0x3F],
  ];
  cga.forEach((c, i) => t.set(c, i * 3));
  const grey = [0x00, 0x05, 0x08, 0x0B, 0x0E, 0x11, 0x14, 0x18,
                0x1C, 0x20, 0x24, 0x28, 0x2D, 0x32, 0x38, 0x3F];
  grey.forEach((g, i) => t.set([g, g, g], (16 + i) * 3));

  // A 24-step wheel: six segments of four, each ramping one channel through
  // 0x00, 0x10, 0x1F, 0x2F while the others sit at 0x00 or 0x3F.
  const ramp = [0x00, 0x10, 0x1F, 0x2F], F = 0x3F;
  const hues = [];
  for (let k = 0; k < 4; k++) hues.push([F, 0, ramp[k]]);
  const fall = [F, 0x2F, 0x1F, 0x10];
  for (let k = 0; k < 4; k++) hues.push([fall[k], 0, F]);
  for (let k = 0; k < 4; k++) hues.push([0, ramp[k], F]);
  for (let k = 0; k < 4; k++) hues.push([0, F, fall[k]]);
  for (let k = 0; k < 4; k++) hues.push([ramp[k], F, 0]);
  for (let k = 0; k < 4; k++) hues.push([F, fall[k], 0]);

  let at = 32 * 3;
  for (const hi of [0x3F, 0x1C, 0x10]) {            // bright, medium, dark
    for (const satLo of [0, 0x1F, 0x2D]) {          // full, half, low saturation
      const lo = Math.round(satLo * hi / 0x3F);
      for (const h of hues) {
        for (const c of h) t[at++] = lo + Math.round(c * (hi - lo) / 0x3F);
      }
    }
  }
  return t;
}
const VGA_DAC = vgaDacTable();

function newVgaState() {
  const v = {
    // Sixteen sequencer registers, not eight. A plain VGA has eight and the
    // rest alias, but every SVGA of this era puts its own registers above
    // them -- Trident's bank register is index 0x0E -- and masking the index
    // to three bits does not "ignore" those writes, it lands them on a real
    // register: 0x0E masked is 0x06, the memory-mode register.
    seqIndex: 0, seq: new Uint8Array(16),
    gcIndex: 0, gc: new Uint8Array(16),
    crtcIndex: 0, crtc: new Uint8Array(32),
    // Whether the program has ASKED for the vertical-retrace interrupt. Kept as
    // its own flag rather than read back out of crtc[0x11], because the register
    // file resets to zeros and bit 5 is active low -- so reading it would report
    // every freshly reset card as having retrace interrupts switched on, and we
    // would fire IRQ2 at a program that never requested it.
    vretrace: false,
    // Attribute controller: one index/data port sharing a flip-flop that a read
    // of the status register resets. Its low 16 registers are the palette a
    // 4-bit pixel is looked up in.
    attrIndex: 0, attrFlip: 0, attr: new Uint8Array(32),
    misc: 0x63,
    planar: false,
    bpp: 0,
    // A CGA graphics mode (4, 5, 6). The VGA registers do not describe one --
    // there is no graphics controller on a CGA and nothing in seq/gc/crtc says
    // "two bits per pixel at B800" -- so this is carried beside them and the
    // register-derived mode below leaves it alone.
    cga: 0,
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
  // Miscellaneous, bit 0: this is a graphics mode. The BIOS writes it as part
  // of setting any graphics mode, and it is what tells the registers alone --
  // with no INT 10h to ask -- that A000 is a picture. See vgaModeFromRegs.
  v.gc[GC_MISC] = (ega || mode === 0x13) ? 0x01 : 0x00;
  v.attr.fill(0);
  v.attr.set(EGA_ATTR);
  v.attrFlip = 0;
  v.crtc.fill(0);
  // A mode set is the BIOS reprogramming the CRTC from its own tables, and
  // those leave the vertical interrupt disabled. A program that wants it asks
  // again afterwards, so this must not survive the mode set that precedes it.
  v.vretrace = false;
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
  // CGA graphics. Modes 4 and 5 are 320x200 with two bits per pixel; mode 6 is
  // 640x200 with one. The buffer is at B800 and the scan lines INTERLEAVE --
  // even rows from offset 0, odd rows from 0x2000 -- which is why a CGA screen
  // read linearly comes out as two half-height copies combed together.
  v.cga = (mode === 4 || mode === 5 || mode === 6) ? mode : 0;
  v.bpp = ega ? 4 : (mode === 0x13 ? 8 : (v.cga ? (mode === 6 ? 1 : 2) : 0));
  v.planar = !!ega;
}

// What the graphics-controller registers say the mode is, independently of
// whether anyone asked the BIOS for it.
//
// A large part of this corpus never calls INT 10h AH=00 at all: setting a mode
// is a dozen OUTs to the sequencer, the CRTC and the graphics controller, and a
// demo that has already written a mode-X tweak has no reason to ask the BIOS
// for mode 13h first. `bpp` was only ever written by resetVgaMode, so every one
// of those programs was still "in mode 3" while it drew, the capture path
// photographed the text page, and the sweep filed a working demo as blank.
//
// Bit 0 of the Miscellaneous register is the graphics/text bit; bit 6 of Mode
// is 256-colour. Between them they name every mode this machine can be in.
function vgaModeFromRegs(v) {
  const graphics = (v.gc[GC_MISC] & 0x01) !== 0;
  return !graphics ? 0 : ((v.gc[GC_MODE] & 0x40) ? 8 : 4);
}

// Adopt what the registers say, keeping the last graphics geometry the way a
// BIOS mode set does so a demo that restores text on its way out is still
// photographable.
function syncVgaMode(v, forceChained) {
  // Nothing in the VGA register file describes a CGA mode, so asking it what
  // mode we are in would answer "text" and take the picture away from a program
  // the BIOS just put into mode 4. Only another BIOS mode set leaves CGA.
  if (v.cga) return false;
  const bpp = vgaModeFromRegs(v);
  if (bpp === v.bpp) return false;
  if (v.bpp !== 0) v.lastGraphics = vgaGeometry(v);
  v.bpp = bpp;
  // A 4-bit mode is planar by construction; a 256-colour one is planar only
  // once chain-4 is cleared, which the sequencer write decides.
  if (bpp === 4) v.planar = true;
  else if (bpp === 8) v.planar = !forceChained && !(v.seq[SEQ_MEMORY_MODE] & 0x08);
  else v.planar = false;
  return true;
}

// Geometry, derived the way the CRTC actually derives it rather than assumed.
// 320x200 and 320x240 both fall out of this: mode 13h leaves 400 scan lines
// with every row doubled, and the classic 320x240 tweak sets 480 with the
// doubling left in place.
function vgaGeometry(v) {
  // CGA is not derived from these registers at all: the geometry is fixed by
  // the mode number, the buffer is at B800 rather than A000, and consecutive
  // scan lines are 0x2000 apart rather than one row apart.
  if (v.cga) {
    return {
      width: v.cga === 6 ? 640 : 320, height: 200,
      stride: 80, start: 0, planar: false, bpp: v.bpp, cga: v.cga,
      attr: Array.from(v.attr.subarray(0, 16)),
    };
  }
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

// The name a created file is remembered under. Same rules hostPath applies to
// a lookup -- base name, no drive, no directory, case-folded -- so a program
// that creates C:\TEMP\X.DAT and opens x.dat finds it.
// A filename the way DOS matches it: case-folded, 0xFF/NBSP blanks dropped,
// no trailing dot. See hostPath.
function dosNameKey(name) {
  return String(name).toLowerCase().replace(/[ÿ ]/g, '').replace(/\.+$/, '');
}

function fileKey(name) {
  const base = String(name || '').replace(/^[A-Za-z]:/, '').split(/[\\/]/).filter(Boolean).pop();
  return base ? base.toLowerCase() : null;
}

// A DOS filespec as the 11-character NAME.EXT template FindFirst keeps in the
// DTA: each field padded with spaces, `*` filling the rest of its field with
// `?`, upper case. "elysium.mod" -> "ELYSIUM MOD", "*.mod" -> "????????MOD".
// Null for a name no DOS directory could hold.
function dosPattern(spec) {
  const [name = '', ext = ''] = String(spec).toUpperCase().split('.', 2);
  const field = (s, n) => {
    let out = '';
    for (const c of s) {
      if (c === '*') { out = out.padEnd(n, '?'); break; }
      if (out.length < n) out += c;
    }
    return out.padEnd(n, ' ');
  };
  if (!name && !ext) return null;
  return field(name, 8) + field(ext, 3);
}

// Whether a directory entry fits the template: `?` takes any character,
// padding included, which is how "FILE????.TXT" finds FILE.TXT on DOS too.
function dosMatch(pattern, entry) {
  const t = dosPattern(entry);
  if (!t) return false;
  for (let i = 0; i < 11; i++) {
    if (pattern[i] !== '?' && pattern[i] !== t[i]) return false;
  }
  return true;
}

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
  /\b(no|without|none|neither|not?)\s*(sound|music|sfx|audio|card|soundcard)?\b|^\s*(none|silence|silent|quit|exit|no)\b|pc[- ]?speaker|internal speaker|beeper|no thanks|just kidding|don'?t\s+(even\s+)?(own|have)|no\s*gus/i;

// The option that names the card this machine has, and the ones that name a
// better card it does not.
const SB_LABEL = /sound\s*blaster|\bblaster\b|\bsb\b/i;
const SB_NOT_LABEL = /\bpro\b|\b16\b|awe|\bgus\b|ultra|compatible/i;
// The FM chip, when a menu offers nothing that plays samples.
const ADLIB_LABEL = /ad\s*-?\s*lib|\bopl[23]?\b|\bfm\b/i;

// An option that leaves rather than chooses. It has to be told apart from
// SILENT_LABEL, which matches "Quit back to DOS" on its first word alone.
const QUIT_LABEL = /\b(quit|exit|abort|back\s+to\s+dos)\b/i;

// An option that starts the thing, for an arrow-key grid whose command column
// is separate from its settings. DINO.EXE heads that column "and I AM READY TO"
// and offers "Rock'n'roll" against "Quit back to DOS".
const GO_LABEL =
  /\b(rock|play|start|run|go|begin|continue|proceed|ok|accept|done|ready|launch|demo)\b/i;

// How many cells an attribute may cover and still be a cursor rather than a
// colour the page is written in. One highlighted label, generously.
const CURSOR_CELLS = 40;

// A screen that has told us the marker moves under the arrow keys. This is the
// whole licence for counting rows off a `>`.
const ARROW_HINT = (s) => /\b(arrow|cursor)\s+keys?\b/i.test(s) && /\benter\b/i.test(s);

// The VBE modes we offer, as [mode number, width, height, bits per pixel], all
// banked. The four 8bpp numbers are the VESA-assigned ones every 1990s demo
// asks for by name; 0x112 is here because the corpus census (see
// docs/toyvm-vbe.md) found CHROME.EXE asking 4F01 about it and taking its own
// no-VESA path when the answer was "not supported".
//
// EVERY MODE IN THIS LIST MUST RENDER. A 4F01 that says "supported" for a depth
// the frame reader cannot read is a silent-success stub: the program sets it,
// draws into the bank window, and every picture downstream -- PNG, frame hash,
// the live page -- reads the bytes at the wrong width or not at all, which
// looks exactly like a demo that draws nothing. A mode that is not in this list
// is refused, which is a truthful answer a program can act on.
const VESA_MODES = [
  [0x100, 640, 400, 8],
  [0x101, 640, 480, 8],
  [0x103, 800, 600, 8],
  [0x105, 1024, 768, 8],
  [0x10D, 320, 200, 15],
  [0x112, 640, 480, 24],
];

// Bytes per pixel for a VBE depth. 15bpp is a 16-bit pixel with the top bit
// unused, which is why this is not bpp/8.
function vbeBytes(bpp) {
  if (bpp === 24) return 3;
  if (bpp === 32) return 4;
  if (bpp === 15 || bpp === 16) return 2;
  return 1;
}

// The BIOS video modes that are text. Only on one of these does a polled key
// check get answered out of the menu reader.
const TEXT_MODES = new Set([0, 1, 2, 3, 7]);

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

// Named keys the rotation cannot reach. Every one of these is a key a program
// in this corpus waits for and no printable character substitutes for: ESC is
// the quit key of half the text-mode viewers here, and the cursor keys drive
// the ones with a menu.
const NAMED_KEYS = {
  esc: { ah: 0x01, al: 0x1B }, enter: { ah: 0x1C, al: 0x0D },
  space: { ah: 0x39, al: 0x20 }, tab: { ah: 0x0F, al: 0x09 },
  bksp: { ah: 0x0E, al: 0x08 },
  up: { ah: 0x48, al: 0 }, down: { ah: 0x50, al: 0 },
  left: { ah: 0x4B, al: 0 }, right: { ah: 0x4D, al: 0 },
  f1: { ah: 0x3B, al: 0 }, f2: { ah: 0x3C, al: 0 }, f3: { ah: 0x3D, al: 0 },
  f4: { ah: 0x3E, al: 0 }, f5: { ah: 0x3F, al: 0 }, f6: { ah: 0x40, al: 0 },
  f7: { ah: 0x41, al: 0 }, f8: { ah: 0x42, al: 0 }, f9: { ah: 0x43, al: 0 },
  f10: { ah: 0x44, al: 0 },
};

// A comma-separated key list: each item is either a name from NAMED_KEYS or a
// run of literal characters. `--keys=n,esc` is n then ESC; `--keys=abc` is
// three keystrokes. Anything unrecognised is taken literally rather than
// dropped, so a typo shows up as the wrong key and not as silence.
function parseKeys(spec) {
  const out = [];
  for (const item of String(spec || '').split(',')) {
    if (!item) continue;
    const named = NAMED_KEYS[item.toLowerCase()];
    if (named) { out.push({ ...named }); continue; }
    for (const ch of item) {
      out.push({ ah: SCAN[ch.toLowerCase()] || 0, al: ch.charCodeAt(0) & 0xFF });
    }
  }
  return out;
}

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
    // Every video mode this machine was ever put in, in the order it was asked
    // for. `videoMode` alone is the mode at the moment the question is asked,
    // and a run that photographs a text screen cannot be read off it: a demo
    // sitting on its sound-card menu and a .NFO viewer are both mode 3 there.
    // The history separates them -- a program that has already been in mode 13h
    // is one whose text screen is furniture, whatever mode it is in now. Power
    // -on is mode 3 and that is a fact about the BIOS, not about the program,
    // so it is in here as the first entry and readers ignore the head.
    this.videoModes = [3];
    // Power-on is mode 3, and the BIOS has already loaded the text-mode DAC by
    // the time a program gets the CPU: the EGA's 64 colours in entries 0-63 and
    // black above them. Leaving all 768 bytes zero is only invisible while
    // nothing reads the DAC back -- and reading it back is exactly what a demo
    // that wants to fade the DOS prompt out does. ATTIC.EXE opens with
    // `out 3C7,0` and 768 `in 3C9` in mode 3h, scales what it read towards
    // black over 64 passes and writes each pass back; against 256 blacks every
    // one of those 49920 writes is a zero, so the fade it renders is a screen
    // that was already black. See loadTextDac.
    this.palette = new Uint8Array(768);
    this.loadTextDac();
    this.dacWriteIndex = 0;
    // Every DAC entry the guest has written, by port or by BIOS. The progress
    // detector needs it: a palette loop drives the screen without touching a
    // single register it watches, so a program clearing 255 DAC entries in a
    // tight loop -- the same block, the same registers, memory the detector
    // does not hash -- reads as wedged. BLIQ.EXE was stopped at 168b:263 for
    // exactly that, one loop short of the mode-X fade it draws next.
    this.dacWrites = 0;
    this.dacSubIndex = 0;
    this.retraceToggle = 0;
    this.vga = newVgaState();
    // The VESA mode in effect, or mode 0 for none. `bank` is which 64KB of the
    // picture the window at A000 is currently showing; see vesaBank.
    this.vesa = { mode: 0, width: 0, height: 0, bpp: 0, bank: 0, start: 0 };
    // Which SVGA card this machine has, if any. 'none' is a plain VGA and is
    // the default: presenting a chipset means presenting its registers, and a
    // program that finds one will drive them. See svgaSetBank.
    this.svga = opts.svga || 'none';
    this.svgaBank = 0;
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
    // --trace-io. Null unless the flag is on, and the check is one property
    // read on a path every port access takes.
    this.ioTrace = opts.ioTrace || null;
    this.ioPorts = opts.ioPorts || null;
    // --stop-on-text. See conWatch.
    this.stopText = opts.stopText || null;
    this.conTail = '';
    this.stopHit = false;
    this.keys = opts.keys ? [...opts.keys] : [];   // queued as {ah, al}
    this.autoKey = !!opts.autoKey;
    // The rotation, which a caller can replace wholesale. The default list is
    // tuned for sound menus; a program waiting on one specific key needs its
    // own, and there is no character in the default list that means ESC.
    this.autoKeys = opts.autoKeys && opts.autoKeys.length ? opts.autoKeys : AUTO_KEYS;
    this.autoKeyAt = 0;
    this.autoKeyScreen = null;   // the screen the last menu answer was read off
    this.autoKeyAnswered = null; // its text lines: what the next menu did not draw
    this.autoKeyQueue = [];      // the rest of a multi-character typed answer
    this.autoKeyRead = 0;        // keys chosen by reading, not by rotating
    // Which of the two readers built the string in autoKeyScreen. They use
    // different formats on purpose -- autoKeyPoll appends the highlight
    // position and autoKeyNext does not -- so a page that is byte-identical
    // still produces a different string depending on who asks. The epoch gates
    // below may only skip a reader when the LAST look was that same reader's.
    this.autoKeyScreenKind = null;
    this.autoKeyPollEpoch = -1;
    this.autoKeyNextEpoch = -1;
    // See textPageEpoch. Built in setMemory, because that is where `mem` -- and
    // therefore the console page -- comes from.
    this.conWords = null;
    this.conSnapWords = null;
    this.conEpoch = 0;
    // screenHighlight's attribute histogram, reused across calls and left zero
    // by every path out of it.
    this.hlCounts = null;
    // The keyboard as hardware: scancodes waiting to be delivered as IRQ1, and
    // the one port 60h reads right now. See keyboardIrq.
    this.kbQueue = [];
    // --keys go on BOTH wires, for the reason pushKey gives: which one a
    // program listens on is not knowable from here. They used to go only into
    // the INT 16h queue above, and kbFill -- the only bridge to the hardware
    // one -- is gated on autoKey, so a program that reads port 60h itself was
    // unreachable by --keys entirely. DINO.EXE polls the port and compares
    // against 0x48 and 0x50 to drive a cursor around its setup grid; every
    // arrow key aimed at it was being dropped, and the grid sat on "Gravis
    // Ultrasound" no matter what was sent.
    this.kbScan = 0;
    for (const k of this.keys) {
      const sc = (k.ah & 0x7F) || 0x1C;
      this.kbQueue.push(sc, sc | 0x80);   // make code, then break code
    }
    this.kbFresh = false;   // set by IRQ1, cleared by the handler's port read
    this.kbReads = 0;
    this.forceChained = !!opts.forceChained;
    // Extra `NAME=VALUE` lines for the environment block, ahead of the defaults
    // installEnvironment writes. This exists so a question like "what does
    // AMANAMAN.EXE do once ULTRASND= is set" can be answered by measurement
    // rather than by editing the default block and re-sweeping the corpus --
    // which is how the BLASTER= decision documented in installEnvironment was
    // reached, the hard way.
    this.extraEnv = Array.isArray(opts.env) ? opts.env.filter(Boolean) : [];
    // 'full' | 'quiet' | 'none' -- see the sound option in run-dos.js.
    this.sound = opts.sound || 'full';
    // `pressed`/`released` are the per-button transition counts INT 33h AX=05h
    // and 06h hand out and clear; they are separate from `buttons`, which is
    // the level right now.
    this.mouse = { x: 160, y: 100, buttons: 0, dx: 0, dy: 0, pressed: [0, 0, 0], released: [0, 0, 0] };
    // A freshly loaded .EXE owns every paragraph up to the ceiling, so the
    // free pool starts empty and fills when the program shrinks its own block.
    this.allocTop = DEFAULT_ALLOC_TOP;
    // The first paragraph past the running program's image -- where EXEC puts a
    // child, and where a program that shrinks its block leaves free memory.
    this.imageTop = DEFAULT_ALLOC_TOP;
    // What AH=48h handed out, and what AH=49h gave back below the frontier.
    this.memBlocks = new Map();     // seg -> paragraphs
    // Who owns each block is NOT kept here. Real DOS keeps it in the MCB, one
    // paragraph below the block, and reads it back on terminate: AH=4Ch frees
    // every block owned by the PSP that is exiting, which is the only reason a
    // loader can run subfiles in a row without the machine filling up. It has
    // to stay there and not in a map on this side, because programs write to
    // it -- see memAlloc.
    this.memFree = [];              // [{seg, size}], sorted and coalesced
    // XMS blocks and EMS handles, both backed by host buffers. Counters so a
    // run can say whether a manager was merely detected or actually used.
    // Open files, and a record of what was asked for -- "which file could it
    // not find" is the first question when a demo renders an empty screen.
    this.fileRoot = opts.fileRoot || null;
    this.files = new Map(); this.fileNext = 5;   // 0-4 are the standard handles
    this.filesOpened = []; this.filesMissed = []; this.filesCreated = [];
    this.bytesRead = 0;
    // Files the guest created, by base name. Writes never reach the host disk.
    //
    // A caller may hand in a map from an earlier run, which is what carries a
    // configuration file across the two programs of a --pre pair: the corpus
    // directory stays read-only, and the second program still finds what the
    // first one wrote. See the --pre option in run-dos.js.
    this.tempFiles = opts.tempFiles instanceof Map ? opts.tempFiles : new Map();
    // EXEC: the parent contexts to return to, and the code the last child
    // exited with. `transfer` is how a service hands control somewhere else.
    this.execStack = []; this.lastExitCode = 0; this.transfer = null;
    // How the last child ended, in AH=4Dh's terms: 0 normal, 1 Ctrl-C, 2
    // critical error, 3 terminate-and-stay-resident. See AH=4Dh.
    this.lastExitType = 0;
    // Where DOS puts the program. On a real machine this is not a constant: it
    // is whatever is left after the kernel, its buffers and every driver
    // CONFIG.SYS loaded, so the same .EXE lands at a different paragraph on
    // two machines and a program is entitled to no opinion about which. Here
    // it is a machine option for the same reason -- see the ACME-VIC section
    // of docs/dos-corpus-blockers.md, where a demo stores a byte through a DS
    // it forgot to reload and the store lands on its own code at the default
    // load address and on DOS's data on any real one.
    //
    // Raising it costs free conventional memory, which is why this is
    // per-program and not a new default: ACME-BIG.EXE wants 600K and refuses
    // to start below it.
    this.pspSeg = (opts.pspSeg | 0) || PSP_SEG;
    this.loadSeg = (opts.loadSeg | 0) || (this.pspSeg + 0x10);
    this.curPsp = this.pspSeg;         // whose PSP AH=51h/62h reports
    // Per-PSP: the caller's registers as of its last INT 21h call, the half of
    // PSP+2Eh that does not fit in a DWORD. See pspSaveStack.
    this.pspRegs = new Map();
    this.xmsBlocks = new Map(); this.xmsNext = 1; this.xmsMoved = 0;
    // Whether the guest's addresses still wrap at 1MB. They do until it takes
    // an extended-memory handle; see openBus.
    this.linFlat = false;
    this.vmExports = null;
    this.sliceCut = -1;         // see endSlice
    this.emsHandles = new Map(); this.emsNext = 1; this.emsMaps = 0;
    this.emsMapped = [null, null, null, null];
    this.unhandled = new Map();
    // "Divide overflow at 5ab:1ff" -> count. CPU faults the guest took with the
    // vector still pointing at us. Reported, not acted on.
    this.faults = new Map();
    this.unhandledFn = new Map();      // "vec:ah" -> count, the real work list
    this.intCount = new Map();
    // Every VBE call the guest made, aggregated so a program bank-switching
    // ten thousand times costs one entry: "al[:mode][:lfb]" -> {n, ok}. This
    // is what vbe-census.js reads to answer "which modes does the corpus ask
    // for", and it has to be a count rather than a log for that reason.
    this.vbeCalls = new Map();
    // Which clock, if any, a program is pacing itself off. A demo that never
    // touches any of these cannot be waiting for time and is compute-bound by
    // construction; one that hammers retrace is frame-paced. Does NOT see a
    // program polling the BIOS tick word in memory directly -- that one is
    // only visible by changing tickScale and watching the frame move. The
    // interrupt-driven clocks (INT 1Ah, 15h, 16h) are already in `intCount`.
    this.clock = { retrace: 0, pit: 0 };
    // The Sound Blaster, as far as a detection routine can tell. See portIn.
    this.sb = {
      out: [], cmd: 0, args: [], expect: 0, speaker: 0, block: 0,
      pending: false, autoInit: false, paused: false, forced: false, shortWait: false,
      // The width a forced IRQ answers for -- F2h/F3h, or a short block that
      // was waiting on its DMA channel -- which picks the mixer 0x82 bit and
      // so the port the ISR acknowledges on. See sbIrq.
      forcedBits: 8,
      detects: 0, commands: 0, irqs: 0,
      // The two numbers that say how long a block takes: samples in it, and
      // samples per second. See sbBlockSeconds.
      rate: 8000, len: 0,
      // The transfer as audio.js consumes it: samples left in the block, the
      // DMA channel and sample format, whether the block-done interrupt is
      // owed, and the level the stream is currently at. See Sound.sbNext.
      left: 0, chan: 1, bits: 8, signed: false, stereo: false, irqDue: false,
      lastL: 0, lastR: 0,
      // The block in flight was started by a high-speed command (90h/91h) on a
      // DSP that has no high-speed mode to leave. See sbRun.
      hsAuto: false,
      // The SB16 mixer's register file (index at 0x224, data at 0x225) and
      // the interrupt-status bits register 0x82 reports: bit 0 an 8-bit
      // block's IRQ, bit 1 a 16-bit one, each held until its ack port
      // (0x22E / 0x22F) is read.
      mixer: new Uint8Array(256), mixerIndex: 0, irqLatched: 0,
    };
    // The samples behind the card, and the speaker. Renders only when a host
    // attaches a sink (the page, --audio=); see audio.js.
    this.audio = new Sound(this);
    // The Gravis Ultrasound (gus.js), at the base ULTRASND= names when the
    // caller set one (shot-sweep.js does for the programs that ask for it)
    // and at the factory 0x220 otherwise, which is where DOPE, CYBOMAN2 and
    // CMA_SHRT look with no variable set. It shares 0x220 with the Sound
    // Blaster the way the ports allow: the DSP owns its read and write
    // ports, the GF1 its status, latch and register ports, and the AdLib
    // timer pair at 0x2X8/0x2X9 reaches both chips.
    const ultra = this.extraEnv.map(String).find((e) => /^ULTRASND=/i.test(e));
    const gusBase = ultra ? parseInt(ultra.split('=')[1], 16) : 0x220;
    // `gus: false` parks the card at a base no port can reach, which is how
    // a program that plays through either card is rendered on the SB alone.
    this.gus = new Gus({
      base: opts.gus === false ? -0x10000 : (gusBase >= 0x210 && gusBase <= 0x260 ? gusBase : 0x220),
      machine: this,
    });
    this.port61 = 0;
    // Where the slice being run started and how big it is, in dispatches, so
    // a port write can say WHEN it happened within the slice (audioNow).
    this.sliceStart = 0;
    this.sliceBudget = 0;
    // Which option the menu answerer picks on a sound menu: 'silent' is the
    // sweep's choice, 'sb' takes a plain Sound Blaster when one is offered.
    this.soundPref = opts.soundPref || 'silent';
    // What DSP command E1 answers, as [major, minor]. 4.05 is an SB16, which
    // is what the card behind these ports can do: 8- and 16-bit blocks on
    // both DMA controllers (sbRun), the 0x41/0x42 sample-rate commands, and
    // the mixer's IRQ/DMA registers (sbMixerRead). It answered 2.01 -- a
    // plain SB 2.0 -- until 2026-09-03, and CONTAGIO.EXE, which wants an
    // SB16, stopped right after reading it; the 199-program sweep with 4.05
    // gained that one and lost nothing. --dsp-version=2.1 is the A/B.
    this.dspVersion = opts.dspVersion || [4, 5];
    // The two 8259s, as far as a guest reading them back can tell: each mask
    // register (OCW1), the vector base each ICW2 set, and where in the
    // ICW1..ICW4 init sequence the next data-port write lands. Nothing here
    // gates delivery -- a masked IRQ is still raised -- but a program doing
    // IN/AND/OUT on the mask register got 0xFF back before and so could
    // never see its own writes: ACT1.EXE's IRQ hunt read the mask, cleared
    // one bit, wrote it and read 0xFF again. Boot values are what a BIOS
    // leaves: IRQ 0,1,2,6 open on the master, the cascade's 8 and 13 on the
    // slave.
    this.pic = { imr: [0xB8, 0x8F], base: [0x08, 0x70], icw: [0, 0], icw1: [0, 0] };
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
    this.setSystemBda();
    this.setVideoBda();
    this.setTicks(0, { force: true });
  }

  // The equipment word at 0040:0010 and the conventional-memory size in KB at
  // 0040:0013. Programs read both directly as often as they ask INT 11h/12h
  // for them, so the words are what both answers come from.
  //
  // 0x0023: 80x25 colour, one diskette, a coprocessor present, no serial ports.
  // Bit 1 is the coprocessor bit and it used to be clear, which was a lie: the
  // x87 here is real (tools/toyvm/fpu-check.js passes 48/48). CTSLASSE.EXE asks
  // INT 11h for it, printed "you need a coprocessor to run this intro" and
  // exited before drawing a pixel.
  //
  // This lives in its own method because reset() runs BEFORE setMemory() binds
  // the VM's memory, so everything it wrote landed in an array nothing reads
  // again. The BDA came out all zeros at 0040:0010, and INT 11h and INT 12h
  // had been answering 0 the whole time -- only setVideoBda survived, because
  // the guest's own INT 10h set-mode calls it again later.
  // 0040:0013 is how much conventional memory is INSTALLED, not how much DOS
  // has left to give -- that second question is what INT 21h AH=48h answers,
  // and the two are different numbers. Deriving it from DEFAULT_ALLOC_TOP
  // conflated them and reported 636KB, because the allocation ceiling sits a
  // few paragraphs below the video ROM on purpose. A machine with its 640K
  // fitted says 640 whatever is resident, and daretro.exe checks exactly that:
  // "You must have 640k low memory to run this program!!!"
  setSystemBda() {
    this.mem[0x410] = 0x23; this.mem[0x411] = 0x00;
    const kb = 0xA000 >> 6;                 // paragraphs below the video ROM, in KB
    this.mem[0x413] = kb & 0xFF; this.mem[0x414] = (kb >> 8) & 0xFF;
  }

  // The video half of the BIOS data area, which a demo reads instead of asking
  // INT 10h because it is three instructions and no interrupt.
  //
  // 0040:0063 is the one that mattered. It holds the CRTC's base I/O port, and
  // the canonical retrace wait is
  //
  //     mov dx, [0:463h] / add dx, 6 / in al, dx / test al, 8 / jnz $-3
  //
  // -- base plus six is 3DAh, the input status register, and bit 3 is vertical
  // retrace. With the word left at zero that reads port 6 instead, which is
  // not a port anything answers, so the test never clears and the wait never
  // ends. NM2.EXE, COCONTS1.EXE and SETUP.EXE each spun there for every
  // dispatch they were given -- 800M in SETUP's case, at 100% of wall inside
  // the guest, which reads exactly like a demo with a lot of work to do.
  // Remember a mode set. Repeats are dropped -- a demo that asks for mode 13h
  // once a frame would otherwise turn this into an unbounded log -- and so is
  // anything past the first 32 distinct modes, which no program in the corpus
  // comes near.
  noteVideoMode() {
    const h = this.videoModes;
    if (h[h.length - 1] === this.videoMode || h.length >= 32) return;
    h.push(this.videoMode);
  }

  setVideoBda() {
    const m = this.mem;
    const cols = CON_COLS, rows = CON_ROWS;
    m[0x44A] = cols & 0xFF; m[0x44B] = (cols >> 8) & 0xFF;
    const pageBytes = cols * rows * 2;
    m[0x44C] = pageBytes & 0xFF; m[0x44D] = (pageBytes >> 8) & 0xFF;
    m[0x44E] = 0; m[0x44F] = 0;              // page 0 starts at offset 0
    m[0x462] = 0;                            // active display page
    // 3D4h for a colour adapter, 3B4h for mono. Only mode 7 is mono here.
    const crtc = this.videoMode === 7 ? 0x3B4 : 0x3D4;
    m[0x463] = crtc & 0xFF; m[0x464] = (crtc >> 8) & 0xFF;
    m[0x484] = (rows - 1) & 0xFF;            // rows on screen, less one
    const cell = this.videoMode === 3 || this.videoMode === 7 ? 16 : 8;
    m[0x485] = cell; m[0x486] = 0;           // character cell height
  }

  // The real guest memory arrives after construction, once the wasm instance
  // exists. The text page lives inside it, so the console has to be re-pointed
  // and the page re-blanked rather than left addressing the throwaway buffer.
  // The environment block and the pointer to it at PSP:0x2C. A program that
  // wants to know where it was started from walks this: scan the variables for
  // the terminating double NUL, step over the count word 0x0001, and what
  // follows is its own full path. BLIQ, CONTAGIO, STHINTRO and CEN!FB all do
  // exactly that and all four print "[ERROR]: Can not init file manager..."
  // when the segment word is zero, because the scan runs off into memory that
  // never produces two NULs in a row.
  installEnvironment(name, tail = '') {
    const mem = this.mem;
    let at = ENV_SEG << 4;
    const put = (s) => { for (let i = 0; i < s.length; i++) mem[at++] = s.charCodeAt(i); mem[at++] = 0; };
    put('COMSPEC=C:\\COMMAND.COM');
    put('PATH=C:\\');
    put('TEMP=C:\\');
    for (const v of this.extraEnv) put(String(v));
    // No ULTRASND= either, and for the same reason as BLASTER below -- measured
    // rather than assumed, because the first two programs looked at said to set
    // it. AMANAMAN.EXE goes from "Hey ! Where's your ULTRASND environment ?"
    // and an immediate exit to a full 64000-pixel unchained screen with it, and
    // CATWALK.EXE gets as far as "Gravis UltraSound reported at address 240h
    // using IRQ 11". Then the corpus sweep priced the other side: AUTUMN.EXE
    // and CLASH.EXE both lose their pictures, because MikMod reads the variable
    // instead of probing, goes looking for a GF1 that is not there, and quits
    // with "MikMod error: Couldn't detect gus, please check env. string" at 1.1M
    // dispatches -- where without it AUTUMN runs 3G and fills its screen.
    // 184 -> 183. It is the BLASTER lesson exactly.
    //
    // So the announcement is per-program, not global: shot-sweep.js re-runs a
    // program whose refusal names the GUS with `--env=ULTRASND=...` and keeps
    // the better frame, the same way it decides the start key, the silent-mode
    // switch and whether a sound card helps at all.
    //
    // No BLASTER=, deliberately, even though there is a card on the ports.
    //
    // It reads like the obvious companion to answering the DSP probe -- half
    // the sound libraries of the era take the base, IRQ and DMA channel from
    // this line instead of hunting for them. That is exactly the problem. A
    // library that probes finds a DSP that answers questions and stops there;
    // a library that reads BLASTER skips the probe entirely and goes straight
    // to programming a DMA transfer on the channel it was promised, and there
    // is no DMA controller behind this. Measured: with the variable set,
    // CEN!FB.EXE and BTHERE.EXE hang on "Initializing ." forever, having drawn
    // 64000 and 28203 pixels without it; removing it puts both back and costs
    // ATTIC.EXE and DFUSE.EXE nothing, because both of them probe.
    //
    // The rule this encodes: answer questions the card can be asked, do not
    // volunteer a configuration nothing is standing behind.
    mem[at++] = 0;                    // end of the variables
    mem[at++] = 0x01; mem[at++] = 0x00;   // one string follows: the program path
    put(`C:\\${String(name).toUpperCase()}`);
    mem[at++] = 0;
    const psp = this.pspSeg << 4;
    mem[psp + 0x2C] = ENV_SEG & 0xFF;
    mem[psp + 0x2D] = (ENV_SEG >> 8) & 0xFF;
    // The command tail, at PSP:80h: a length byte, the text, then a CR. It is
    // a leading space in DOS because the separator between the name and the
    // arguments is part of the tail. AMBIENT.EXE prints "MIDAS Error: NO GUS
    // FOUND... USE 'AMBIENT /NO_SND' FOR SILENT MODE" and means it -- the
    // switch is the only way past that screen.
    const t = tail ? ` ${String(tail).trim()}` : '';
    mem[psp + 0x80] = t.length & 0xFF;
    for (let i = 0; i < t.length; i++) mem[psp + 0x81 + i] = t.charCodeAt(i) & 0xFF;
    mem[psp + 0x81 + t.length] = 0x0D;
  }

  // --- the file side of DOS ------------------------------------------------
  // Every program here runs from the directory its data is in, so the whole of
  // "the filesystem" is that one directory. Read-only on purpose: a sweep runs
  // 199 programs unattended and none of them has any business writing to the
  // corpus.
  guestPath(r) {
    const at = this.lin(r, 'ds', r.get('dx'));
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
    const hit = this.dirCache.find(f => f.toLowerCase() === base.toLowerCase())
      // Then as DOS would compare them. 0xFF is a blank in code page 437 and
      // a legal filename byte, which is how alpha.exe's music file got the
      // name "CRiSiS.ÿ": the extension was made to look like nothing. The
      // unpacker that put the corpus on disk dropped it, leaving "crisis.",
      // and DOS itself treats a trailing dot as no extension at all.
      || this.dirCache.find(f => dosNameKey(f) === dosNameKey(base));
    return hit ? `${this.fileRoot}/${hit}` : null;
  }

  // Where the DTA is: wherever AH=1Ah last put it, else the PSP's own at +80h,
  // which is where DOS starts every program's.
  dtaAddr() {
    return this.dta || ((this.curPsp << 4) + 0x80);
  }

  // Everything a directory search can find: the files beside the executable
  // and the ones this run created, by name and size. The browser's fs shim
  // has no statSync, so a size comes from reading the file when it must.
  dirEntries() {
    if (this.dirCache === undefined) {
      try { this.dirCache = this.fileRoot ? fs.readdirSync(this.fileRoot) : []; } catch { this.dirCache = []; }
    }
    const out = [];
    const seen = new Set();
    for (const [key, rec] of this.tempFiles) { out.push({ name: key.toUpperCase(), size: rec.len }); seen.add(key); }
    for (const f of this.dirCache) {
      if (seen.has(f.toLowerCase())) continue;
      let size = 0;
      try { size = fs.statSync(`${this.fileRoot}/${f}`).size; } catch {
        try { size = fs.readFileSync(`${this.fileRoot}/${f}`).length; } catch { continue; }
      }
      out.push({ name: f.toUpperCase(), size });
    }
    return out;
  }

  // One step of a FindFirst/FindNext search whose template and position are
  // in the DTA's reserved bytes: fills the entry, advances the position, and
  // fails with `errNoMore` (2 "file not found" from FindFirst, 18 "no more
  // files" from FindNext) when nothing further fits.
  findNext(r, errNoMore) {
    const dta = this.dtaAddr();
    let pattern = '';
    for (let i = 0; i < 11; i++) pattern += String.fromCharCode(this.mem[dta + 1 + i] || 0x20);
    const entries = this.dirEntries();
    let at = this.mem[dta + 0x0D] | (this.mem[dta + 0x0E] << 8);
    for (; at < entries.length; at++) {
      const e = entries[at];
      if (!dosMatch(pattern, e.name)) continue;
      this.mem[dta + 0x0D] = (at + 1) & 0xFF; this.mem[dta + 0x0E] = ((at + 1) >> 8) & 0xFF;
      this.mem[dta + 0x15] = 0x20;                    // archive: a plain file
      this.mem[dta + 0x16] = 0; this.mem[dta + 0x17] = 0;               // 00:00
      this.mem[dta + 0x18] = 0x21; this.mem[dta + 0x19] = 0x1E;         // 1995-01-01
      for (let i = 0; i < 4; i++) this.mem[dta + 0x1A + i] = (e.size >>> (8 * i)) & 0xFF;
      const name = e.name.slice(0, 12);
      for (let i = 0; i < 13; i++) this.mem[dta + 0x1E + i] = i < name.length ? name.charCodeAt(i) : 0;
      r.set('ax', 0);
      r.setResultCf(false);
      return true;
    }
    this.mem[dta + 0x0D] = at & 0xFF; this.mem[dta + 0x0E] = (at >> 8) & 0xFF;
    r.setResultCf(true); r.set('ax', errNoMore);
    return true;
  }

  openFile(name) {
    // Character devices are opened by name, not found on disk. EMMXXXX0 is the
    // one that matters here: the *other* way to detect expanded memory, older
    // than the INT 67h signature check and the one CYTOPYGE and BABYTRO use.
    // Opening it failed, so both concluded there was no EMS at all -- BABYTRO
    // printed "You Do Not Have Enough Free Memory to Run This Intro" and quit
    // 255 -- while INT 67h behind it was answering every call correctly. NUL
    // and the console are here because a program that opens one and gets a
    // "file not found" tends to treat it as a broken system rather than a
    // missing file.
    const dev = (name || '').replace(/^[A-Za-z]:/, '').split(/[\\/]/).filter(Boolean).pop();
    if (dev && DEVICES.has(dev.toUpperCase())) {
      const h = this.fileNext++;
      this.files.set(h, { buf: EMPTY, pos: 0, name: dev, device: true });
      this.filesOpened.push(dev);
      return h;
    }
    // A file the program itself created earlier in this run lives in memory and
    // is found before the host directory: a demo that writes a config or a
    // decompressed temp file and reads it straight back has to see its own
    // bytes, and nothing here ever touches the real disk for writes.
    const key = fileKey(name);
    if (key && this.tempFiles.has(key)) {
      const rec = this.tempFiles.get(key);
      const h = this.fileNext++;
      this.files.set(h, { buf: rec.data.subarray(0, rec.len), pos: 0, name, rec });
      this.filesOpened.push(name);
      return h;
    }
    const p = this.hostPath(name);
    if (!p) { this.filesMissed.push(name); return 0; }
    let buf;
    try { buf = fs.readFileSync(p); } catch { this.filesMissed.push(name); return 0; }
    const h = this.fileNext++;
    this.files.set(h, { buf, pos: 0, name });
    this.filesOpened.push(name);
    return h;
  }

  // The whole content of a file as a Buffer, wherever it lives -- a file the
  // guest created earlier in this run, or one next to the executable. EXEC
  // needs it: the program it is asked to run is usually one this run produced.
  readWholeFile(name) {
    const key = fileKey(name);
    if (key && this.tempFiles.has(key)) {
      const rec = this.tempFiles.get(key);
      return Buffer.from(rec.data.subarray(0, rec.len));
    }
    const p = this.hostPath(name);
    if (!p) { this.filesMissed.push(name); return null; }
    try { return fs.readFileSync(p); } catch { this.filesMissed.push(name); return null; }
  }

  // Create (or truncate) a file. It exists only in this process -- the corpus
  // directory is read-only as far as the emulator is concerned -- but it is a
  // real file to the guest: writeable, seekable, and re-openable by name.
  createFile(name) {
    const key = fileKey(name);
    if (!key) return 0;
    const rec = { data: new Uint8Array(4096), len: 0 };
    this.tempFiles.set(key, rec);
    const h = this.fileNext++;
    this.files.set(h, { buf: rec.data.subarray(0, 0), pos: 0, name, rec });
    this.filesCreated.push(name);
    return h;
  }

  // Write into a created file, growing it. `pos` is honoured, so a program that
  // seeks back to patch a header gets what it wrote there.
  writeFile(f, src, n) {
    // A write into a file that came off the host disk copies it into the
    // in-memory file system first, and every later read of that name sees the
    // copy. Without this the write was simply dropped: ANGEL.EXE's SETUP.EXE
    // opens the DRIVERS.VGA that shipped with the demo and patches the
    // ten-byte video-BIOS signature at its end in place, so the file ANGEL
    // then checked still carried the author's 1995 CRC and the demo refused to
    // start with "Please run setup.exe on your computer !". Nothing here ever
    // reaches the host disk -- the corpus directory stays read-only.
    if (!f.rec) {
      const rec = { data: Uint8Array.from(f.buf), len: f.buf.length };
      f.rec = rec;
      this.tempFiles.set(fileKey(f.name), rec);
      this.filesCreated.push(f.name);
    }
    const rec = f.rec;
    const end = f.pos + n;
    if (end > rec.data.length) {
      const grown = new Uint8Array(Math.max(end, rec.data.length * 2));
      grown.set(rec.data.subarray(0, rec.len));
      rec.data = grown;
    }
    for (let i = 0; i < n; i++) rec.data[f.pos + i] = this.mem[(src + i) & 0xFFFFF];
    f.pos = end;
    if (end > rec.len) rec.len = end;
    f.buf = rec.data.subarray(0, rec.len);
  }

  // A number that changes exactly when the text page does, and does not change
  // when it does not.
  //
  // Everything that reads the console -- the menu reader, the highlight finder,
  // the stuck detector's cell count -- reads guest memory at B8000 and nothing
  // else, so a byte-for-byte comparison against the last look is a complete and
  // EXACT answer to "is any of that going to come out different this time".
  // 1000 word comparisons, against 2000 cells through two accessors plus a
  // 25-line string build plus a trailing-space regex per line.
  //
  // The reason to want it is that those readers run per HANDBACK, and a program
  // that polls the BIOS keyboard from inside its frame loop hands back every
  // few instructions. ASMINST.EXE's title screen is `mov ah,1 / int 16h` at
  // 42f:1d2 with the animation behind it: 1,170,503 polls in a 20M-dispatch
  // run, 17 dispatches apiece, and the CPU profile put 28.8% of the whole run
  // in screenHighlight, 15.5% in the `\s+$` regex inside screenText and 13.1%
  // in screenText itself -- against 1.4% in wasm.
  //
  // A counter rather than a boolean because there are several readers with
  // different lifetimes; each remembers the epoch it last acted on. It is
  // deliberately NOT an answer to "did the STRING change" -- two different
  // pages can render the same text -- so it may only ever be used to SKIP work
  // whose result is already known, never to decide that something changed.
  textPageEpoch() {
    const w = this.conWords, s = this.conSnapWords;
    if (!w) return this.conEpoch;
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== s[i]) { s.set(w); return ++this.conEpoch; }
    }
    return this.conEpoch;
  }

  // What is on the text page, as lines. The autoKey menu reader works off this,
  // and so does any caller that wants to know what a program said.
  screenText() {
    const c = this.con, rows = [];
    for (let y = 0; y < c.rows; y++) {
      // Find the last printable cell first and build only up to it. The row is
      // trimmed of trailing whitespace either way; doing it with `\s+$` on a
      // freshly built 80-character string was 15.5% of ASMINST.EXE's run, and a
      // regex is the one part of this that a JIT cannot make cheap.
      let end = c.cols;
      while (end > 0) {
        const b = c.getCh(y * c.cols + end - 1);
        if (b > 0x20 && b < 0x7F) break;
        end--;
      }
      let s = '';
      for (let x = 0; x < end; x++) {
        const b = c.getCh(y * c.cols + x);
        s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : ' ';
      }
      rows.push(s);
    }
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows;
  }

  // Where the highlight is, as {row, from, to}, or null.
  //
  // A grid menu shows which cell has the cursor by painting it a different
  // colour, and colour is the only place that information exists -- screenText
  // throws the attribute away, so to a text reader every column of DINO.EXE's
  // setup looks equally selected. The rule here is deliberately narrow: the
  // page's commonest attribute is its ordinary text, a highlight is a run of
  // cells in some other attribute, and if the page has more than a few such
  // runs it is coloured art rather than a menu with a cursor on it.
  screenHighlight() {
    const c = this.con;
    // An attribute is a byte, so the histogram is 256 counters and not a Map --
    // this walks all 2000 cells and ran on every keyboard poll (28.8% of
    // ASMINST.EXE's whole run before textPageEpoch gated it). `order` keeps the
    // attributes in first-appearance order, which is the order a Map would have
    // iterated in: the two winner searches below break ties by taking the FIRST
    // one seen, so scanning 0..255 instead would quietly pick a different
    // attribute on a page where two are equally common.
    const count = this.hlCounts || (this.hlCounts = new Int32Array(256));
    const order = [];
    for (let i = 0; i < c.cells; i++) {
      const ch = c.getCh(i);
      if (ch === 0 || ch === 0x20) continue;
      const a = c.getAt(i);
      if (count[a] === 0) order.push(a);
      count[a]++;
    }
    // The RAREST attribute, not simply a non-default one. DINO's page has four:
    // 0x07 for its text, 0x4f for the title bar, 0x0f for the headings and the
    // sentence at the bottom, and 0x3f on exactly one label -- the one the
    // cursor is on. Anything the page uses widely is decoration.
    let plain = 0, most = -1, cursor = 0, least = Infinity;
    for (const a of order) if (count[a] > most) { most = count[a]; plain = a; }
    for (const a of order) {
      if (a !== plain && count[a] < least) { least = count[a]; cursor = a; }
    }
    const attrs = order.length;
    for (const a of order) count[a] = 0;   // the histogram is reused next call
    if (attrs < 2) return null;
    if (least > CURSOR_CELLS) return null;
    let row = -1, from = -1, to = -1;
    for (let i = 0; i < c.cells && row < 0; i++) {
      const ch = c.getCh(i);
      if (ch === 0 || ch === 0x20 || c.getAt(i) !== cursor) continue;
      row = (i / c.cols) | 0;
      from = i % c.cols;
    }
    if (row < 0) return null;
    // To the end of the highlighted label, gaps included: "Sound Blaster PRO"
    // is highlighted as a whole and the spaces in it carry the attribute of
    // whatever was on the page before, so a run that stops at the first space
    // reports a third of the label.
    for (let x = from; x < c.cols; x++) {
      if (c.getAt(row * c.cols + x) === cursor) to = x;
      else if (x - to > 1) break;
    }
    return { row, from, to };
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
    // Only text this menu drew counts as one of its options. CYCLE.EXE prints
    // its "Select a SoundDevice" list over the previous menu without clearing
    // the screen, so row 3 read "3. Soundblasteris Ultra Sound / (O)thers
    // ( Sb,LPT,... )": the plain Sound Blaster was rejected for the "Ultra"
    // left over from the line above it, and the "(O)" from the menu already
    // answered was pressed again. A character that is the same as it was
    // when the last menu was answered is scrollback, so it is blanked before
    // the options are read -- and when that leaves no options at all (the
    // program redrew the same menu after refusing a key) the whole screen is
    // read as before.
    const fresh = this.freshLines(lines);
    const opts = this.menuOptions(fresh);
    if (!opts.length && fresh !== lines) opts.push(...this.menuOptions(lines));
    // With a listener present, a plain Sound Blaster is the answer when one is
    // on the menu: that is the card behind the ports. Not a Pro or a 16 -- the
    // DSP answers 2.01 and a driver told to expect more refuses it -- and not
    // when the option only says "sound card", which is usually a submenu.
    if (this.soundPref === 'sb') {
      const sb = opts.find(o => SB_LABEL.test(o.label) && !SB_NOT_LABEL.test(o.label));
      if (sb) return key(sb.ch);
      const fm = opts.find(o => ADLIB_LABEL.test(o.label));
      if (fm) return key(fm.ch);
      // The card's own settings when the menu asks for them one at a time
      // (CYCLE.EXE: "Select Soundblaster port", then IRQ): port 220h, IRQ 7,
      // DMA 1 are what BLASTER= would say, and the first option offered is
      // 210h on IRQ 5, which nothing here answers.
      const asks = fresh.filter(l => /port|address|base|irq|interrupt|dma/i.test(l)).pop() || '';
      const setting = /port|address|base/i.test(asks) ? /\b220h?\b/i
        : /irq|interrupt/i.test(asks) ? /\b(irq\s*)?7\b/i
          : /dma/i.test(asks) ? /\b(dma\s*)?1\b/i : null;
      if (setting) {
        const own = opts.find(o => setting.test(o.label));
        if (own) return key(own.ch);
      }
      // A list of replay rates ("5. 20000 Hz (some 286)"): the one nearest
      // the mixer's own rate from below, since the first offered is the
      // 4000 Hz meant for "real slow computers".
      const rates = opts.map(o => ({ o, hz: (/(\d{4,5})\s*hz/i.exec(o.label) || [])[1] | 0 }))
        .filter(r => r.hz);
      if (rates.length >= 2 && rates.length === opts.length) {
        const want = this.audio.rate || 22050;
        const fit = rates.filter(r => r.hz <= want);
        const best = (fit.length ? fit : rates).reduce((a, b) =>
          (Math.abs(b.hz - want) < Math.abs(a.hz - want) ? b : a));
        return key(best.o.ch);
      }
    }
    const silent = opts.find(o => SILENT_LABEL.test(o.label));
    if (silent) return key(silent.ch);

    // A menu with no selector characters at all, driven by the arrow keys. It
    // says so itself -- DINO.EXE's setup grid ends with "Use ARROW keys to move
    // around, ENTER selects highlighted option." -- and that sentence is the
    // whole trigger, because counting rows off a marker is only safe on a
    // screen that has told us the marker moves.
    if (ARROW_HINT(all)) {
      const hl = this.screenHighlight();
      if (hl) {
        this.log(`autokey highlight at ${hl.row},${hl.from}: `
          + `"${(lines[hl.row] || '').slice(hl.from, hl.to + 1).trim()}"`);
        const k = this.gridStep(lines, hl);
        if (k) return [k];
      }
      const ks = this.arrowMenuKeys(lines);
      if (ks) return ks;
    }

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

  // The screen with the tail of every row that still reads as it did when the
  // last menu was answered blanked out, or the same array when nothing was
  // answered yet. Only the TAIL: an overwrite leaves the old line's end
  // showing past the new one, but a menu drawn over another menu shares its
  // "    1. " selectors column for column, and blanking every unchanged
  // character took the selectors off CYCLE.EXE's IRQ list and left "IRQ 5"
  // with nothing to press.
  //
  // The page scrolls as a program prints its next menu, so the old text is
  // some rows further up than it was: line the two screens up at the shift
  // that leaves the most rows identical before comparing.
  freshLines(lines) {
    const was = this.autoKeyAnswered;
    if (!was) return lines;
    let shift = 0, best = -1;
    for (let k = 0; k < was.length; k++) {
      let n = 0;
      for (let i = 0; i + k < was.length && i < lines.length; i++) {
        if (lines[i] && lines[i] === was[i + k]) n++;
      }
      if (n > best) { best = n; shift = k; }
    }
    return lines.map((line, row) => {
      const old = was[row + shift] || '';
      let x = Math.max(line.length, old.length);
      while (x > 0 && (line[x - 1] || ' ') === (old[x - 1] || ' ')) x--;
      return /\S/.test(line.slice(x)) ? line.slice(0, x) : line;
    });
  }

  // The single-character selectors on a screen and the label each one selects.
  menuOptions(lines) {
    const opts = [];
    for (const line of lines) {
      // A selector starts a line, follows a run of spaces, or follows a slash
      // or comma -- CYCLE.EXE lays its whole menu out on one line as
      // "(G)ravis / (O)thers / (N)one", and requiring two spaces missed every
      // option after the first.
      //
      // The line start absorbs its indent: do.exe writes its sound menu to
      // B800 as " [1] - None", one space in, which is neither the start of the
      // line nor a run of two spaces, so nothing on that menu was an option at
      // all and the reader fell through to the rotation.
      //
      // The separator after the selector is whatever the author felt like:
      // CYBOMAN2.EXE writes "        0> NoSound" and COLORS.EXE "0 - Silence",
      // and with only ]).: accepted neither menu had a single option on it, so
      // both fell through to the rotation and sat on the prompt forever. A bare
      // "-" cannot fire on running text, because the selector still has to be
      // one character preceded by a line start, two spaces, or a slash/comma.
      // A label may carry one parenthesised tail -- CYCLE.EXE's "(O)thers
      // ( Sb,LPT,... )" is the Sound Blaster option, and cut at the "(" it
      // read as "Others", which is nothing. The tail has to hold more than
      // one character, or "(G)ravis ... / (O)thers" hands the next option's
      // selector to the previous option's label. A label
      // stops at a slash for the same reason: greedy across "Sound / (O)"
      // it ate the separator the next option needed and that option vanished.
      const re = /(?:^\s*|\s{2,}|[/,]\s*)([[(]?)([0-9A-Za-z])[\]).:>-](\s*)([^[(/]{2,40}(?:\(\s*[^)]{2,40}\))?)/g;
      for (let m; (m = re.exec(line));) {
        // "(N)one" puts the selector INSIDE the word, so the label as captured
        // is "one" and reads as neither a yes nor a no. Put the letter back
        // when nothing separates it from the rest.
        const label = (m[1] === '(' && m[3] === '' ? m[2] + m[4] : m[4]).trim();
        opts.push({ ch: m[2], label });
      }
      // BRW.EXE's "Choose IRQ: 1=2, 2=3, 3=5, 4=7, 5=11, 6=15" and "Choose
      // I/O port: 1=210h, 2=220h etc..": selector, equals, value, comma. Two
      // pairs at least, so an equation in running text is not a menu.
      const pairs = [...line.matchAll(/(?:^|[\s,])([0-9A-Za-z])=([^,\s]+)/g)];
      if (pairs.length >= 2) for (const p of pairs) opts.push({ ch: p[1], label: p[2] });
    }
    return opts;
  }

  // The keystrokes that walk an arrow-key menu from its highlight marker down
  // to the silent option and press Enter, or null when the screen does not look
  // like one. Called only from menuKey, and only for a screen that says it is
  // driven by the arrow keys.
  //
  // The marker is a character sitting immediately in front of a label with no
  // space between them -- DINO.EXE writes ">Gravis Ultrasound" and moves the
  // `>` down the column. There can be several markers on one line, one per
  // column of a grid; the leftmost is the one whose column holds the device
  // names, which is the only column with anything to choose in it.
  // ONE key towards what this grid should be told, given where its cursor is.
  //
  // One, and not the whole walk, because the cursor is the feedback: it is in
  // the attribute plane, the poll gate watches it, and so every key is answered
  // only after the last one has been seen to land. A blind walk cannot do that,
  // and DINO.EXE is the demonstration -- committing its device column moves the
  // cursor and changes no character on the page, and a Right off a four-row
  // column into a two-row one goes nowhere at all. Both were measured as three
  // Rights that set the IRQ instead of starting the demo.
  gridStep(lines, hl) {
    // The columns of the grid: an x where text starts on two or more rows.
    const starts = new Map();
    for (let y = 0; y < lines.length; y++) {
      for (const m of (lines[y] || '').matchAll(/(?<= |^)\S(?:\S| (?! ))*/g)) {
        if (!starts.has(m.index)) starts.set(m.index, []);
        starts.get(m.index).push({ row: y, label: m[0].trim() });
      }
    }
    const cols = [...starts.entries()]
      .filter(([, rows]) => rows.length >= 2)
      .map(([col, rows]) => ({ col, rows }))
      .sort((a, b) => a.col - b.col);
    if (cols.length < 2) return null;
    const near = (col) => cols.reduce((a, b) =>
      (Math.abs(b.col - col) < Math.abs(a.col - col) ? b : a));
    const at = near(hl.from);
    if (Math.abs(at.col - hl.from) > 2) return null;
    const here = at.rows.find(r => r.row === hl.row);
    // The NEAREST match to the cursor, not the first. A column includes its own
    // heading -- DINO's command column is headed "and I AM READY TO", which
    // matches GO_LABEL on "READY" as surely as "Rock'n'roll" does -- and a walk
    // aimed at the heading walks off the top of the list and wraps.
    const pick = (rows, re) => rows
      .filter(r => re.test(r.label) && !QUIT_LABEL.test(r.label))
      .sort((a, b) => Math.abs(a.row - hl.row) - Math.abs(b.row - hl.row))[0];
    const up = { ah: 0x48, al: 0 };
    const down = { ah: 0x50, al: 0 };
    const enter = { ah: 0x1C, al: 0x0D };
    const toRow = (row) => (row < hl.row ? { ...up } : { ...down });

    // On the thing that starts the demo: press it.
    if (here && GO_LABEL.test(here.label) && !QUIT_LABEL.test(here.label)) return enter;
    // In a column that offers silence: get onto it, then commit it.
    const quiet = pick(at.rows, SILENT_LABEL);
    if (quiet) return quiet.row === hl.row ? enter : toRow(quiet.row);
    // Otherwise head for the command, on its row first so that the sideways
    // move has somewhere to land.
    for (const c of cols) {
      const go = pick(c.rows, GO_LABEL);
      if (!go || c === at) continue;
      if (go.row !== hl.row) return toRow(go.row);
      return { ah: c.col > at.col ? 0x4D : 0x4B, al: 0 };
    }
    return null;
  }

  arrowMenuKeys(lines) {
    // A marker is one of these characters flush against its label, with
    // whitespace or the line start in front: DINO.EXE writes
    // ">Gravis Ultrasound" and walks the `>` down the column. "Flush" is what
    // separates it from the "> 2" in the IRQ column, which marks nothing.
    //
    // ASCII only, and that is not a shortcut: screenText turns every byte
    // outside 0x20..0x7E into a space, so a CP437 arrow or a bullet never
    // reaches this function as itself. Widening the set here would be a lie.
    const MARK = '>*';
    // Every marker on the screen, not just the first one. A grid has one per
    // column and they move independently, so the moment the device column's
    // marker leaves the top row a first-match scan finds the PORT column's
    // instead -- and there is nothing to choose in that column, so the walk
    // stops one row short of where it was going and never starts again. Try
    // each marker and keep the one whose own column holds a silent option.
    const marks = [];
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i] || '';
      for (let j = 0; j < s.length; j++) {
        if (!MARK.includes(s[j])) continue;
        if (j && !/\s/.test(s[j - 1])) continue;
        if (s[j + 1] && !/\s/.test(s[j + 1])) marks.push([i, j]);
      }
    }
    // The labels in one marker's column, top to bottom, with the marker's own
    // index among them -- or null when this marker is not on a list at all.
    // Two spaces end a label, because that is where the next grid column
    // starts.
    const column = ([row, col]) => {
      const at = (i) => {
        const s = (lines[i] || '').slice(col + 1);
        if (!s || /^\s/.test(s)) return null;
        const label = s.split(/\s{2,}/)[0].trim();
        return label.length >= 2 ? label : null;
      };
      if (!at(row)) return null;
      const rows = [row];
      for (let i = row - 1; i >= 0 && at(i); i--) rows.unshift(i);
      for (let i = row + 1; i < lines.length && at(i); i++) rows.push(i);
      return rows.length >= 2 ? { labels: rows.map(at), now: rows.indexOf(row) } : null;
    };
    const walk = (c, want) => {
      const move = want - c.now;
      const step = move >= 0 ? { ah: 0x50, al: 0 } : { ah: 0x48, al: 0 };
      const ks = [];
      for (let i = 0; i < Math.abs(move); i++) ks.push({ ...step });
      ks.push({ ah: 0x1C, al: 0x0D });
      return ks;
    };
    const cols = marks.map(column).filter(Boolean);
    // First the choice: a column with a silent option the marker is not on yet.
    //
    // "Quit back to DOS" matches SILENT_LABEL on the strength of its first
    // word, and it sits one row under "Rock'n'roll" in DINO's command column.
    // Choosing silence and choosing the exit are opposite outcomes, so an exit
    // is never a target here.
    for (const c of cols) {
      const want = c.labels.findIndex(l => SILENT_LABEL.test(l) && !QUIT_LABEL.test(l));
      if (want >= 0 && want !== c.now) return walk(c, want);
    }
    // Then the command that starts the thing. DINO heads this column "and I AM
    // READY TO" and offers "Rock'n'roll" over "Quit back to DOS".
    for (const c of cols) {
      const want = c.labels.findIndex(l => GO_LABEL.test(l) && !QUIT_LABEL.test(l));
      if (want >= 0) return walk(c, want);
    }
    // Neither: this column is settled and there is nothing to start here yet.
    // Enter is what advances a grid to its next field -- DINO's port and IRQ
    // columns have nothing worth choosing in them, and its command column does
    // not draw a marker at all until the focus reaches it. So confirm and move
    // on, unless some marker is sitting on a way out, in which case pressing
    // Enter is how the demo ends instead of starts.
    if (cols.length && !cols.some(c => QUIT_LABEL.test(c.labels[c.now]))) {
      return [{ ah: 0x1C, al: 0x0D }];
    }
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
    // The page is byte-identical to the one THIS reader last built its string
    // from, so the string it would build is the same one already sitting in
    // autoKeyScreen and the comparison below is settled. The kind check is not
    // optional: autoKeyPoll writes a different format into the same field, so a
    // look by the other reader in between leaves a string this one would not
    // match even on an unchanged page. See textPageEpoch.
    const epoch = this.textPageEpoch();
    const settled = epoch === this.autoKeyNextEpoch && this.autoKeyScreenKind === 'next';
    const text = settled ? null : this.screenText();
    const shown = settled ? this.autoKeyScreen : text.join('\n');
    this.autoKeyNextEpoch = epoch;
    this.autoKeyScreenKind = 'next';
    if (shown !== this.autoKeyScreen) {
      this.autoKeyScreen = shown;
      const k = this.menuKey();
      const say = (ks) => this.log(`autokey read "${ks.map(x =>
        String.fromCharCode(x.al)).join('')}" off the screen`);
      if (k) this.autoKeyAnswered = text;
      if (Array.isArray(k)) {
        this.autoKeyRead++;
        say(k);
        this.autoKeyQueue = k.slice(1);
        return k[0];
      }
      if (k) { this.autoKeyRead++; say([k]); return k; }
    }
    const rot = this.autoKeys[this.autoKeyAt++ % this.autoKeys.length];
    this.log(`autokey rotating: "${String.fromCharCode(rot.al)}"`);
    return rot;
  }

  // The same question in a GRAPHICS mode, where the menu reader cannot help --
  // DEMO5.EXE draws its "SELECT OUTPUT DEVICE" list one BIOS pixel at a time in
  // CGA mode 4, so there is no text page to read it off. It then polls INT 16h
  // forever: 455,159 times in a 100M-dispatch run, which is the whole of what
  // it does after the menu is up.
  //
  // Answering the rotation on every polled read would be the disaster the note
  // below describes, so the gate is that the SCREEN HAS STOPPED CHANGING. A
  // demo polling once a frame to see whether to quit is redrawing between
  // polls; a program parked on a menu is not drawing at all. Sample the buffer
  // every few thousand polls, and only offer a key once two consecutive samples
  // agree -- which costs 256 byte reads per 4096 polls and cannot fire on
  // anything that is still animating.
  autoKeyPollGraphics() {
    if ((this.gfxPolls = (this.gfxPolls || 0) + 1) % 4096) return;
    const m = this.mem;
    const base = this.vga.cga ? VRAM_TEXT : VGA_BASE;
    let h = 0x811c9dc5;
    for (let i = 0; i < 256; i++) h = Math.imul(h ^ m[base + i * 61], 0x01000193);
    h >>>= 0;
    const same = h === this.gfxScreenHash;
    this.gfxScreenHash = h;
    if (!same) return;
    const k = this.autoKeys[this.autoKeyAt++ % this.autoKeys.length];
    this.log(`autokey answering a polled read on a still graphics screen `
      + `with "${String.fromCharCode(k.al)}"`);
    this.keys.push(k);
  }

  // A polled read (INT 16h AH=01h) asks "is anyone there", and answering it out
  // of the rotation would be a disaster: a demo checks that once a frame to see
  // whether to quit, and would be told yes on its first frame. So a poll
  // manufactures a key only when the screen is TEXT and the menu reader
  // recognises what is on it -- BTW.EXE and CYCLE.EXE both poll rather than
  // block, and their sound menus were unanswerable until this. The key goes
  // into the injected queue so the AH=00h read that follows gets the same one.
  autoKeyPoll() {
    if (!this.autoKey || this.keys.length) return;
    if (!TEXT_MODES.has(this.videoMode)) { this.autoKeyPollGraphics(); return; }
    // Nothing below can come out different while the page is byte-identical to
    // the one this reader last looked at: the string it would build is the one
    // already in autoKeyScreen and the answer it gave then was nothing. See
    // textPageEpoch. A program parked on a menu polls INT 16h from inside its
    // animation loop -- ASMINST.EXE made 1.17M of these calls in a 20M-dispatch
    // run before the poll stopped handing back -- and each one rebuilding the
    // whole 80x25 page as a string is the entire cost of answering it.
    const epoch = this.textPageEpoch();
    if (epoch === this.autoKeyPollEpoch && this.autoKeyScreenKind === 'poll') return;
    this.autoKeyPollEpoch = epoch;
    this.autoKeyScreenKind = 'poll';
    // The highlight is part of "what is on the screen". A grid menu answers a
    // key by moving its cursor, which is a colour and not a character, so a
    // gate that compares text alone sees the demo ignore every key after the
    // first and stops -- and the walk that needs several keys never finishes.
    const hl = this.screenHighlight();
    const text = this.screenText();
    const shown = `${text.join('\n')}\n@${hl ? `${hl.row},${hl.from}` : ''}`;
    if (shown === this.autoKeyScreen) return;
    this.autoKeyScreen = shown;
    const k = this.menuKey();
    if (!k) return;
    this.autoKeyAnswered = text;
    const ks = Array.isArray(k) ? k : [k];
    this.autoKeyRead++;
    // Scan codes as well as characters: an arrow key has no character at all,
    // so a log of the characters alone prints an answer of three keys as "".
    this.log(`autokey answered a polled menu with `
      + ks.map(x => (x.al >= 0x20 && x.al < 0x7F
        ? `"${String.fromCharCode(x.al)}"` : `scan ${x.ah.toString(16)}`)).join(' '));
    this.keys.push(...ks);
    this.syncKbBda();
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

  // Point the machine at a NEW instance's export table, and change nothing
  // else. This exists because `setMemory` below is a RESET and not a rebind:
  // it clears the text page, reinstalls the interrupt vector table, rewrites
  // the BIOS data area and re-stamps the video ROM, all of which is right at
  // boot and catastrophic mid-run. The live region JIT swaps the wasm instance
  // underneath a running program (region-live.js `install`), and calling
  // setMemory there handed the guest a fresh IVT -- so a demo that had hooked
  // INT 08h/09h/1Ch lost its own handlers at the install and stopped making
  // progress from that dispatch on. ACCIDENT, BRW, CONTAGIO and DRAGON all
  // died of exactly this, and none of them ever entered the compiled region:
  // `--trap` (a region body of `unreachable`) reproduced every one of their
  // divergences byte for byte without trapping.
  //
  // The memory itself does not move -- both instances import the same
  // WebAssembly.Memory -- so every view the machine already holds stays valid
  // and only the export table has to be replaced.
  setVmExports(ex) {
    this.vmExports = ex || null;
    return this;
  }

  // `ex` is the VM's export object, and the only thing the machine ever wants
  // from it is `set_linmask` -- see openBus below.
  //
  // NOT a rebind: see setVmExports. Everything below re-stamps the machine into
  // its boot state, so this is for the ONE call that happens before the guest
  // runs.
  setMemory(mem, ex) {
    this.mem = mem;
    this.vmExports = ex || null;
    this.con.mem = mem;
    // The text page as words, and a copy of it. See textPageEpoch. A wasm
    // memory's byte offset is zero in practice and VRAM_TEXT is a multiple of
    // four, but a Uint32Array over a misaligned buffer throws, so fall back to
    // bytes rather than assume.
    const cellBytes = this.con.cells * 2;
    const aligned = ((mem.byteOffset + VRAM_TEXT) & 3) === 0 && (cellBytes & 3) === 0;
    this.conWords = aligned
      ? new Uint32Array(mem.buffer, mem.byteOffset + VRAM_TEXT, cellBytes >> 2)
      : mem.subarray(VRAM_TEXT, VRAM_TEXT + cellBytes);
    this.conSnapWords = this.conWords.slice();
    this.conEpoch = 1;
    this.autoKeyPollEpoch = -1;
    this.autoKeyNextEpoch = -1;
    this.con.fillCells(0, this.con.cells, 0x20, 0x07);
    // reset() ran against the placeholder array, so re-apply everything it put
    // in the BIOS data area now that there is somewhere real to put it.
    this.installIvt();
    this.mem[0x449] = this.videoMode;
    this.setSystemBda();
    this.setVideoBda();
    this.syncKbBda();
    this.setTicks(this.ticks, { force: true });
    this.installVideoRom();
  }

  // The video BIOS ROM at C000. Written only for a machine that HAS an SVGA,
  // because the string in it is a claim about the registers above -- see
  // svgaSetBank and the sequencer/CRTC read-backs in portIn_.
  //
  // A card of this era is identified by name, and by nothing else. ANGEL.EXE's
  // SETUP.EXE sweeps C000 to F000 for one of 43 vendor spellings and uses the
  // hit to pick which register probe to run; the probes are all gated on it,
  // so with no ROM present every one of them declines, the chipset id stays 0,
  // and SETUP indexes a routine table whose slot 0 is a null pointer. There is
  // no default and no "standard VGA" entry -- the id is the ROM's answer or
  // nothing.
  installVideoRom() {
    if (this.svga !== 'trident' || !this.mem.length) return;
    const rom = 0xC0000;
    // The option-ROM header every adapter has had since 1984: signature, size
    // in 512-byte blocks, and an init entry that returns.
    this.mem[rom] = 0x55; this.mem[rom + 1] = 0xAA;
    this.mem[rom + 2] = 0x40;                        // 32KB
    this.mem[rom + 3] = 0xCB;                        // retf
    const id = 'Trident TVGA8900 VGA BIOS';
    for (let i = 0; i < id.length; i++) this.mem[rom + 0x30 + i] = id.charCodeAt(i);
    this.mem[rom + 0x30 + id.length] = 0;
  }

  // The linear address a DOS call's SEG:OFF argument names.
  //
  // In real mode that is seg<<4 and always was. In protected mode the segment
  // register holds a SELECTOR, its base lives in a descriptor, and seg<<4 is
  // an unrelated address that happens to be in range -- so every buffer a
  // service reads or writes lands somewhere the guest never asked for. It is a
  // quiet failure: the call returns success, the guest gets its byte count,
  // and the bytes are somewhere else.
  //
  // This is what the DOS-extender demos were dying of. CONTAGIO.EXE reads 0xC4
  // bytes of its own overlay to DS:0 while in 16-bit protected mode, jumps to
  // the code it just loaded, and lands in the extender's error strings --
  // "Cannot Address Above 1MB" -- because the read went to 0x2580 instead of
  // the selector's base. AQUAPHOB.EXE and STHINTRO.EXE share the loader and
  // die the same way.
  //
  // The VM already caches each segment register's base, so the answer is a
  // lookup rather than a descriptor walk. Only the real-mode result is masked
  // to 1MB: a protected-mode base is allowed above it, and folding it back
  // would recreate the bug one megabyte along.
  lin(r, reg, off) {
    const ex = this.vmExports;
    if (ex && (ex.get_cr0() & 1)) {
      const at = ((ex[`get_${reg}b`]() >>> 0) + (off & 0xFFFF)) >>> 0;
      return at < this.mem.length ? at : 0;
    }
    return (((r.get(reg) & 0xFFFF) << 4) + (off & 0xFFFF)) & 0xFFFFF;
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

    // VBE's window-positioning function, the same way. A ModeInfoBlock carries
    // a far pointer at offset 0x0C to a routine that moves the window, and a
    // program is entitled to CALL it instead of going through AX=4F05 -- it is
    // the fast path, because it skips the BIOS's own dispatch. CHROME.EXE takes
    // exactly that path: `call far cs:[0b7c]` at 100:0afd, with the pointer it
    // read out of the block. Leaving that pointer zero does not make the
    // program fall back on the interrupt; it far-calls 0000:0000 and executes
    // the interrupt vector table.
    //
    // It cannot be a stub byte in the F000 segment, because the run loop reads
    // any CS of F000 as "a vector was taken" and recovers the vector from the
    // low byte of IP. So this is real code -- push AX, ask the BIOS to do it,
    // restore AX, far return -- which leaves every register the caller had,
    // where the far-call entry is only obliged to preserve the ones it is
    // not passed in.
    const win = VESA_WIN_SEG << 4;
    [0x50, 0xB8, 0x05, 0x4F, 0xCD, 0x10, 0x58, 0xCB]
      .forEach((b, i) => { this.mem[win + VESA_WIN_OFF + i] = b; });
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

  // Advance the BIOS tick count at 0040:006C.
  //
  // The counter in memory is ADVANCED, not recomputed from `this.ticks`, and
  // a slice that spans no whole tick does not touch it at all. That is what a
  // real BIOS ISR does -- it increments the dword and returns -- and the
  // difference is load-bearing, because 0040:006C is ordinary RAM that guests
  // write: setting it is the documented way to reset the day timer, and a
  // protector will park a byte there to read back a moment later. Rewriting it
  // from an absolute counter silently ate every such write, and because
  // setClock() runs once per slice it ate them thousands of times a second.
  //
  // JULTRO.EXE is the case that found it. Its Protect! stub plants the vector
  // number of its own cleanup handler at 0000:046C, then reads it back to build
  // an `int <n>` it executes; with the write eaten it read the absolute count,
  // still 0, executed `int 00h`, and skipped the routine that restores the
  // INT 21h vector -- so the demo's first DOS call ran off into its own data.
  //
  // `force` rewrites the absolute value instead: the resets that re-lay the
  // BIOS data area are stating the count, not advancing it.
  setTicks(t, { force = false } = {}) {
    const next = t >>> 0;
    const delta = next - this.ticks;
    this.ticks = next;
    if (!force && delta <= 0) return;
    const at = 0x46C;
    const cur = force ? next
      : (((this.mem[at] | (this.mem[at + 1] << 8) | (this.mem[at + 2] << 16)
        | (this.mem[at + 3] << 24)) >>> 0) + delta) >>> 0;
    this.mem[at] = cur & 0xFF;
    this.mem[at + 1] = (cur >> 8) & 0xFF;
    this.mem[at + 2] = (cur >> 16) & 0xFF;
    this.mem[at + 3] = (cur >> 24) & 0xFF;
  }

  // Has the guest taken a vector over, or is it still ours?
  //
  // Every vector starts out pointing into the stub segment, so "not the stub
  // segment" is exactly "the program installed its own handler". No bookkeeping
  // in the INT 21h AH=25 path is needed, and a program that writes the IVT
  // directly -- which several here do, since it is two stores -- is caught too.
  //
  // A protected-mode program's handler is an IDT gate rather than a vector
  // here, and consulting the IDT for these vectors was tried and reverted. It
  // cannot work at the numbers this function is asked about: every caller below
  // passes 0x08, 0x09, 0x0A, 0x0F or 0x1C, and in protected mode those are the
  // CPU's own exception numbers -- 8 is #DF -- so an extender has a present
  // gate at all of them whatever it thinks of hardware interrupts. Reading that
  // as "the guest hooked the timer" sent a double fault every tick, and cd2.exe,
  // daretro.exe and AMBIENT.EXE each lost a full screen of picture to a printed
  // "Exception fault." Where a pmode program remaps its PIC to is not something
  // we track, and until it is there is nothing here to read.
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
  // Is there a keystroke to deliver as an IRQ1, and if so, leave its scancode
  // where port 60h will read it. Returns the vector to raise, or 0.
  //
  // Only for a program that installed its own INT 9 handler: anything using the
  // BIOS is served by int16 above, and sending it a hardware interrupt as well
  // would put the same key in twice. Make code first, then break code, so a
  // handler tracking which keys are held does not think one is stuck down.
  //
  // A scancode already on the queue is delivered whatever `autoKey` says. That
  // flag governs the menu READER -- the thing that photographs the screen and
  // guesses an answer -- and gating delivery on it too meant that with a real
  // person at the keyboard, in the page, a demo reading the hardware directly
  // could never be sent anything at all.
  keyboardIrq() {
    if (!this.hookedVector(0x09)) return 0;
    if (!this.kbQueue.length && !this.kbFill()) return 0;
    this.kbScan = this.kbQueue.shift();
    this.kbFresh = true;
    return 0x09;
  }

  // A keystroke from outside: a person typing at the live page, or a test.
  //
  // Both wires get it, because which one a program listens on is not knowable
  // from here. The BIOS queue serves anything calling INT 16h; the scancode
  // pair serves a program that reads port 60h itself and would otherwise see
  // nothing. Make code then break code, so a handler tracking which keys are
  // held does not think one is stuck down.
  pushKey(scan, ascii) {
    this.keys.push({ ah: scan & 0xFF, al: ascii & 0xFF });
    this.kbQueue.push(scan & 0x7F, (scan & 0x7F) | 0x80);
    this.syncKbBda();
  }

  // The BIOS keyboard buffer, at 0040:001E, as a mirror of the INT 16h queue.
  //
  // A third wire, and one nothing here was driving. INT 16h is a service and
  // port 60h is hardware, but the ring between them is plain memory in the BIOS
  // data area, and a program is free to read it directly instead of asking --
  // plenty do, because it is faster than an interrupt and tells you what is
  // waiting without consuming it. With head and tail both left at zero the
  // buffer reads as permanently empty, so such a program waits forever on a key
  // that has already been typed.
  //
  // Mirroring rather than sharing storage: `keys` stays the one queue, and this
  // rewrites the ring to match after anything touches it. Head is pinned at the
  // start of the buffer, which a real BIOS does not do -- it is a circular
  // buffer and the pair wanders -- but head < tail with the entries in between
  // is a state the hardware reaches too, and nothing can tell the difference
  // from inside without watching it over time.
  //
  // 0040:0080 and 0082 are the buffer's own bounds. A program that resizes the
  // buffer writes them; one that walks it reads them, and finding zeros there
  // is how a walk ends up reading the interrupt vector table.
  syncKbBda() {
    const mem = this.mem;
    if (!mem || mem.length < 0x500) return;
    const put16 = (at, v) => { mem[at] = v & 0xFF; mem[at + 1] = (v >> 8) & 0xFF; };
    put16(0x480, 0x1E);
    put16(0x482, 0x3E);
    const n = Math.min(this.keys.length, 15);   // 16 slots, one always kept free
    for (let i = 0; i < n; i++) {
      const k = this.keys[i];
      mem[0x41E + i * 2] = k.al & 0xFF;
      mem[0x41F + i * 2] = k.ah & 0xFF;
    }
    put16(0x41A, 0x1E);
    put16(0x41C, 0x1E + n * 2);
  }

  // Put the menu reader's answer on the wire as scancodes. Text mode only, so
  // a demo polling for "any key to quit" over its own graphics is never told
  // one arrived. The screen-change guard inside autoKeyPoll is what stops this
  // firing again on the same screen; the read counter is only there so a tight
  // polling loop does not rebuild the 2000-cell screen string every time round.
  kbFill() {
    if (!this.autoKey || !TEXT_MODES.has(this.videoMode)) return false;
    this.autoKeyPoll();
    const k = this.keys.shift();
    if (!k) return false;
    this.syncKbBda();
    const sc = (k.ah & 0xFF) || 0x1C;
    this.kbQueue.push(sc, sc | 0x80);
    this.log(`autokey putting scancode ${sc.toString(16)} on the keyboard port`);
    return true;
  }

  // --- the sound card, as far as a detection routine can tell ---------------
  //
  // A DSP command, and the two that have to answer. E1h is the version, and
  // which version is not a detail: a program that wants a Sound Blaster Pro
  // rejects 1.05, and one written for the original card can refuse to believe a
  // 4.xx. 2.01 is the highest DSP that is still a plain mono SB, which is the
  // widest thing to claim on a corpus this old. E3h is the copyright string,
  // NUL-terminated, which a few detectors read to confirm a real card.
  sbCommand(v) {
    this.sb.commands++;
    // A command's operand bytes go to the same port as the command, so the
    // count has to be known before they arrive -- write one too few and the
    // next operand is read as a command.
    if (this.sb.expect) {
      this.sb.expect--;
      this.sb.args.push(v);
      if (!this.sb.expect) this.sbRun(this.sb.cmd, this.sb.args);
      return;
    }
    this.sb.cmd = v;
    this.sb.args = [];
    const n = SB_ARGS[v] !== undefined ? SB_ARGS[v]
      : (v >= 0xB0 && v <= 0xCF ? 3 : 0);        // SB16 transfer: mode + length
    if (n) { this.sb.expect = n; return; }
    this.sbRun(v, []);
  }

  sbRun(v, args) {
    if (v === 0xE1) { this.sb.out.push(this.dspVersion[0], this.dspVersion[1]); return; }
    if (v === 0xE3) {
      for (const c of 'COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.') this.sb.out.push(c.charCodeAt(0));
      this.sb.out.push(0);
      return;
    }
    // E0h is the "DSP identification" echo: the byte written after it comes
    // back complemented, and a detector that gets its own byte back concludes
    // there is nothing there.
    if (v === 0xE0) { this.sb.out.push((~args[0]) & 0xFF); return; }
    if (v === 0xD1 || v === 0xD3) { this.sb.speaker = v === 0xD1 ? 1 : 0; return; }
    if (v === 0x48) { this.sb.block = args[0] | (args[1] << 8); return; }
    // 40h sets the sample rate as a time constant, 41h (SB16) as the rate
    // itself, high byte first. Nothing here plays audio, but the rate decides
    // how long a block lasts and therefore how often its completion interrupt
    // may fire -- see sbBlockSeconds.
    if (v === 0x40) {
      const tc = args[0] & 0xFF;
      if (tc < 256) this.sb.rate = Math.round(1e6 / (256 - tc));
      return;
    }
    if (v === 0x41 || v === 0x42) {
      const r = (args[0] << 8) | args[1];
      if (r >= 1000) this.sb.rate = r;
      return;
    }
    // A transfer. Nothing is played -- there is no DMA behind this and no
    // audio out -- but the *end* of it is observable, and observing it is how
    // a driver decides the card is real. MIDAS (BLAND.EXE's .MSE modules) hooks
    // IRQ 2, 5 and 7, kicks off a block, and fails the whole card if none of
    // them fires; so does the AdLib-plus-SB init in several others. Arming here
    // and letting the run loop deliver it is the whole point.
    //
    // 80h is the same thing with silence, which is exactly what an init probe
    // asks for. D0h/D4h pause and resume, and a paused transfer must not
    // complete or an auto-init driver sees a block it never started.
    if (v === 0x14 || v === 0x15 || v === 0x16 || v === 0x17 || v === 0x80
        || v === 0x1C || v === 0x1D || v === 0x2C || v === 0x90 || v === 0x91
        || (v >= 0xB0 && v <= 0xCF)) {
      // The SB16 forms carry auto-init in bit 2 of the COMMAND (Bx/Cx + 4);
      // the mode byte that follows says signed/stereo, not that.
      this.sb.autoInit = v === 0x1C || v === 0x1D || v === 0x2C || v === 0x90
        || (v >= 0xB0 && v <= 0xCF && (v & 4) !== 0);
      // 90h and 91h are the SB 2.0/Pro *high-speed* forms. On those cards the
      // documented rule is that 91h plays one block, raises its interrupt and
      // LEAVES high-speed mode, so a driver has to send it again -- which is
      // what a DSP 2.01 sees here and what every other emulator implements.
      //
      // A DSP 4.xx SB16 has no high-speed mode to leave: the commands are not
      // in its manual at all, the card runs at full rate always, and 48h is
      // just an interrupt period. STHINTRO.EXE's player (DemoVT 1.60) is the
      // program in this corpus that says so out loud -- it re-sends 91h from
      // its block ISR on every card EXCEPT one whose DSP answered 4.x, where
      // it sends 48h+91h once and then only acknowledges:
      //
      //   ece3  cmp [d82],0     ; the "DSP is a 4.x" flag
      //   ed25  jz  ed2d        ; 2.x/3.x: send 91h again
      //   ed27  cmp [bp+6],0    ; 4.x and already playing:
      //   ed2b  jnz ed37        ;   send nothing at all
      //
      // With the block ended at the count the card had no way of knowing was
      // final, its music stopped after two blocks (2 IRQs in 60M dispatches),
      // its mixer never ran again and the demo held its title screen forever.
      // What keeps such a stream running is the only counter still armed: the
      // 8237's own auto-init bit, which this player leaves set (mode 59h). So
      // the block reloads while that bit is set, and the DMA controller --
      // not the DSP -- decides when the music stops. Read at the block end
      // rather than here, because a driver programs the 8237 AFTER the DSP.
      this.sb.hsAuto = (v === 0x90 || v === 0x91) && this.dspVersion[0] >= 4;
      this.sb.pending = true;
      // How long the block is, in samples. The 8-bit single-cycle commands
      // carry it themselves; the auto-init ones use whatever 48h last set; the
      // SB16 forms put it after the mode byte.
      const len = (v >= 0xB0 && v <= 0xCF) ? (args[1] | (args[2] << 8))
        : (args.length >= 2 ? (args[0] | (args[1] << 8)) : this.sb.block);
      // A *tiny* block completes on a real card in microseconds -- far sooner
      // than any driver's timeout spin -- so waiting for the periodic IRQ
      // cadence is not "slow", it is wrong. MIDAS (BLAND.EXE) finds its DMA
      // channel by programming the 8237 for a single byte, kicking off a
      // one-sample transfer and giving the IRQ a short `loopz` to arrive; at
      // cadence it never did for any channel, and the driver reported
      // "failed to load MSE" for a card it had already identified twice.
      // Anything long enough to actually be audio keeps the cadence.
      this.sb.len = len + 1;                // the count is one less, as in DMA
      // What audio.js pulls through the DMA channel from here on. The 8-bit
      // commands are unsigned mono on channel 1; the SB16 forms carry a mode
      // byte (bit 4 signed, bit 5 stereo) and the 16-bit ones use channel 5.
      const sb16 = v >= 0xB0 && v <= 0xCF;
      this.sb.bits = sb16 && v < 0xC0 ? 16 : 8;
      this.sb.signed = sb16 ? (args[0] & 0x10) !== 0 : false;
      this.sb.stereo = sb16 ? (args[0] & 0x20) !== 0 : false;
      this.sb.chan = this.sb.bits === 16 ? this.audio.dma.recent16 : this.audio.dma.recent8;
      this.sb.left = this.sb.len;
      this.sb.irqDue = false;
      this.audio.sbSide = 0;
      // A new transfer is not the paused one. D0h stops the transfer in
      // flight; the command that follows starts another, and the card plays
      // it. ENDPART.EXE pauses before every block it queues (D0, 40, 14) and
      // with the pause carried over, audio.js never pulled a sample of any of
      // them: 55 DSP commands, one interrupt, 25 seconds of digital silence
      // over a buffer that held the music.
      this.sb.paused = false;
      // A tiny block completes as soon as the DMA controller lets it through,
      // and not before: ACT1.EXE finds its DMA channel by kicking off an
      // 11-byte transfer with every channel masked, then unmasking candidates
      // one at a time to see which one makes the interrupt come. Fired at the
      // command, the interrupt arrived before any channel was open and the
      // hunt never found one. So it waits on the mask -- see sbDmaWritten.
      if (len <= SB_SHORT_BLOCK) {
        if (this.sbChannelOpen(this.sb.chan)) { this.sb.forced = true; this.endSlice(); }
        else this.sb.shortWait = true;
      }
      return;
    }
    // F2h forces an 8-bit IRQ (F3h the 16-bit one) with no transfer behind it.
    // It is how a driver finds out WHICH IRQ the card is wired to, since nothing
    // about the card says: hook every candidate, send this, and see which one
    // fires. BLAND.EXE's MIDAS driver hooks vectors 0x0A/0x0D/0x0F/0x72,
    // unmasks IRQ 2/5/7 at both PICs, sends F2 and spins on a flag its handlers
    // clear; with the command ignored nothing ever fired, it put the masks and
    // vectors back and reported "failed to load MSE" for a card it had already
    // reset twice and identified.
    //
    // Unlike a transfer's completion this one is immediate by definition -- the
    // driver's wait is a `loopz` and not a long one -- so it is delivered on the
    // next opportunity rather than on the periodic IRQ cadence.
    if (v === 0xF2 || v === 0xF3) {
      this.sb.forced = true;
      this.sb.forcedBits = v === 0xF3 ? 16 : 8;
      this.endSlice();
      return;
    }
    if (v === 0xD0) { this.sb.paused = true; this.sb.pending = false; return; }
    if (v === 0xD4) { this.sb.paused = false; this.sb.pending = true; return; }
    // DAh stops an auto-init transfer for good.
    if (v === 0xDA || v === 0xD9) { this.sb.autoInit = false; this.sb.pending = false; }
  }

  // Whether the 8237 would let a transfer on channel `c` proceed: unmasked.
  // Not "programmed": a channel that was never given an address still
  // transfers from whatever its registers hold, and a detection routine that
  // only unmasks is counting on exactly that.
  sbChannelOpen(c) {
    return !(this.audio.dma.masked & (1 << c));
  }

  // The DMA controller was written. A short block waiting for its channel
  // (sbRun) completes the moment a channel of the block's own width opens, on
  // that channel: the card's DREQ goes wherever the jumper says, and the
  // program has just told us where it believes that is.
  //
  // The width half is not cosmetic. A 16-bit block moves through the SECOND
  // 8237 -- channels 4-7, programmed through 0xC0-0xCE and masked through
  // 0xD4 -- and a search that only ever looked at channels 0-3 could not see
  // one open. ATTIC.EXE's DSMI driver finds its 16-bit channel exactly that
  // way: it masks 8-bit channels 0/1/3 AND 16-bit 5/6/7, issues B6h (16-bit
  // single-cycle, 6 samples), then programs channel 5 and unmasks it alone.
  // With only 0-3 considered the answer was always "no channel is open", the
  // probe never completed, no IRQ ever fired, and DSMI reported no card --
  // which is the screen that says "It is not possible to run the demo without
  // music". Channel 4 is the cascade and never carries data.
  sbDmaWritten() {
    if (!this.sb.shortWait || !this.sb.pending) return;
    const dma = this.audio.dma;
    const wide = this.sb.bits === 16;
    const lo = wide ? 5 : 0, hi = wide ? 8 : 4;
    const recent = wide ? dma.recent16 : dma.recent8;
    let c = -1;
    if (recent >= lo && recent < hi && this.sbChannelOpen(recent)) c = recent;
    else for (let i = lo; i < hi; i++) if (this.sbChannelOpen(i)) { c = i; break; }
    if (c < 0) return;
    this.sb.chan = c;
    this.sb.shortWait = false;
    this.sb.forced = true;
    this.sb.forcedBits = this.sb.bits;
    this.endSlice();
  }

  // The vector for the Sound Blaster's IRQ, if a block is finished and the
  // program has a handler on it. IRQ 7 is what BLASTER announces; a driver that
  // hooked several and is waiting to see which one fires learns the answer
  // here. Auto-init keeps going, single-cycle does not.
  sbIrq() {
    if (this.sound !== 'full') return 0;
    if (!this.sb.forced && !this.sb.irqDue) return 0;
    if (!this.hookedVector(SB_IRQ_VEC)) return 0;
    // A forced IRQ answers for itself and leaves any transfer alone: a driver
    // that probes in the middle of playback must not have its block completed
    // out from under it. A block's own interrupt is owed once the last sample
    // of it went through the DMA channel (Sound.sbNext), and auto-init has
    // already re-armed the next block by the time it is delivered.
    // Which block-interrupt bit the mixer's 0x82 shows, and therefore which
    // port the ISR will read to acknowledge it: 0x22E for an 8-bit block,
    // 0x22F for a 16-bit one. A forced IRQ carries the width of whatever
    // asked for it (F2h/F3h, or the short block that was waiting on its DMA
    // channel); a block's own completion carries the width it is playing.
    if (this.sb.forced) {
      this.sb.forced = false;
      this.sb.irqLatched |= this.sb.forcedBits === 16 ? 2 : 1;
    }
    else { this.sb.irqDue = false; this.sb.irqLatched |= this.sb.bits === 16 ? 2 : 1; }
    this.sb.irqs++;
    return SB_IRQ_VEC;
  }

  // What a read of the mixer data port answers. 0x80 says which IRQ the card
  // is jumpered to (bit 0 = IRQ2, 1 = IRQ5, 2 = IRQ7, 3 = IRQ10) and 0x81
  // which DMA channels (bit n = channel n): the card here interrupts on IRQ7
  // (SB_IRQ_VEC) and takes channel 1 for 8-bit and 5 for 16-bit blocks,
  // which is what BLASTER= announces. A program that reads these got 0xFF
  // before, and CONTAGIO.EXE, COUNTDWN.EXE and AQUAPHOB.EXE all read them
  // right after an SB16's version reply and stopped there. 0x82 is which
  // block interrupt is outstanding, for an ISR to pick its ack port by.
  sbMixerRead() {
    const i = this.sb.mixerIndex;
    if (i === 0x80) return 0x04;
    if (i === 0x81) return 0x22;
    if (i === 0x82) return this.sb.irqLatched;
    return this.sb.mixer[i];
  }

  // The Ultrasound's interrupt, as a vector to raise or 0. The line is the
  // one the program latched through 0x2XB, turned into a vector by where
  // the PICs were told to put it (pic.base). A real-mode program must have
  // hooked that vector, as for the Sound Blaster; a protected-mode one has
  // its handler behind an IDT gate the VM's raise_irq resolves itself.
  gusIrq() {
    if (this.sound === 'none' || !this.gus.takeIrq()) return 0;
    const line = this.gus.irqLine();
    const vec = line < 8 ? this.pic.base[0] + line : this.pic.base[1] + line - 8;
    const ex = this.vmExports;
    const pmode = ex && ex.get_cr0 && (ex.get_cr0() & 1);
    return (pmode || this.hookedVector(vec)) ? vec : 0;
  }

  // Seconds between interrupts of the fastest GF1 timer that is running with
  // its interrupt enabled, or 0: the loop cuts its slices to a quarter of it.
  gusPeriod() {
    if (this.sound === 'none' || !this.gus.irqEnabled()) return 0;
    let p = 0;
    for (let i = 0; i < 2; i++) {
      const t = this.gus.timers[i];
      if (!t.running || !(this.gus.timerCtl & (0x04 << i))) continue;
      const period = (256 - this.gus.timerCount[i]) * t.unit;
      if (!p || period < p) p = period;
    }
    return p;
  }

  // Whether a block has finished and its interrupt is waiting to be delivered.
  sbDue() {
    return this.sb.irqDue;
  }

  // The dispatch count right now, inside the slice being run: where the slice
  // started plus what the VM has spent of its budget. This is what lets a port
  // write be placed at the right sample when the slice is rendered.
  audioNow() {
    const ex = this.vmExports;
    if (!ex || !ex.get_steps) return this.sliceStart;
    const left = ex.get_steps();
    return this.sliceStart + Math.max(0, this.sliceBudget - Math.max(0, left));
  }

  // `dt` guest seconds went by over the slice that started at `sliceStart` and
  // spent `spent` dispatches. Consumes the sample stream and, with a sink,
  // renders it.
  audioAdvance(dt, sliceStart, spent) {
    this.audio.advance(dt, sliceStart, spent);
  }

  // A write that changes what the speaker does, stamped with when.
  speakerChanged() {
    this.audio.noteSpeaker(this.audioNow(), this.port61 & 1, (this.port61 >> 1) & 1,
      this.pit.latch[2]);
  }

  // How long the block now in flight lasts, in guest seconds. A block-done
  // interrupt that comes round faster than this is not early, it is *wrong*:
  // the driver mixes a whole buffer inside its handler, so an interrupt every
  // fixed number of dispatches asks it to produce half a second of audio in ten
  // milliseconds of guest time and the program it interrupted never runs again.
  // BLAND.EXE sat in MIDAS's mixer for 300M dispatches that way, with its own
  // code never reached and the screen still in text mode.
  sbBlockSeconds() {
    if (!this.sb.len || !this.sb.rate) return 0;
    return this.sb.len / this.sb.rate;
  }

  // Guest seconds until the block in flight runs out, 0 when nothing is
  // playing. The loop cuts its slice to this so the block-done interrupt
  // reaches the guest at the sample the block ended on, not at the end of
  // whatever slice happened to contain it. A single-cycle player (BRW.EXE:
  // 4096 samples at 22kHz, 0x14 re-issued from the handler) otherwise gets a
  // 1-4ms hole between blocks where the card holds its last sample, and that
  // hole is a click at every block boundary, five times a second.
  sbSecondsLeft() {
    const sb = this.sb;
    if (!sb.pending || sb.paused || !sb.rate || sb.left <= 0) return 0;
    return sb.left / sb.rate;
  }

  // Whether an IRQ is owed right now rather than at the next cadence tick.
  sbForced() {
    return this.sb.forced;
  }

  // Cut the current slice short so an interrupt armed by a port write reaches
  // the guest at the next instruction boundary instead of at the next slice
  // boundary -- which is up to two million dispatches away, and that is not a
  // latency any real card has.
  //
  // It is the difference between BLAND.EXE finding its DMA channel and not:
  // MIDAS starts a one-byte transfer and then spins `loopz` on a flag its own
  // IRQ handler sets, about 1.1M dispatches of it, which fits inside one slice
  // with room to spare. The IRQ was arriving one handback later every time --
  // right after the timeout's DSP reset, visible in --trace-io as the `in 22e`
  // that follows `out 226` -- so all three candidate channels timed out and the
  // driver reported "failed to load MSE" for a card it had already identified.
  //
  // $steps is the region's remaining budget and the emitted exit test is
  // `steps < 0`, so -1 ends it at the next check. The unspent count has to be
  // saved first: the exit writes $steps into $left, and a -1 there is the loop's
  // own signal for "ran to exhaustion", which would bill the whole slice.
  endSlice() {
    const ex = this.vmExports;
    if (!ex || !ex.set_steps || !ex.get_steps) return;
    const left = ex.get_steps();
    if (left < 0) return;                 // already ending
    this.sliceCut = left;
    ex.set_steps(-1);
  }

  // The unspent budget from the last endSlice, once. The run loop asks after
  // every slice so it can bill honestly.
  takeSliceCut() {
    const v = this.sliceCut;
    this.sliceCut = -1;
    return v;
  }

  // The OPL2 status register. The presence test is: reset both timers, read
  // status (expect 0), start timer 1, wait, read status (expect bits 7 and 6
  // set), reset again, read (expect 0). An absent card floats at 0xFF, which
  // is why leaving this unanswered is what "no adlib compatible sound card"
  // means. The timer is not modelled -- it reads as expired the moment it is
  // started, which is what the test is waiting for anyway.
  adlibStatus() {
    return this.audio.opl.status();
  }

  // A register write into the chip in audio.js, stamped with when it landed
  // so the note starts at its own sample when the slice is rendered.
  adlibWrite(v) {
    this.audio.noteOpl(this.audioNow(), this.adlibIndex, v);
  }

  // The CRTC's vertical-retrace interrupt: IRQ2, vector 0x0A. Polling 0x3DA for
  // the retrace bit is the common way to wait for a frame and needs nothing from
  // us, but a program can instead ask to be interrupted -- and one that does
  // gets no other signal that the frame ended. ANGEL's SETUP.EXE hooks 0x0A,
  // clears bit 5 of CRTC 0x11, waits twice and reads a flag only its own handler
  // sets; with the interrupt never delivered it read the flag as zero, took a
  // null function pointer and halted through the Turbo Pascal runtime, which is
  // why the demo still says "Please run setup.exe".
  //
  // Both gates matter. `vretrace` is the program asking, and an unhooked vector
  // means nobody is listening -- delivering IRQ2 into whatever the vector table
  // happens to hold is how a working program gets pushed somewhere arbitrary.
  retraceIrq() {
    if (!this.vga.vretrace) return 0;
    if (!this.hookedVector(0x0A)) return 0;
    return 0x0A;
  }

  // The frame rate the VGA clock runs at, and the line count it divides the
  // frame into: 70Hz over 449 lines for every 200/350/400-line mode, 60Hz over
  // 525 for the 480-line ones (mode 11h/12h and the VESA 640x480 modes). The
  // run loop reads this every slice and sets the VM's period from it.
  vgaTiming() {
    const h = this.vesa && this.vesa.mode ? this.vesa.height : 0;
    const tall = h >= 480 || this.videoMode === 0x11 || this.videoMode === 0x12;
    return tall ? { hz: 60, lines: 525 } : { hz: 70, lines: 449 };
  }

  // The attribute controller's index/data flip-flop. It is the VM's global
  // when a VM is attached (reading 3DAh resets it, and that read is answered
  // inside the VM now); the machine's own field otherwise.
  getAttrFlip() {
    const ex = this.vmExports;
    return ex && ex.get_attr_flip ? ex.get_attr_flip() : this.vga.attrFlip;
  }

  setAttrFlip(v) {
    const ex = this.vmExports;
    if (ex && ex.set_attr_flip) ex.set_attr_flip(v);
    this.vga.attrFlip = v;
  }

  timerVector() {
    if (this.hookedVector(0x08)) return 0x08;
    if (this.hookedVector(0x1C)) return 0x1C;
    return 0;
  }

  // --- ports ---------------------------------------------------------------
  //
  // --trace-io wraps both directions. Nothing else here can see port traffic:
  // --trace-int watches INT dispatch, --trace-entry watches handbacks, and an
  // `out dx,al` is neither. Every hardware question left in this corpus -- which
  // DMA registers a sound driver programs and reads back, which chipset
  // registers an SVGA probe writes before it decides what card it is on -- is a
  // conversation in port I/O, so it gets a flag rather than a console.log.
  //
  // `ioPorts` is null for "all", or a Set of port numbers. The reads are the
  // half worth filtering: a demo waiting for retrace reads 0x3DA hundreds of
  // thousands of times and buries everything else.
  portIn(port, w) {
    port = isaAlias(port);
    const v = this.portIn_(port, w);
    if (this.ioTrace && (!this.ioPorts || this.ioPorts.has(port))) {
      this.ioTrace(`in  ${port.toString(16).padStart(3, '0')}`
        + `${w === 16 ? 'w' : ' '} -> ${v.toString(16)}`);
    }
    return v;
  }

  portIn_(port, w) {
    if (port === 0x3DA) {
      // Bit 3 is vertical retrace, bit 0 "display disabled", and the answer is
      // a function of the dispatch clock: the VM's $vga_status (emit.js) is
      // the one place that formula lives, and `in al,dx` never gets here at
      // all -- the handler answers it inline. This path is `in ax,dx` and the
      // rare `in al,imm`, and it asks the same clock so the two agree. Reading
      // the status register also puts the attribute controller's shared
      // index/data flip-flop back into "next write is an index", which the
      // VM does in the same place.
      this.clock.retrace++;
      const ex = this.vmExports;
      if (ex && ex.vga_status) return ex.vga_status();
      // No VM attached (unit harnesses): the old alternating answer, so a
      // wait for retrace still sees the bit both ways.
      this.retraceToggle ^= 1;
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
    // Trident: sequencer index 0x0E is the bank register, and the value read
    // back out of it is what SETUP.EXE classifies the chip version on --
    // 0x80..0xFE is a TVGA8900, which is what we present. The low nibble is
    // the bank, so the byte moves as the guest pages through video memory.
    if (port === 0x3C5 && this.svga === 'trident' && this.vga.seqIndex === 0x0E) {
      return 0x80 | (this.svgaBank & 0x0F);
    }
    if (port === 0x3C5) return this.vga.seq[this.vga.seqIndex];
    if (port === 0x3CF) return this.vga.gc[this.vga.gcIndex];
    // Trident: CRTC index 0x1F reads back CRTC 0x0C exclusive-ORed with 0xEA,
    // and that pair IS the detection every program of the era does -- write
    // 0x55 to the start-address-high register, read 0xBF here.
    if ((port === 0x3D5 || port === 0x3B5) && this.svga === 'trident'
      && this.vga.crtcIndex === 0x1F) {
      return (this.vga.crtc[CRTC_START_HI] ^ 0xEA) & 0xFF;
    }
    if (port === 0x3D5 || port === 0x3B5) return this.vga.crtc[this.vga.crtcIndex];
    if (port === 0x3C4) return this.vga.seqIndex;
    if (port === 0x3CE) return this.vga.gcIndex;
    if (port === 0x3D4 || port === 0x3B4) return this.vga.crtcIndex;
    if (port === 0x3CC) return this.vga.misc;
    // Keyboard data. A program with an INT 9 handler finds here what the IRQ
    // just delivered; one that polls the port with no handler at all -- BTW.EXE
    // makes zero INT 16h calls and hooks nothing -- drives the queue itself.
    if (port === 0x60) {
      if (this.kbFresh) { this.kbFresh = false; return this.kbScan; }
      if (!this.kbQueue.length && (this.kbReads++ & 0xFFF) === 0) this.kbFill();
      if (this.kbQueue.length) this.kbScan = this.kbQueue.shift();
      return this.kbScan;
    }
    // System control port B: the speaker gate and data bits a driver reads,
    // modifies and writes back. Bit 4 is the refresh toggle, which flips so a
    // loop timing itself against it moves.
    if (port === 0x61) return (this.port61 & 0x0F) | ((this.clock.pit++ & 1) << 4);
    // The DMA controllers, which a driver programs and reads back -- the
    // current count is how it finds the playback position.
    if ((port <= 0x0F) || (port >= 0x80 && port <= 0x8F) || (port >= 0xC0 && port <= 0xDF)) {
      const v = this.audio.dma.read(port);
      if (v >= 0) return v;
    }
    // --- Sound Blaster, base 0x220 -----------------------------------------
    // Detection only, and deliberately so. About a dozen programs in this
    // corpus print a refusal instead of a demo -- "No (currently supported)
    // soundcard found", "Oeps, no adlib compatible sound card found" -- and
    // every one of them arrives at that line the same way: reset the DSP,
    // expect 0xAA back, ask its version. Nothing here plays a sample; the
    // point is to get past the check to the picture behind it.
    //
    // 0x22A is the read port, 0x22E its status (bit 7 = a byte is waiting),
    // 0x22C the write port (bit 7 = busy, always clear here).
    // The 8259 mask registers read back what was written; the command ports
    // (IRR/ISR) read as nothing pending.
    if (port === 0x21 || port === 0xA1) return this.pic.imr[port >> 7];
    if (port === 0x20 || port === 0xA0) return 0;
    if (this.sound !== 'none') {
      // The GF1's ports first: it answers only the offsets that are its own
      // (-1 for the rest), and its timer status is folded into the AdLib
      // status read below rather than answered here.
      const goff = port - this.gus.base;
      // 0x22F is the Sound Blaster's 16-bit interrupt acknowledge, and with
      // the GF1 at its default 0x220 that is also the GF1's 0x2X F, which
      // answers 0xFF for "a classic card has no register controls". The BYTE
      // is the same either way; what is not the same is the side effect --
      // reading it is how an ISR takes a 16-bit block's interrupt down, and
      // shadowed by the GF1 the latch in mixer register 82h never cleared.
      if (goff >= 0 && goff <= 0x107 && goff !== 0x008 && port !== 0x22F) {
        const r = this.gus.in(goff, w);
        if (r >= 0) return r;
      }
      if (port === 0x22A) return this.sb.out.length ? this.sb.out.shift() : 0;
      if (port === 0x22E) { this.sb.irqLatched &= ~1; return this.sb.out.length ? 0xFF : 0x7F; }
      if (port === 0x22F) { this.sb.irqLatched &= ~2; return 0xFF; }
      if (port === 0x225) return this.sbMixerRead();
      if (port === 0x22C) return 0x7F;
    }
    // The FM chip's status register. `IN AL,388h` twice and reading back 0
    // after resetting timers 1 and 2 is the whole OPL2 presence test, and a
    // card that is not there reads 0xFF. Bits 7/6 mirror the timer flags.
    // 0x220-0x223 are the same chip through a Sound Blaster Pro's FM ports
    // (left/right pairs); CMA_SHRT reads its status at 0x220 and writes its
    // registers through 0x220/0x221 and never touches 0x388.
    if (port === 0x388 || port === 0x389 || port === 0x228 || port === 0x229
        || (this.sound !== 'none' && port >= 0x220 && port <= 0x223)
        || (this.sound !== 'none' && port === this.gus.base + 0x008)) {
      if (this.sound === 'none') return 0xFF;
      // The GF1's AdLib-compatible timer flags live at its 0x2X8; when that
      // is 0x228 the OPL's own flags read there too.
      return this.adlibStatus() | (port === this.gus.base + 0x008 ? this.gus.adlibStatus() : 0);
    }
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
    port = isaAlias(port);
    if (this.ioTrace && (!this.ioPorts || this.ioPorts.has(port))) {
      this.ioTrace(`out ${port.toString(16).padStart(3, '0')}`
        + `${w === 16 ? 'w' : ' '} <- ${(value & (w === 16 ? 0xFFFF : 0xFF)).toString(16)}`);
    }
    return this.portOut_(port, value, w);
  }

  portOut_(port, value, w) {
    // portOut_, not portOut: the word has already been traced, and tracing the
    // two halves as well would treble every 16-bit line for no new fact.
    // Except the GF1's 16-bit data port: `out dx,ax` there is one register
    // write, and split into bytes its high half would land on the 8-bit
    // data port next door.
    if (w === 16 && this.sound !== 'none' && port === this.gus.base + 0x104) { this.gus.out(0x104, value, 16); return; }
    if (w === 16) { this.portOut_(port, value & 0xFF, 8); this.portOut_(port + 1, (value >> 8) & 0xFF, 8); return; }
    value &= 0xFF;
    // --- 8259 PICs ----------------------------------------------------------
    // ICW1 (bit 4 of a command-port write) opens an init sequence, during
    // which the next data-port writes are ICW2 (vector base), ICW3 unless
    // single mode, and ICW4 if ICW1 asked for one; outside of it a data-port
    // write is the mask register. EOI and the other OCW2/OCW3 commands are
    // dropped: nothing here has an in-service register to clear.
    if (port === 0x20 || port === 0xA0) {
      if (value & 0x10) { const i = port >> 7; this.pic.icw1[i] = value; this.pic.icw[i] = 2; }
      return;
    }
    if (port === 0x21 || port === 0xA1) {
      const i = port >> 7, step = this.pic.icw[i];
      if (step === 0) { this.pic.imr[i] = value; return; }
      if (step === 2) this.pic.base[i] = value & 0xF8;
      let next = step + 1;
      if (next === 3 && (this.pic.icw1[i] & 0x02)) next = 4;
      if (next === 4 && !(this.pic.icw1[i] & 0x01)) next = 0;
      this.pic.icw[i] = next > 4 ? 0 : next;
      return;
    }
    // --- Gravis Ultrasound ---------------------------------------------------
    // The GF1 takes what is its own. Three offsets are shared with the chips
    // at 0x220 and fall through after the GF1 has seen them: 0x2X0 is its
    // mix control and the SB Pro's first FM index port, 0x2X8/0x2X9 are the
    // AdLib timer pair on both cards.
    if (this.sound !== 'none') {
      const goff = port - this.gus.base;
      if (goff >= 0 && goff <= 0x107 && this.gus.out(goff, value, 8)
          && goff !== 0x000 && goff !== 0x008 && goff !== 0x009) return;
    }
    // --- Sound Blaster, base 0x220 -----------------------------------------
    // Reset: 1 then 0, and the card answers 0xAA on the read port. Everything
    // else is accepted and dropped, except the two commands a detection
    // routine reads an answer back from.
    if (port === 0x226) {
      if (this.sound === 'none') return;
      if (value & 1) this.sb.resetting = true;
      else if (this.sb.resetting) {
        this.sb.resetting = false;
        this.sb.out.length = 0;
        this.sb.shortWait = false;
        // A reset is the documented way out of high-speed mode, and it is the
        // only way out of a block this card is reloading off the 8237's
        // auto-init bit rather than off a DSP command (see sbRun). Nothing
        // else here touches a transfer in flight, deliberately -- that is
        // pre-existing behaviour and no program in the corpus depends on a
        // reset ending an ordinary block.
        if (this.sb.hsAuto) { this.sb.hsAuto = false; this.sb.pending = false; }
        this.sb.out.push(0xAA);
        this.sb.detects++;
      }
      return;
    }
    if (port === 0x22C) { this.sbCommand(value); return; }
    // The FM chip: 0x388 selects a register, 0x389 writes it; the synthesis
    // is tools/toyvm/opl.js, reached through the mixer in audio.js.
    if (port === 0x388 || port === 0x228 || port === 0x220 || port === 0x222) { this.adlibIndex = value; return; }
    if (port === 0x389 || port === 0x229 || port === 0x221 || port === 0x223) { this.adlibWrite(value); return; }
    // The mixer. Every register reads back what was written, except the
    // three an SB16 driver reads to learn the card's wiring: see sbMixerRead.
    if (port === 0x224) { this.sb.mixerIndex = value; return; }
    if (port === 0x225) {
      const i = this.sb.mixerIndex;
      if (i === 0x00) this.sb.mixer.fill(0);                       // mixer reset
      else if (i !== 0x80 && i !== 0x81 && i !== 0x82) this.sb.mixer[i] = value;
      return;
    }
    // The speaker: bit 0 gates PIT channel 2 into it, bit 1 is its data line.
    if (port === 0x61) {
      const was = this.port61;
      this.port61 = value;
      if ((was ^ value) & 3) this.speakerChanged();
      return;
    }
    // The DMA controllers (0x00-0x0F, 0xC0-0xDF) and their page registers.
    if (port <= 0x0F || (port >= 0x80 && port <= 0x8F) || (port >= 0xC0 && port <= 0xDF)) {
      if (this.audio.dma.write(port, value)) { this.sbDmaWritten(); return; }
    }
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
      // Channel 2 is the speaker's pitch. A complete reload (or a one-byte
      // one) changes the note; the low half of a two-byte reload does not
      // yet.
      if (ch === 2 && p.pending[ch] === 0 && (this.port61 & 2)) this.speakerChanged();
      return;
    }
    if (port === 0x3C8) { this.dacWriteIndex = value; this.dacSubIndex = 0; return; }
    if (port === 0x3C7) { this.dacWriteIndex = value; this.dacSubIndex = 0; return; }
    if (port === 0x3C9) {
      this.dacWrites++;
      this.palette[this.dacWriteIndex * 3 + this.dacSubIndex] = value & 0x3F;
      if (++this.dacSubIndex === 3) { this.dacSubIndex = 0; this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF; }
      return;
    }
    const v = this.vga;
    // Index/data pairs. A write to the index port with a 16-bit OUT carries
    // the data in AH, and the recursion at the top of this function has
    // already split that into two 8-bit writes, so both spellings land here.
    switch (port) {
      case 0x3C4: v.seqIndex = value & 0x0F; return;
      case 0x3C5:
        // The Trident bank register. The value carries the bank exclusive-ORed
        // with 2, which is not a quirk worth hiding: a driver that writes 3
        // means bank 1, and reading the register back has to agree.
        if (this.svga === 'trident' && v.seqIndex === 0x0E) {
          this.svgaSetBank((value ^ 0x02) & 0x0F);
          return;
        }
        this.vgaSeqWrite(v.seqIndex, value); return;
      case 0x3CE: v.gcIndex = value & 0x0F; return;
      case 0x3CF:
        v.gc[v.gcIndex] = value;
        // Miscellaneous and Mode between them say whether A000 is a picture and
        // how deep it is, so a mode set done entirely in registers is picked up
        // here rather than only at INT 10h AH=00.
        if (v.gcIndex === GC_MISC || v.gcIndex === GC_MODE) {
          if (syncVgaMode(v, this.forceChained)) {
            this.log(`vga registers say ${v.bpp ? `${v.bpp}bpp graphics` : 'text'}`);
            this.vgaRechain(v.planar);
          }
        }
        // Every graphics register now feeds the write pipeline, so mirror the
        // whole file rather than picking out the two mode X happened to need.
        this.syncVga();
        return;
      case 0x3C0:
        // Index and data alternate through one port. The flip-flop is the
        // VM's when one is attached, because the 3DAh read that resets it
        // no longer reaches the host (see portIn_).
        if (this.getAttrFlip() === 0) { v.attrIndex = value & 0x1F; this.setAttrFlip(1); }
        else { v.attr[v.attrIndex] = value; this.setAttrFlip(0); }
        return;
      case 0x3D4: case 0x3B4: v.crtcIndex = value & 0x1F; return;
      case 0x3D5: case 0x3B5:
        v.crtc[v.crtcIndex] = value;
        if (v.crtcIndex === CRTC_VRETRACE_END) v.vretrace = (value & 0x20) === 0;
        // In text mode the start address IS the displayed page, so the console
        // grid has to follow it (see setTextPage). In a graphics mode it is a
        // scroll or a page flip within A000 and vgaGeometry already reports it.
        if (v.bpp === 0 && (v.crtcIndex === CRTC_START_HI || v.crtcIndex === CRTC_START_LO)) {
          const start = ((v.crtc[CRTC_START_HI] << 8) | v.crtc[CRTC_START_LO]) & 0xFFFF;
          this.con.base = VRAM_TEXT + ((start * 2) & 0x7FFF);
        }
        return;
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
    // Keyed on the depth the REGISTERS report, not on the mode the BIOS was
    // asked for: a demo that set 256 colours with its own OUTs never told the
    // BIOS anything, and testing videoMode left it chained forever.
    const planar = !this.forceChained && v.bpp === 8 && !(value & 0x08);
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
  // Which text page the console grid lives on. Mode 3 has eight 4KB pages in
  // B800 and a demo animates by drawing into the one that is NOT being shown
  // and then pointing the CRTC start address at it. The console was pinned to
  // page 0, so such a program wrote a full screen and was photographed blank --
  // ant1.exe reported `crtc says start=2000` (2000 words = 4000 bytes = page 1)
  // with zero non-blank cells. Both routes to a page change land here: the BIOS
  // call (INT 10h AH=05h) and a direct write to CRTC 0x0C/0x0D.
  setTextPage(page) {
    const at = (page & 0x07) * 0x1000;
    this.con.base = VRAM_TEXT + at;
    this.mem[0x462] = page & 0x07;
    this.mem[0x44E] = at & 0xFF; this.mem[0x44F] = (at >> 8) & 0xFF;
    const v = this.vga, start = at >> 1;
    v.crtc[CRTC_START_HI] = (start >> 8) & 0xFF;
    v.crtc[CRTC_START_LO] = start & 0xFF;
  }

  // One character, through the cursor, with ANSI sequences interpreted rather
  // than printed. Everything that writes text -- DOS teletype, DOS string
  // print, the BIOS TTY call -- funnels here so there is one cursor and one
  // grid no matter which route a program picked.
  conPutc(b) {
    const c = this.con;
    c.written++;
    c.raw.push(b);
    if (this.stopText) this.conWatch(b);
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

  // Watch the console for a string and stop the run the moment it is complete.
  //
  // Almost every remaining failure in this corpus announces itself in text --
  // "failed to load MSE", "Runtime error 200", "MIDAS Error: ..." -- and the
  // question that follows is always "what did memory look like when that was
  // printed". Neither existing answer works: --dump and --disasm run at exit,
  // by which time the buffer that held the failing code has been freed and
  // handed out again, and --dispatches=N is a bisection by hand against a
  // number that moves whenever anything upstream changes.
  //
  // Matching is on a rolling tail rather than the whole console, so it costs
  // one string of the pattern's length and works on a screen that has already
  // scrolled. It is off unless `stopText` is set.
  conWatch(b) {
    this.conTail = (this.conTail + String.fromCharCode(b)).slice(-this.stopText.length);
    if (this.conTail === this.stopText) this.stopHit = true;
  }

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
    const ah = (r.get('ax') >> 8) & 0xFF;
    const ok = this.serviceCall(vec, r);
    // The function, not just the vector. `int 21h x9` says nothing about which
    // DOS call is missing, and the whole point of counting these is to rank the
    // gaps: it was this histogram that named AH=4Bh (EXEC) as what stands
    // between four self-extracting demos and their payload.
    if (!ok) {
      const key = `${vec.toString(16).padStart(2, '0')}:${ah.toString(16).padStart(2, '0')}`;
      this.unhandledFn.set(key, (this.unhandledFn.get(key) || 0) + 1);
    }
    return ok;
  }

  serviceCall(vec, r) {
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
      // The equipment word and the conventional-memory size, the two things a
      // program asks the BIOS before it asks DOS for anything. ANGEL.EXE
      // refuses to start with "Not enough memory ! You'll need 538 Kb" purely
      // because INT 12h was answering nothing.
      case 0x11:
        r.set('ax', this.mem[0x410] | (this.mem[0x411] << 8));
        return true;
      case 0x12:
        r.set('ax', this.mem[0x413] | (this.mem[0x414] << 8));
        return true;
      // A CPU fault nobody hooked. On a real machine DOS points these vectors
      // at a routine that prints a message and ABORTS the program, and doing
      // exactly that here was a net loss, measured on the corpus:
      //
      //   JULTRO.EXE   hang -> "Divide overflow" at 5ab:1ff   (still 0 px)
      //   cw2.com      30659 px -> 0 px
      //
      // Because the divisor being zero is usually OUR bug, not the program's.
      // cw2.com runs on real hardware without faulting at all; something
      // upstream in this emulator hands it a zero it should never have seen.
      // Applying correct DOS semantics to an incorrect CPU state turns a demo
      // that was rendering into a dead one, and trading a working picture for a
      // better diagnostic on a program that draws nothing either way is a bad
      // trade.
      //
      // Aborting after a REPEAT count was tried too, and catches nothing here:
      // JULTRO faults exactly once and then spins somewhere else entirely, so
      // no threshold ever fires. That left the abort as machinery with no
      // beneficiary, so all that remains is the part that earned its place --
      // naming the fault and where it happened. The behaviour is unchanged from
      // before any of this (skip the instruction, carry on); what is new is
      // that the run says so afterwards.
      //
      // This is how JULTRO's divide was found at all: its screen is blank, its
      // stuck address is 5ab:8c, and nothing connected the two until the fault
      // at 5ab:1ff had a line of its own.
      case 0x00: case 0x04: case 0x06: case 0x0D: {
        // From the IRET frame, not from CS:IP -- by the time this runs the
        // guest is standing in the F000 stub, and reporting that address names
        // the emulator instead of the instruction that faulted.
        const at = `${FAULT_NAMES[vec]} at `
          + `${r.ret.cs.toString(16)}:${r.ret.ip.toString(16)}`;
        this.faults.set(at, (this.faults.get(at) || 0) + 1);
        return false;
      }
      case 0x15: return this.int15(ah, al, r);
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

  // Where one pixel lives, for the BIOS pixel calls. Null when the current mode
  // has no addressable pixel of its own -- a text mode, or a planar EGA mode,
  // whose pixel is spread across four planes and is not one shift of one byte.
  // Declining is the honest answer there: a wrong address would draw somewhere.
  pixelAddr(x, y) {
    const v = this.vga;
    if (v.cga) {
      const bpp = v.cga === 6 ? 1 : 2;
      const width = v.cga === 6 ? 640 : 320;
      if (x >= width || y >= 200) return null;
      const perByte = 8 / bpp;
      const row = VRAM_TEXT + ((y & 1) ? 0x2000 : 0) + (y >> 1) * 80;
      return {
        lin: row + Math.floor(x / perByte),
        shift: (perByte - 1 - (x % perByte)) * bpp,
        mask: (1 << bpp) - 1,
      };
    }
    if (v.bpp === 8 && !v.planar) {
      if (x >= 320 || y >= 200) return null;
      return { lin: VGA_BASE + y * 320 + x, shift: 0, mask: 0xFF };
    }
    return null;
  }

  // The DAC a VGA BIOS leaves behind for a mode that is not 256-colour: the
  // EGA's own 64 colours in entries 0-63. Text mode gets it as well as the
  // 16-colour graphics modes -- the DAC is a piece of hardware, not a property
  // of the mode, and mode 3h reads back the same 64 entries mode 12h does. The
  // text renderer here reaches its sixteen colours through CGA_DAC rather than
  // through this array, so loading it changes nothing that is drawn; what it
  // changes is what a program that reads the DAC back is told.
  loadTextDac() {
    this.palette.set(EGA_DAC);
  }

  int10(ah, al, r) {
    if (ah === 0x00) {
      // A BIOS mode set leaves any VESA mode. Keeping the VESA surface across
      // it is how AQUAPHOB.EXE's demo came out as its own setup screen in the
      // demo's new palette: the picture had moved back to the 64KB at A000
      // while the banks still held what the setup had drawn.
      this.vesa = { mode: 0, width: 0, height: 0, bpp: 0, bank: 0, start: 0 };
      this.videoMode = al & 0x7F;
      this.noteVideoMode();
      this.mem[0x449] = this.videoMode;
      this.setVideoBda();      // the CRTC port follows the mode: mono vs colour
      // Setting a mode clears the display and re-chains the planes -- a demo
      // that unchains does it AFTER asking the BIOS for mode 13h.
      resetVgaMode(this.vga, this.videoMode);
      this.setAttrFlip(0);                   // the VM's copy of the flip-flop too
      this.setTextPage(0);                   // a mode set always shows page 0
      this.syncVga();
      if (this.videoMode === 0x13) this.mem.fill(0, VGA_BASE, VGA_BASE + 320 * 200);
      if (this.vga.bpp === 4) {
        this.clearPlanes();
        this.palette.set(EGA_DAC);         // the EGA-compatible first 64 entries
      }
      // ...and the full 256 for a 256-colour mode. A program that sets its own
      // colours overwrites these immediately; one that does not is entitled to
      // the BIOS default rather than to 256 blacks.
      if (this.vga.bpp === 8) this.palette.set(VGA_DAC);
      // ...and a text mode gets the same 64 EGA entries a 16-colour graphics
      // mode does. A program that drops back to mode 3h and then reads the DAC
      // -- to fade the DOS prompt, or to save a palette it means to restore --
      // must not be told the card came up black.
      if (this.vga.bpp === 0) this.loadTextDac();
      // A CGA graphics mode clears its own buffer and reaches its four colours
      // through the same DAC everything else here does, so it needs the
      // EGA-compatible entries loaded for CGA_PALETTE to name anything.
      if (this.vga.cga) {
        this.mem.fill(0, VRAM_TEXT, VRAM_TEXT + 0x4000);
        this.palette.set(EGA_DAC);
      }
      this.log(`int10 set mode ${this.videoMode.toString(16)}h`);
      return true;
    }
    // Write and read one pixel. Slow enough that almost nothing uses it for a
    // whole screen -- and then DEMO5.EXE does, 5588 times per 60M dispatches
    // and nothing else, so with this missing it ran its entire budget and
    // photographed as a black CGA screen.
    //
    // AL is the colour (bit 7 XORs rather than replaces), CX the column, DX the
    // row, BH the page (ignored -- one page here).
    if (ah === 0x0C || ah === 0x0D) {
      const x = r.get('cx') & 0xFFFF, y = r.get('dx') & 0xFFFF;
      const at = this.pixelAddr(x, y);
      if (!at) { if (ah === 0x0D) r.set('ax', r.get('ax') & 0xFF00); return true; }
      const { lin, shift, mask } = at;
      if (ah === 0x0D) {
        r.set('ax', (r.get('ax') & 0xFF00) | ((this.mem[lin] >> shift) & mask));
        return true;
      }
      const c = al & mask;
      const was = this.mem[lin];
      this.mem[lin] = (al & 0x80)
        ? (was ^ (c << shift))
        : ((was & ~(mask << shift)) | (c << shift));
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
      const src = this.lin(r, 'es', r.get('dx'));
      for (let i = 0; i < 17; i++) this.vga.attr[i] = this.mem[(src + i) & 0xFFFFF] & 0x3F;
      return true;
    }
    if (ah === 0x10 && al === 0x07) {       // read one palette register
      r.set('bx', (r.get('bx') & 0xFF) | ((this.vga.attr[r.get('bx') & 0x1F]) << 8));
      return true;
    }
    if (ah === 0x10 && al === 0x10) {       // set one DAC register
      this.dacWrites++;
      const at = (r.get('bx') & 0xFF) * 3, cx = r.get('cx'), dx = r.get('dx');
      this.palette[at] = (dx >> 8) & 0x3F;
      this.palette[at + 1] = (cx >> 8) & 0x3F;
      this.palette[at + 2] = cx & 0x3F;
      return true;
    }
    if (ah === 0x10 && al === 0x12) {       // set block of DAC registers
      const first = r.get('bx') & 0xFFFF, count = r.get('cx') & 0xFFFF;
      const src = this.lin(r, 'es', r.get('dx'));
      this.dacWrites += count;
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
      const dst = this.lin(r, 'es', r.get('dx'));
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
    if (ah === 0x05) {                              // active display page
      this.setTextPage(al & 0x07);
      return true;
    }
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
    if (ah === 0x4F) return this.vesaCall(al, r);
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

  // VBE, the VESA BIOS Extension: INT 10h AH=4Fh.
  //
  // Version 1.2 and banked only, which is what the corpus asks for. A 1995 demo
  // asks AX=4F00 first and falls back to poking a chipset it has guessed at when
  // that fails -- AQUAPHOB.EXE probes Video7, Ahead and Oak in turn and then
  // sets mode 5Ch, a Trident number, on a machine that is not a Trident. Saying
  // "no VBE" is what sends it down that path.
  //
  // The picture lives at isa.VESA_FB and the guest sees 64KB of it at a time
  // through the window at A000, exactly as the hardware works. Nothing about the
  // emulated memory has to change for that: the window is copied in and out on
  // each bank switch, which is a 64KB move a handful of times a frame.
  //
  // AL is the function; every reply is AX=004Fh for "supported, succeeded" and
  // anything else for "not supported", which is the presence test too.
  // The census wrapper. Records what was asked and whether it was granted --
  // "granted" being AX=004Fh on the way out, which is the only answer a caller
  // reads. Aggregated by (function, mode), so the cost is one Map entry per
  // distinct question however many times it is repeated.
  vesaCall(al, r) {
    const raw = al === 0x01 ? (r.get('cx') & 0xFFFF)
      : al === 0x02 ? (r.get('bx') & 0xFFFF) : -1;
    const handled = this.vesaCallImpl(al, r);
    const key = `${al.toString(16).padStart(2, '0')}`
      + (raw >= 0 ? `:${(raw & 0x7FFF).toString(16)}${(raw & 0x4000) ? ':lfb' : ''}` : '');
    let e = this.vbeCalls.get(key);
    if (!e) { e = { n: 0, ok: 0 }; this.vbeCalls.set(key, e); }
    e.n++;
    if ((r.get('ax') & 0xFFFF) === 0x004F) e.ok++;
    return handled;
  }

  vesaCallImpl(al, r) {
    const m = this.mem;
    const ok = () => { r.set('ax', 0x004F); return true; };
    if (al === 0x00) {
      const at = ((r.get('es') << 4) + r.get('di')) & 0xFFFFF;
      m.fill(0, at, at + 0x100);
      for (let i = 0; i < 4; i++) m[at + i] = 'VESA'.charCodeAt(i);
      m[at + 4] = 0x02; m[at + 5] = 0x01;             // VBE 1.2
      // The OEM string, the mode list and the memory size. The mode list is a
      // word array ending in FFFFh, and it and the string go in the reserved
      // tail of the block the caller gave us -- there is nowhere else that is
      // guaranteed to be the caller's memory.
      const oem = at + 0x100 - 0x40;
      const name = 'toyvm VBE';
      for (let i = 0; i < name.length; i++) m[oem + i] = name.charCodeAt(i);
      const list = oem + 0x20;
      VESA_MODES.forEach(([mode], i) => {
        m[list + i * 2] = mode & 0xFF; m[list + i * 2 + 1] = mode >> 8;
      });
      m[list + VESA_MODES.length * 2] = 0xFF;
      m[list + VESA_MODES.length * 2 + 1] = 0xFF;
      const ptr = (dst, lin) => {
        const seg = (lin >> 4) & 0xFFFF, off = lin & 0xF;
        m[dst] = off & 0xFF; m[dst + 1] = off >> 8;
        m[dst + 2] = seg & 0xFF; m[dst + 3] = seg >> 8;
      };
      ptr(at + 6, oem);
      ptr(at + 14, list);
      const kb64 = isa.VESA_FB_SIZE >> 16;
      m[at + 18] = kb64 & 0xFF; m[at + 19] = kb64 >> 8;
      return ok();
    }
    if (al === 0x01) {
      // The linear-framebuffer bit. We have no LFB -- the picture lives outside
      // the guest's address space and is reached through the window at A000 --
      // so a request for one is refused rather than answered with a banked mode
      // the caller then writes to a physical address we never mapped.
      if (r.get('cx') & 0x4000) return true;
      const mode = r.get('cx') & 0x7FFF;
      const found = VESA_MODES.find(([n]) => n === mode);
      if (!found) return true;                        // AX unchanged: not supported
      const [, w, h, bpp] = found;
      const bytes = vbeBytes(bpp);
      const at = ((r.get('es') << 4) + r.get('di')) & 0xFFFFF;
      m.fill(0, at, at + 0x100);
      const w16 = (off, v) => { m[at + off] = v & 0xFF; m[at + off + 1] = (v >> 8) & 0xFF; };
      // ModeAttributes: supported, colour, graphics, and the BIOS supports the
      // mode's own output functions. No bit 7: this is a banked mode with no
      // linear frame buffer, which is the whole point of the window below.
      w16(0x00, 0x001B);
      m[0x02 + at] = 0x07;                            // window A: exists, readable, writable
      m[0x03 + at] = 0x00;                            // window B: none
      w16(0x04, 64);                                  // granularity, KB
      w16(0x06, 64);                                  // window size, KB
      w16(0x08, 0xA000);                              // window A segment
      w16(0x0A, 0x0000);
      // The window-positioning far call. A program may use it instead of
      // AX=4F05, and CHROME.EXE does, so this has to be an address that really
      // moves the window: the eight bytes installIvt plants below the PSP.
      w16(0x0C, VESA_WIN_OFF); w16(0x0E, VESA_WIN_SEG);
      w16(0x10, w * bytes);                           // bytes per scan line
      w16(0x12, w); w16(0x14, h);
      m[at + 0x16] = 8; m[at + 0x17] = 16;            // character cell
      m[at + 0x18] = 1;                               // planes
      m[at + 0x19] = bpp;                             // bits per pixel
      m[at + 0x1A] = 1;                               // banks
      // Memory model: 4 is packed pixel (one index per byte, through the DAC),
      // 6 is direct colour (the pixel carries its own RGB and the DAC is not
      // in the path). A program that reads this byte and finds 4 on a 24bpp
      // mode will go looking for a palette that does not exist.
      m[at + 0x1B] = bpp > 8 ? 6 : 4;
      m[at + 0x1C] = 1;                               // bank size, 1 = 64KB units
      m[at + 0x1D] = Math.max(1, (isa.VESA_FB_SIZE / (w * h * bytes)) | 0);
      if (bpp > 8) {
        // The direct-colour fields, VBE 1.2 offsets 0x1F..0x26: size and least
        // significant bit position of each channel. 15bpp is 5-5-5 with the top
        // bit unused, 16bpp is 5-6-5, and 24bpp is 8-8-8 with blue lowest --
        // which is what makes the byte order in memory blue, green, red.
        const lay = bpp === 15 ? [5, 10, 5, 5, 5, 0, 1, 15]
          : bpp === 16 ? [5, 11, 6, 5, 5, 0, 0, 0]
            : [8, 16, 8, 8, 8, 0, 0, 0];
        for (let i = 0; i < 8; i++) m[at + 0x1F + i] = lay[i];
      }
      return ok();
    }
    if (al === 0x02) {
      // Same refusal as 4F01: bit 14 asks for a linear frame buffer and there
      // is no address the guest could write it through.
      if (r.get('bx') & 0x4000) return true;
      const mode = r.get('bx') & 0x7FFF;
      const found = VESA_MODES.find(([n]) => n === mode);
      if (!found) return true;
      const [, w, h, bpp] = found;
      this.vesa = { mode, width: w, height: h, bpp, bank: 0, start: 0 };
      this.videoMode = 0x13;             // a 256-colour graphics mode, for the BDA
      this.noteVideoMode();
      m[0x449] = mode & 0xFF;
      resetVgaMode(this.vga, 0x13);
      this.palette.set(VGA_DAC);
      this.syncVga();
      m.fill(0, VGA_BASE, VGA_BASE + 0x10000);
      m.fill(0, isa.VESA_FB, isa.VESA_FB + isa.VESA_FB_SIZE);
      return ok();
    }
    if (al === 0x03) {
      r.set('bx', this.vesa.mode);
      return ok();
    }
    // AX=4F07: which pixel of the picture the top left of the screen shows.
    // A demo uses it to page-flip or to pan, and CHROME.EXE calls it with
    // (0,0) immediately after setting its mode -- so it is not optional
    // decoration: leaving AX unchanged there told the program its card had
    // refused a call every VBE 1.2 card answers, and it went off the rails.
    //
    // This is a real offset, not an acknowledgement: the reader takes the
    // surface's `start` from here, so a program that pans sees the picture
    // move. A start that would run the visible window off the end of the
    // 1MB picture is refused rather than clamped, which is the honest answer
    // to "have you got a second page" on a card that has not.
    if (al === 0x07) {
      const v = this.vesa;
      if (!v.mode) return true;
      const bl = r.get('bx') & 0xFF;
      const bytes = vbeBytes(v.bpp);
      const pitch = v.width * bytes;
      if (bl === 0x01) {
        const start = v.start || 0;
        r.set('dx', (start / pitch) | 0);
        r.set('cx', ((start % pitch) / bytes) | 0);
        return ok();
      }
      if (bl !== 0x00 && bl !== 0x80) return true;
      const start = (r.get('dx') & 0xFFFF) * pitch + (r.get('cx') & 0xFFFF) * bytes;
      if (start + v.height * pitch > isa.VESA_FB_SIZE) return true;
      v.start = start;
      return ok();
    }
    if (al === 0x05) {
      const bh = (r.get('bx') >> 8) & 0xFF;
      if ((r.get('bx') & 0xFF) > 1) return true;      // window B: we have none
      if (bh === 0x01) { r.set('dx', this.vesa.bank); return ok(); }
      if (bh !== 0x00) return true;
      this.vesaBank(r.get('dx') & 0xFFFF);
      return ok();
    }
    return false;
  }

  // Move the guest's 64KB window onto another part of the picture.
  //
  // The window is real memory at A000 that the guest reads and writes directly,
  // so moving it is a copy each way: what it wrote goes back to the picture,
  // and the part it is about to see comes forward. Doing it this way is what
  // lets the compiled code keep storing to A000 with no idea any of this is
  // happening.
  vesaBank(bank) {
    const v = this.vesa;
    if (!v.mode || bank === v.bank) return;
    this.vesaFlush();
    v.bank = bank;
    const from = isa.VESA_FB + bank * 0x10000;
    if (from + 0x10000 <= isa.VESA_FB + isa.VESA_FB_SIZE) {
      this.mem.copyWithin(VGA_BASE, from, from + 0x10000);
    } else {
      this.mem.fill(0, VGA_BASE, VGA_BASE + 0x10000);
    }
  }

  // Write the window back to the picture. Also what anyone reading the screen
  // has to call first: the most recently drawn bank is the one still sitting in
  // the window, and it is the only one not yet in the framebuffer.
  vesaFlush() {
    const v = this.vesa;
    if (!v.mode) return;
    const to = isa.VESA_FB + v.bank * 0x10000;
    if (to + 0x10000 > isa.VESA_FB + isa.VESA_FB_SIZE) return;
    this.mem.copyWithin(to, VGA_BASE, VGA_BASE + 0x10000);
  }

  // Page the 64KB window at A000 onto another part of video memory, the way an
  // SVGA of this era does. Same storage and same trick as the VESA window --
  // the picture lives outside the guest's address space and the window is a
  // copy -- so compiled code goes on storing to A000 knowing nothing about it.
  // A card with 1MB has sixteen banks; a write past the end reads as blank
  // rather than wrapping, which is what lets a program size the memory.
  svgaSetBank(bank) {
    if (bank === this.svgaBank) return;
    const was = isa.VESA_FB + this.svgaBank * 0x10000;
    if (was + 0x10000 <= isa.VESA_FB + isa.VESA_FB_SIZE) {
      this.mem.copyWithin(was, VGA_BASE, VGA_BASE + 0x10000);
    }
    this.svgaBank = bank;
    const now = isa.VESA_FB + bank * 0x10000;
    if (now + 0x10000 <= isa.VESA_FB + isa.VESA_FB_SIZE) {
      this.mem.copyWithin(VGA_BASE, now, now + 0x10000);
    } else {
      this.mem.fill(0, VGA_BASE, VGA_BASE + 0x10000);
    }
  }

  // The BIOS system services. Only the timing half matters here: AH=86h is a
  // delay of CX:DX microseconds and three programs spend a thousand calls in
  // it, so declining it left them measuring an elapsed time that never moved.
  //
  // The wait is performed by MOVING THE CLOCK, not by burning guest work. Guest
  // time is billed against dispatches (see setClock), and a program asking the
  // BIOS to wait is explicitly asking not to spend any -- so advancing the tick
  // phase by the microseconds requested is both what the caller observes and
  // the only version that costs nothing.
  int15(ah, al, r) {
    const US_PER_TICK = 1000000 / 18.2065;
    switch (ah) {
      case 0x86: {
        const us = ((r.get('cx') & 0xFFFF) * 65536) + (r.get('dx') & 0xFFFF);
        this.setClock(this.pit.phase + us / US_PER_TICK);
        r.setResultCf(false);
        return true;
      }
      // Set (AL=00h) or cancel (AL=01h) the event wait: a flag byte at ES:BX
      // gets bit 7 set once CX:DX microseconds have gone by. Nothing here runs
      // between the call and the caller's next instruction, so the wait is
      // already over -- set the byte and move the clock, same as AH=86h.
      case 0x83: {
        if ((al & 0xFF) === 0x01) { r.setResultCf(false); return true; }
        const us = ((r.get('cx') & 0xFFFF) * 65536) + (r.get('dx') & 0xFFFF);
        this.setClock(this.pit.phase + us / US_PER_TICK);
        const at = this.lin(r, 'es', r.get('bx'));
        this.mem[at] |= 0x80;
        r.setResultCf(false);
        return true;
      }
      // Extended memory past the first megabyte, in KB. The XMS handler owns
      // that pool, so answer with what it will actually hand out.
      case 0x88: r.set('ax', this.xmsFreeKb()); r.setResultCf(false); return true;
      default: return false;
    }
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
      this.syncKbBda();
      r.set('ax', ((k.ah & 0xFF) << 8) | (k.al & 0xFF));
      return true;
    }
    if (ah === 0x01 || ah === 0x11) {
      this.autoKeyPoll();
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

  // Every DOS call, with one piece of bookkeeping wrapped around it: the error
  // code AH=59h will be asked for later. Every failing path in here already
  // sets CF and puts its code in AX, so recording it is a matter of watching
  // the CF write rather than editing a dozen call sites -- and it stays correct
  // when a new one is added.
  int21(ah, al, r) {
    this.pspSaveStack(ah, r);
    if (ah !== 0x59) {
      const setCf = r.setResultCf;
      r.setResultCf = (on) => {
        if (on) this.lastError = r.get('ax') & 0xFFFF;
        else if (ah !== 0x33 && ah !== 0x58) this.lastError = 0;
        return setCf.call(r, on);
      };
      try { return this.int21Call(ah, al, r); } finally { r.setResultCf = setCf; }
    }
    return this.int21Call(ah, al, r);
  }

  // --- the memory pool -----------------------------------------------------
  // `allocTop` is the frontier: everything above it up to the ceiling has never
  // been handed out. That alone was the whole allocator, which made AH=49h a
  // no-op and turned the pool into a one-way ratchet. BLIQ.EXE is where that
  // stops working -- its Pascal runtime allocates and frees twenty-odd blocks
  // while starting MIDAS, and with nothing coming back it hits the ceiling and
  // prints "MIDAS Error: Out of conventional memory" on a machine that has
  // 400KB free. So blocks below the frontier that have been given back live in
  // `memFree`, sorted and coalesced, and a request looks there first.
  //
  // Every block costs one paragraph more than it hands out, because the block
  // is preceded by its arena header -- the MCB. That header is not bookkeeping
  // we could keep on this side: it is guest memory, at a place programs know,
  // and they write to it. A loader hands a subfile its own PSP with AH=55h and
  // then re-stamps the owner word of the block the subfile lives in, so that
  // the subfile's own AH=4Ch gives the image back. BLIQ.EXE does exactly that
  // (`--watch=1673:0:16` catches `1684:4b wrote 16731-16732`, the owner word of
  // the block at 1674), six times, and with the owner kept only on this side
  // none of the six images ever came back: the machine filled to 0x9F00 and
  // MIDAS could not get the 0x38 paragraphs it wanted.
  //
  // Without the header paragraph the guest's write also lands on whatever block
  // happens to end there -- 1673 was the last paragraph of a live block -- so
  // modelling this stops a corruption as well as a leak.
  //
  // The chain itself is laid down by installArena/mcbSync below.
  memLargest() {
    let best = DEFAULT_ALLOC_TOP - this.allocTop;
    for (const b of this.memFree) if (b.size > best) best = b.size;
    return Math.max(0, best - 1);
  }

  // Lay down the arena header for the block whose data starts at `seg`.
  mcbWrite(seg, owner, size, last = false) {
    const at = (seg - 1) << 4;
    this.mem[at] = last ? 0x5A : 0x4D;          // 'Z' ends the chain, 'M' does not
    this.mem[at + 1] = owner & 0xFF;
    this.mem[at + 2] = (owner >> 8) & 0xFF;
    this.mem[at + 3] = size & 0xFF;
    this.mem[at + 4] = (size >> 8) & 0xFF;
    for (let i = 5; i < 16; i++) this.mem[at + i] = 0;
  }

  // Who owns the block whose data starts at `seg`, as the guest sees it. This
  // is the authority, not the map: the map records who asked, and a program is
  // free to hand a block on to someone else by writing here.
  mcbOwner(seg) {
    const at = (seg - 1) << 4;
    return this.mem[at + 1] | (this.mem[at + 2] << 8);
  }

  // The whole arena as a chain, walkable from one header to the next the way
  // MEM.EXE walks it: environment, then everything DOS is holding below the
  // program, then the program, then whatever is above it.
  //
  // The middle rung is the one that has to be right and is easy to get wrong.
  // With the load segment a machine option (see pspSeg) the gap between the
  // environment block and the PSP is no longer a fixed 0x40 paragraphs -- at
  // PSP 0x0D00 it is 49KB -- and if that gap carries no header the chain has a
  // hole in it, while if it carries a header owned by 0 it reads as FREE and a
  // program adding up the free blocks is told it has 49KB more than it does.
  // Owner 8 is what a real DOS writes there: the kernel and its drivers.
  //
  // Above the PSP the allocator is the authority and this only fills in what
  // the allocator does not write headers for -- the program's own block, the
  // regions handed back to `memFree`, and the frontier -- so a block whose
  // owner word the guest has re-stamped (BLIQ.EXE does, six times) keeps it.
  installArena() {
    const psp = this.pspSeg;
    // The environment block. DOS gives it to the program, so the program is
    // the owner: a program that frees its own environment (a TSR shrinking its
    // footprint does) is freeing a block it holds.
    this.mcbWrite(ENV_SEG, psp, ENV_PARAS);
    // DOS and its drivers: everything from the end of the environment to the
    // paragraph below the PSP. At the default load address that is 0x3F
    // paragraphs; at 0x0D00 it is 0xC3F.
    const sys = ENV_SEG + ENV_PARAS + 1;
    this.mcbWrite(sys, MCB_SYSTEM, psp - 1 - sys);
    // The list of lists, so a program has somewhere to start the walk from.
    const lol = (LOL_SEG << 4) + LOL_OFF;
    this.mem[lol - 2] = MCB_FIRST & 0xFF;
    this.mem[lol - 1] = (MCB_FIRST >> 8) & 0xFF;
    this.mcbSync();
  }

  // Re-lay the part of the chain above the PSP. Called wherever the allocator
  // moves a boundary, which is the only way any of these numbers change.
  mcbSync() {
    const psp = this.pspSeg;
    const items = [];
    for (const [seg, size] of this.memBlocks) items.push({ seg, size, own: this.mcbOwner(seg) });
    // A `memFree` entry is a raw region, header paragraph included; as a block
    // it is one paragraph smaller and owned by nobody.
    for (const b of this.memFree) items.push({ seg: b.seg + 1, size: b.size - 1, own: 0 });
    if (this.allocTop < DEFAULT_ALLOC_TOP) {
      items.push({ seg: this.allocTop + 1, size: DEFAULT_ALLOC_TOP - this.allocTop - 1, own: 0 });
    }
    items.sort((a, b) => a.seg - b.seg);
    const chain = [];
    let cur = psp;
    for (const it of items) {
      if (it.seg - 1 < cur) continue;           // overlaps what is already laid; skip it
      if (it.seg - 1 > cur) chain.push({ seg: cur, size: it.seg - 1 - cur, own: psp });
      chain.push(it);
      cur = it.seg + it.size;
    }
    if (cur < DEFAULT_ALLOC_TOP) chain.push({ seg: cur, size: DEFAULT_ALLOC_TOP - cur, own: psp });
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      this.mcbWrite(c.seg, c.own, c.size, i === chain.length - 1);
    }
  }

  memAlloc(want) {
    const need = want + 1;                      // ...plus the arena header
    for (let i = 0; i < this.memFree.length; i++) {
      const b = this.memFree[i];
      if (b.size < need) continue;
      const seg = b.seg + 1;
      if (b.size === need) this.memFree.splice(i, 1);
      else { b.seg += need; b.size -= need; }
      this.memBlocks.set(seg, want);
      this.mcbWrite(seg, this.curPsp, want);
      return seg;
    }
    if (DEFAULT_ALLOC_TOP - this.allocTop < need) return null;
    const seg = this.allocTop + 1;
    this.allocTop += need;
    this.memBlocks.set(seg, want);
    this.mcbWrite(seg, this.curPsp, want);
    return seg;
  }

  // Give back an allocated block: its header goes with it.
  memReleaseBlock(seg, size) {
    this.memRelease(seg - 1, size + 1);
  }

  // Give back a raw region -- header paragraph included, since whatever gets
  // allocated out of it next will lay down its own. The tail a resize splits
  // off is a region, not a block, which is why this stayed the primitive.
  memRelease(seg, size) {
    if (!size) return;
    // Give it straight back to the frontier when it is the top block, so a
    // program that allocates and frees in LIFO order never grows the list.
    if (seg + size === this.allocTop) { this.allocTop = seg; this.memTrim(); return; }
    this.memFree.push({ seg, size });
    this.memFree.sort((a, b) => a.seg - b.seg);
    for (let i = 0; i < this.memFree.length - 1; ) {
      const a = this.memFree[i], b = this.memFree[i + 1];
      if (a.seg + a.size === b.seg) { a.size += b.size; this.memFree.splice(i + 1, 1); }
      else i++;
    }
    this.memTrim();
  }

  // Anything free that touches the frontier is not a block, it is frontier.
  // This also cleans up after EXEC and the terminate path, which move the
  // frontier outright rather than through alloc and free.
  memTrim() {
    for (let done = false; !done; ) {
      done = true;
      for (let i = 0; i < this.memFree.length; i++) {
        const b = this.memFree[i];
        if (b.seg >= this.allocTop) { this.memFree.splice(i, 1); done = false; break; }
        if (b.seg + b.size >= this.allocTop) { this.allocTop = b.seg; this.memFree.splice(i, 1); done = false; break; }
      }
    }
  }

  // PSP+2Eh -- "SS:SP on entry to the last INT 21h call". DOS writes it on
  // every call from its own INT 21h prologue, before it switches to an internal
  // stack, and it is not bookkeeping nobody reads: the terminate path is how a
  // program that ended gives its parent's stack back, and the only copy of that
  // stack pointer is this field. STHINTRO.EXE is the case. Its loader is a
  // hand-rolled EXEC -- AH=55h for a child PSP, the terminate vector poked into
  // it at +0Ah, then `mov ss,[020f] / mov sp,[0211]` onto the *child's* stack
  // and a far jump into the child -- so by the time the child calls AH=4Ch the
  // loader's own SS:SP exists nowhere but here. Its terminate handler at
  // 110:09c1 is `xor ax,ax / ret`: a NEAR ret, popping the return address of
  // the loader's own `call spawn`. With the child's stack still loaded that ret
  // pops whatever the child left and lands at 0000:0000.
  //
  // The saved SP is the one the INT handler sees, so it includes the six bytes
  // the interrupt pushed; the terminate path adds them back the way DOS's IRET
  // out of the system call does.
  //
  // The exclusions are DOS's own: AH=50h/51h/62h/64h run on the caller's stack
  // rather than the internal one and never touch the field, and neither does
  // anything at or above AH=6Ch.
  //
  // What DOS keeps beside SS:SP is the caller's whole register set: its INT 21h
  // prologue pushes AX BX CX DX SI DI BP DS ES onto the user stack and only
  // then records the stack pointer, and the exit path pops all nine back before
  // it transfers. That is why a program resumed through INT 22h finds its data
  // segment where it left it -- STHINTRO's loader runs `dec word [0113]` two
  // instructions past the `ret`, and with DS still holding the child's 0398
  // instead of its own 01ae it decrements a word of somebody else's memory and
  // takes the wrong branch. We service the call from the host rather than on
  // the guest's stack, so the nine registers are held here, per PSP, instead of
  // in the 18 bytes below the saved SP where DOS puts them.
  pspSaveStack(ah, r) {
    if (ah === 0x50 || ah === 0x51 || ah === 0x62 || ah === 0x64 || ah >= 0x6C) return;
    const at = (this.curPsp << 4) + 0x2E;
    const ss = r.get('ss') & 0xFFFF, sp = (r.ret.sp - 6) & 0xFFFF;
    this.mem[at] = sp & 0xFF; this.mem[at + 1] = (sp >> 8) & 0xFF;
    this.mem[at + 2] = ss & 0xFF; this.mem[at + 3] = (ss >> 8) & 0xFF;
    const regs = {};
    for (const n of PSP_SAVED_REGS) regs[n] = r.get(n) & 0xFFFF;
    this.pspRegs.set(this.curPsp, regs);
  }

  // What that field holds for one PSP, already stepped past the IRET frame --
  // DOS's own IRET out of the system call consumes it -- together with the
  // registers saved alongside. Null when nothing has been saved there yet,
  // which is the ordinary top-level program whose PSP has no parent.
  pspSavedStack(psp) {
    const at = ((psp & 0xFFFF) << 4) + 0x2E;
    const sp = this.mem[at] | (this.mem[at + 1] << 8);
    const ss = this.mem[at + 2] | (this.mem[at + 3] << 8);
    if (!ss && !sp) return null;
    return { ss, sp: (sp + 6) & 0xFFFF, regs: this.pspRegs.get(psp & 0xFFFF) || null };
  }

  // The INT 22h address the current PSP carries at +0Ah, or null when nothing
  // has put one there. Kept apart from the exit path because it is a fact about
  // guest memory, not about exiting, and the sweep's --debug reads it too.
  pspTerminateVector() {
    const at = (this.curPsp << 4) + 0x0A;
    const ip = this.mem[at] | (this.mem[at + 1] << 8);
    const cs = this.mem[at + 2] | (this.mem[at + 3] << 8);
    return (cs || ip) ? { cs, ip } : null;
  }

  int21Call(ah, al, r) {
    switch (ah) {
      case 0x4C: case 0x00: case 0x31: {
        // Exit, and -- AH=31h -- exit keeping memory. That distinction matters
        // as soon as EXEC exists: CATWALK.EXE runs a music player that goes
        // resident and hooks the timer, then runs the demo itself. Forgetting
        // the player's block loaded the demo straight on top of it.
        const code = ah === 0x4C || ah === 0x31 ? al : 0;
        const keep = ah === 0x31 ? this.curPsp + (r.get('dx') & 0xFFFF) : 0;
        if (this.execStack.length) {
          const parent = this.execStack.pop();
          const leaving = this.curPsp;
          this.lastExitCode = code; this.lastExitType = ah === 0x31 ? 3 : 0;
          this.transfer = parent;
          // The first paragraph past what the child leaves resident. This,
          // not the parent's frontier, is what the next EXEC loads above: a
          // parent that never shrank its block has a frontier at the ceiling.
          let top = keep;
          if (keep) {
            // AH=31h keeps DX paragraphs of the PSP block -- and every block
            // the resident program took with AH=48h and never gave back. Those
            // sit above `keep`, because the child was loaded at the parent's
            // frontier, and they are the whole reason CATWALK.PLY goes
            // resident: 0x3c0 paragraphs of S3M patterns at a21 and 64KB of
            // samples at de2, both past its 0x635-paragraph image. With the
            // frontier dropped to `keep` alone, EXEC put CATWALK.TMP at psp
            // a20 and its unpacker wrote over the patterns; the player then
            // read a speed of 0xAB out of unpacked code and advanced one row
            // every 3.4 seconds (measured 2026-09-03 against DOSBox-X). The
            // frontier goes above the highest held block and the gaps between
            // them are free holes, which is what the MCB chain would say.
            const held = [...this.memBlocks].filter(([s]) => s - 1 >= keep).sort((a, b) => a[0] - b[0]);
            for (const [s, n] of held) top = Math.max(top, s + n);
            this.allocTop = Math.max(parent.allocTop, top);
            let cursor = keep;
            for (const [s, n] of held) {
              if (s - 1 > cursor) this.memRelease(cursor, s - 1 - cursor);
              cursor = Math.max(cursor, s + n);
            }
          } else {
            // AH=4Ch: the blocks the child owns go back, by MCB owner, the
            // way the terminate-vector path below does it. Left in the map
            // they would count as held on a later resident exit and hoist
            // the frontier over memory nobody holds.
            this.allocTop = parent.allocTop;
            for (const s of [...this.memBlocks.keys()]) {
              if (this.mcbOwner(s) !== leaving) continue;
              const size = this.memBlocks.get(s);
              this.memBlocks.delete(s);
              if (size !== undefined) this.memReleaseBlock(s, size);
            }
          }
          this.imageTop = Math.max(parent.imageTop, top);
          this.memTrim();
          this.curPsp = parent.psp;
          this.log(`child exited ${code}${keep ? `, resident to ${keep.toString(16)}` : ''};`
            + ` parent resumes at ${parent.cs.toString(16)}:${parent.ip.toString(16)}`);
          return true;
        }
        // No EXEC frame to pop, but that is not the same as "the run is over".
        // DOS does not end a program by ending it -- it far-jumps through the
        // terminate vector stored at PSP+0Ah, the INT 22h address, and only the
        // fact that COMMAND.COM puts its own address there makes an ordinary
        // exit look like the end of the world.
        //
        // ACME-BIG.EXE is a loader that does this by hand: it pokes 0110:044A
        // (its own overlay manager) into its PSP at +0Ah, calls AH=55h to make
        // a child PSP -- which copies that vector along with everything else --
        // and reads the next part of itself into it. When that part calls
        // AH=4Ch it means "I am done, resume the loader", and we were reading
        // it as "the machine stops". BLIQ.EXE is built the same way.
        //
        // The guard is exact rather than heuristic: we build a PSP with a zero
        // here and never write it ourselves, so a non-zero vector is a value
        // some guest deliberately stored. Every program that exits correctly
        // today has a zero there and still ends.
        const term = this.pspTerminateVector();
        if (term) {
          const leaving = this.curPsp;
          const parent = (this.mem[(this.curPsp << 4) + 0x16])
            | (this.mem[(this.curPsp << 4) + 0x17] << 8);
          this.lastExitCode = code; this.lastExitType = ah === 0x31 ? 3 : 0;
          this.log(`exit ${code} through the terminate vector at`
            + ` ${term.cs.toString(16)}:${term.ip.toString(16)}`);
          if (parent && parent !== this.curPsp) this.curPsp = parent;
          // AH=31h keeps DX paragraphs and hands the rest of the block back,
          // and that half is not optional: BLIQ.EXE gives its subfile the whole
          // remaining pool (0x9cc3 paragraphs), the subfile hooks INT 10h and
          // goes resident on 0x40 of them, and the loader immediately asks for
          // 0x37 more for the next one. Without the release that ask fails and
          // BLIQ prints "[ERROR]: Executing internal subfile...".
          if (keep) {
            this.allocTop = keep; this.imageTop = Math.max(this.imageTop, keep);
            for (const [s, n] of [...this.memBlocks]) {
              if (s >= keep) { this.memBlocks.delete(s); }
              // The block the resident program is standing in straddles `keep`,
              // and only its tail went back. Left at its original size it reads
              // as 629KB held at 0x23d with the frontier down at 0x27d --
              // invisible while nothing consults memBlocks to allocate, and a
              // 629KB false release the moment something frees it by owner.
              else if (s + n > keep) {
                this.memBlocks.set(s, keep - s);
                this.mcbWrite(s, this.mcbOwner(s), keep - s);
              }
            }
            this.memTrim();
          } else {
            // AH=4Ch, and DOS reads the owner field out of every MCB and frees
            // the ones belonging to the PSP that is exiting. Without that,
            // BLIQ.EXE's loader runs five subfiles through this vector and
            // never gets a byte back from any of them: by the time it wants
            // 0x38 paragraphs for MIDAS the machine is full to 0x9F00 and it
            // prints "MIDAS Error: Out of conventional memory" on a 636KB
            // machine. `keep` above is the AH=31h half of the same idea and
            // stays as it is -- a resident program's blocks are exactly the
            // ones that must survive.
            //
            // The owner comes out of the guest's MCB, which is the only copy.
            // The two agree until a program re-stamps a block onto someone
            // else, which is the whole point of the field and is how BLIQ's
            // loader arranges for a subfile to give its own image back.
            for (const s of [...this.memBlocks.keys()]) {
              if (this.mcbOwner(s) !== leaving) continue;
              const size = this.memBlocks.get(s);
              this.memBlocks.delete(s);
              if (size !== undefined) this.memReleaseBlock(s, size);
            }
          }
          // The stack goes back to the parent's. DOS restores SS:SP out of the
          // parent PSP's +2Eh field before it jumps through INT 22h -- see
          // pspSaveStack -- and that is the whole of what a hand-rolled EXEC
          // gets back, because it switched to the child's stack itself and kept
          // no copy. Without it STHINTRO.EXE's `xor ax,ax / ret` terminate
          // handler returns through the dead child's stack to 0000:0000.
          //
          // The registers saved with it come back too -- DOS pops the nine
          // words its prologue pushed -- so the parent finds DS and ES pointing
          // where they did at the call. With no saved frame (a top-level PSP
          // whose +16h names no parent) nothing is restored and the exiting
          // program's own SS:SP and segments carry through, which is what this
          // path did before and what every program already through it expects.
          const back = (parent && parent !== leaving) ? this.pspSavedStack(parent) : null;
          this.transfer = {
            cs: term.cs, ip: term.ip,
            ss: back ? back.ss : r.get('ss'), sp: back ? back.sp : r.ret.sp,
            ds: r.get('ds'), es: r.get('es'),
            ...(back && back.regs ? { regs: back.regs } : {}),
          };
          return true;
        }
        this.exited = true; this.exitCode = code;
        return true;
      }
      case 0x4D:                                // get child return code
        // AL is the code, AH is *how* it ended, and the second half is not
        // decoration: ANGEL.EXE's loader reads AH and skips freeing the child's
        // block when it is 3 (terminate-and-stay-resident). Answering 0 there
        // had it free the resident protected-mode helper it had just installed
        // and then load the next overlay straight on top of it, so the INT FCh
        // the demo makes next landed in the middle of an instruction.
        r.set('ax', ((this.lastExitType & 0xFF) << 8) | ((this.lastExitCode || 0) & 0xFF));
        r.setResultCf(false);
        return true;
      case 0x4B: {
        // EXEC. Four demos in this corpus are self-extractors: they unpack a
        // player and its data out of their own tail (see createFile) and then
        // ask DOS to run it. With this missing, CATWALK.EXE wrote its four
        // files and exited 0 with a black screen -- a complete run of a program
        // whose entire job is to start another one.
        if (al !== 0x00 && al !== 0x01) { r.setResultCf(true); r.set('ax', 1); return true; }

        // The command tail comes out of the parameter block at ES:BX. Read
        // before the image, because for a shell invocation it is what names the
        // program actually being run.
        const pb = this.lin(r, 'es', r.get('bx'));
        const tailOff = this.mem[pb + 2] | (this.mem[pb + 3] << 8);
        const tailSeg = this.mem[pb + 4] | (this.mem[pb + 5] << 8);
        const tail = ((tailSeg << 4) + tailOff) & 0xFFFFF;
        let tailStr = [...this.mem.subarray(tail + 1,
          tail + 1 + Math.min(this.mem[tail] || 0, 127))]
          .map((c) => String.fromCharCode(c)).join('');

        let name = this.guestPath(r);
        let img = this.readWholeFile(name);

        // `COMMAND.COM /C prog args`, which is the only thing anything here
        // ever asks a shell to do. We have no COMMAND.COM and there is no point
        // shipping one: a program that wants an interactive shell, a batch file
        // or an internal command still gets "file not found", which is honest.
        //
        // CYANIDE.EXE is the corpus's case and it needs the tail, not just the
        // redirect: it runs `/c 001.exe` and then `/c 002.exe go away you
        // hacker . . .`, and 002.EXE is checking for that argument. Without it
        // the part refuses with "Please run CYANIDE.EXE." -- which is exactly
        // what the sweep captured, from a program doing precisely what it was
        // built to do.
        if (!img && /(^|[\\/])COMMAND\.COM$/i.test(name)) {
          const m = /^\s*\/[Cc]\s+(\S+)\s*([\s\S]*)$/.exec(tailStr);
          if (m) {
            for (const cand of [m[1], `${m[1]}.EXE`, `${m[1]}.COM`]) {
              const got = this.readWholeFile(cand);
              if (got) {
                name = cand; img = got; tailStr = m[2] ? ` ${m[2]}` : '';
                // The shell we do not have, and the extensions we guessed past,
                // are not files this program failed to find. Leaving them in
                // the missed list reports a successful launch as a missing
                // COMMAND.COM, which is the opposite of what happened.
                this.filesMissed = this.filesMissed.filter(
                  (f) => !/(^|[\\/])COMMAND\.COM$/i.test(f) && f !== cand);
                break;
              }
            }
          }
        }
        if (!img) { r.setResultCf(true); r.set('ax', 2); return true; }   // not found

        // The child goes directly above the parent's IMAGE, not above the
        // parent's allocation: a loader stub declares max-alloc 0xFFFF, owns all
        // of memory and is expected to shrink itself (AH=4Ah) before it EXECs.
        // Placing the child above the parent's claim instead left CATWALK's
        // player with 60KB and it failed its first AH=48h.
        //
        // ...but above every block the parent has ALLOCATED since. A parent
        // that shrank and then took a block with AH=48h owns that block, and
        // DOS loads the child past it: DADEMO3.EXE shrinks to 160KB, takes 2KB
        // at 2811:0 for its resident player, and EXECs race.exe -- loaded at
        // 2810:0 it overwrote the player's instrument table, and the player
        // divided by a C2 speed of zero on the first note. A parent still
        // holding everything up to the ceiling is left as before: that is the
        // never-shrunk stub, and its allocation top says nothing about where
        // the child can go.
        const pspSeg = this.allocTop < DEFAULT_ALLOC_TOP
          ? Math.max(this.imageTop, this.allocTop) : this.imageTop;
        if (pspSeg + 0x1000 > DEFAULT_ALLOC_TOP) { r.setResultCf(true); r.set('ax', 8); return true; }
        const info = loadExe(this.mem, img, { loadSeg: pspSeg + 0x10, pspSeg });

        // The tail into the child's PSP, from the string rather than straight
        // out of the parameter block: a shell redirect above rewrote it, and the
        // child must see the arguments meant for IT and not the `/c prog` the
        // shell was handed.
        const n = Math.min(tailStr.length, 127);
        this.mem[(pspSeg << 4) + 0x80] = n;
        for (let i = 0; i < n; i++) {
          this.mem[(pspSeg << 4) + 0x81 + i] = tailStr.charCodeAt(i) & 0xFF;
        }
        this.mem[(pspSeg << 4) + 0x81 + n] = 0x0D;   // the tail's terminating CR
        this.mem[(pspSeg << 4) + 0x16] = this.curPsp & 0xFF;     // parent PSP
        this.mem[(pspSeg << 4) + 0x17] = (this.curPsp >> 8) & 0xFF;
        this.mem[(pspSeg << 4) + 0x2C] = ENV_SEG & 0xFF;         // same environment
        this.mem[(pspSeg << 4) + 0x2D] = (ENV_SEG >> 8) & 0xFF;
        this.log(`exec ${name} (${img.length} bytes) at psp ${pspSeg.toString(16)},`
          + ` entry ${info.cs.toString(16)}:${info.ip.toString(16)},`
          + ` tail "${tailStr}"`);

        if (al === 0x01) {                       // load, do not execute
          this.mem[pb + 0x0E] = info.sp & 0xFF; this.mem[pb + 0x0F] = (info.sp >> 8) & 0xFF;
          this.mem[pb + 0x10] = info.ss & 0xFF; this.mem[pb + 0x11] = (info.ss >> 8) & 0xFF;
          this.mem[pb + 0x12] = info.ip & 0xFF; this.mem[pb + 0x13] = (info.ip >> 8) & 0xFF;
          this.mem[pb + 0x14] = info.cs & 0xFF; this.mem[pb + 0x15] = (info.cs >> 8) & 0xFF;
          r.setResultCf(false);
          return true;
        }

        // Where the parent resumes. It resumes AFTER the INT 21h, which is the
        // address the IRET frame already holds -- run-dos applies this transfer
        // once it has finished that IRET, so the values it saves here are the
        // ones the parent had on the way in.
        this.execStack.push({
          cs: r.ret.cs, ip: r.ret.ip, ss: r.get('ss'), sp: r.ret.sp,
          ds: r.get('ds'), es: r.get('es'), ax: 0,
          allocTop: this.allocTop, imageTop: this.imageTop, psp: this.curPsp,
        });
        this.curPsp = pspSeg;
        this.allocTop = Math.min(DEFAULT_ALLOC_TOP, info.allocTop);
        this.memTrim();
        this.imageTop = info.minTop;
        this.transfer = {
          cs: info.cs, ip: info.ip, ss: info.ss, sp: info.sp,
          ds: info.ds, es: info.es,
        };
        r.setResultCf(false);
        return true;
      }
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
        let p = this.lin(r, 'ds', r.get('dx')), s = '';
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
        const at = this.lin(r, 'ds', r.get('dx'));
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
        const src = this.lin(r, 'ds', r.get('dx'));
        const f = this.files.get(h);
        if (h === 1 || h === 2) {
          for (let i = 0; i < n; i++) this.conPutc(this.mem[(src + i) & 0xFFFFF]);
        } else if (f && !f.device) {
          this.writeFile(f, src, n);
        }
        r.set('ax', n);
        r.setResultCf(false);
        return true;
      }
      // Get the PSP segment. BLIQ.EXE resizes its block, asks for its PSP and
      // prints "[ERROR]: Can not init file manager..." on the garbage it got
      // back -- a two-line call standing between it and the demo.
      case 0x51: case 0x62: r.set('bx', this.curPsp); r.setResultCf(false); return true;
      // Undocumented, and the only documented-by-use way to find the head of
      // the MCB chain: the word at ES:BX-2 is the segment of the first arena
      // header. MEM.EXE and every "how much memory is really free" routine
      // starts here. Re-laid on the way out so the walk sees the allocator's
      // current boundaries and not the ones it had at load time.
      case 0x52:
        this.mcbSync();
        r.set('es', LOL_SEG); r.set('bx', LOL_OFF);
        r.setResultCf(false);
        return true;
      // Set the current PSP. The pair to AH=51h, and real: a TSR that switches
      // the PSP to do file I/O on the foreground program's behalf and switches
      // it back is doing exactly this, and answering nothing left ANGEL.EXE and
      // ASSAULT.EXE with a PSP that was never theirs.
      case 0x50: this.curPsp = r.get('bx') & 0xFFFF; r.setResultCf(false); return true;
      // Create a new PSP at the segment in DX, by copying the current one. The
      // fields that must not be copied verbatim are the two at the top: the
      // segment's own size in paragraphs (offset 2) belongs to the new block.
      case 0x26: {
        const dst = (r.get('dx') & 0xFFFF) << 4, src = this.curPsp << 4;
        this.mem.copyWithin(dst, src, src + 256);
        r.setResultCf(false);
        return true;
      }
      // Parse a filename at DS:SI into the FCB at ES:DI. AL's bits say whether
      // to skip leading separators (bit 0) and whether to leave an absent name,
      // extension or drive alone (bits 1-3) rather than blanking them. Returns
      // AL=0 for a plain name, 1 if it contained a wildcard, 0xFF for a bad
      // drive, and DS:SI advanced past what was consumed.
      case 0x29: {
        const opt = al & 0xFF;
        let at = this.lin(r, 'ds', r.get('si'));
        const start = at;
        const fcb = this.lin(r, 'es', r.get('di'));
        const ch = () => this.mem[at];
        if (opt & 1) while (ch() === 0x20 || ch() === 0x09) at++;
        let drive = 0;
        if (this.mem[at + 1] === 0x3A) {                 // "C:"
          const d = String.fromCharCode(this.mem[at]).toUpperCase();
          if (d < 'A' || d > 'Z') { r.set('ax', (r.get('ax') & 0xFF00) | 0xFF); return true; }
          drive = d.charCodeAt(0) - 64;
          at += 2;
        }
        if (drive || !(opt & 2)) this.mem[fcb] = drive;
        // The name is 8 characters and the extension 3, both space-padded and
        // both stopping at a separator. "*" fills the rest of its field with
        // "?", which is what makes AL=1 mean "this one is a wildcard".
        const SEP = new Set([0x20, 0x09, 0x2E, 0x3B, 0x2C, 0x3D, 0x2B,
          0x2F, 0x22, 0x5B, 0x5D, 0x3C, 0x3E, 0x7C, 0x3A, 0x00, 0x0D]);
        let wild = false;
        const field = (off, len, blankBit) => {
          let n = 0, star = false;
          const buf = new Uint8Array(len).fill(0x20);
          while (n < len && !SEP.has(ch())) {
            const c = this.mem[at++];
            if (c === 0x2A) { star = true; break; }
            if (c === 0x3F) wild = true;
            buf[n++] = c >= 0x61 && c <= 0x7A ? c - 32 : c;
          }
          if (star) { buf.fill(0x3F, n); wild = true; while (!SEP.has(ch())) at++; }
          if (n === 0 && !star && (opt & blankBit)) return;
          this.mem.set(buf, off);
        };
        field(fcb + 1, 8, 4);
        if (ch() === 0x2E) { at++; field(fcb + 9, 3, 8); }
        else if (!(opt & 8)) this.mem.fill(0x20, fcb + 9, fcb + 12);
        r.set('si', (r.get('si') + (at - start)) & 0xFFFF);
        r.set('ax', (r.get('ax') & 0xFF00) | (wild ? 1 : 0));
        return true;
      }
      // Ctrl-Break checking (AL=00h read, 01h write) and, on the same call,
      // AL=05h/06h the boot drive and the real DOS version. Break checking is
      // off and stays off: there is no console to type Ctrl-C at.
      case 0x33:
        if ((al & 0xFF) === 0x00) { r.set('dx', (r.get('dx') & 0xFF00) | (this.breakFlag ? 1 : 0)); }
        else if ((al & 0xFF) === 0x01) { this.breakFlag = (r.get('dx') & 0xFF) !== 0; }
        else if ((al & 0xFF) === 0x05) { r.set('dx', (r.get('dx') & 0xFF00) | 3); }  // C:
        else if ((al & 0xFF) === 0x06) { r.set('bx', 0x0600); r.set('dx', 0); }      // 6.00
        else return false;
        r.setResultCf(false);
        return true;
      // The extended error of the last failed call. It is remembered rather
      // than invented: every path here that sets CF records why, so a program
      // asking "which error" gets the one it just had instead of a constant.
      case 0x59:
        r.set('ax', this.lastError || 0);
        r.set('bx', ((this.lastError ? 0x0B : 0) << 8) | 0x01);   // class, action: retry
        r.set('cx', (r.get('cx') & 0x00FF) | 0x0100);             // locus: unknown
        return true;
      // Memory allocation strategy (AL=00h get, 01h set) and the UMB link state
      // (AL=02h/03h). There are no upper memory blocks here, so the link is
      // always off; the strategy is remembered because a program that sets
      // "last fit" and reads it back expects its own answer.
      case 0x58:
        if ((al & 0xFF) === 0x00) r.set('ax', this.allocStrategy || 0);
        else if ((al & 0xFF) === 0x01) this.allocStrategy = r.get('bx') & 0xFFFF;
        else if ((al & 0xFF) === 0x02) r.set('ax', (r.get('ax') & 0xFF00) | 0);
        else if ((al & 0xFF) === 0x03) {
          // Link the upper memory blocks into the chain. There are none -- no
          // EMM386, no DOS=UMB -- and DOS without any says so with error 1,
          // not with success. ShellVT.EXE (RUNDEMO.EXE's resident MOD player)
          // asked, was told yes, took the biggest block it could get and put
          // its resident half at A01A:0 -- the VGA window -- from where the
          // child it then ran jumped into data. Refused, it stays low.
          if ((r.get('bx') & 0xFFFF) !== 0) { r.setResultCf(true); r.set('ax', 1); return true; }
        }
        else return false;
        r.setResultCf(false);
        return true;
      case 0x19: r.set('ax', (r.get('ax') & 0xFF00) | 2); return true;   // drive C:
      case 0x0E: r.set('ax', (r.get('ax') & 0xFF00) | 3); return true;   // 3 drives
      case 0x47: {                              // get current directory -> root
        const at = this.lin(r, 'ds', r.get('si'));
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
      case 0x3C: {                              // create/truncate
        // CATWALK.EXE creates a file, gets no handle back, and then writes to
        // the failed return value as though it were one -- 0x3C02, which INT 21h
        // AH=40h cheerfully accepted. It reads the result back, finds nothing it
        // wrote and exits 0 without drawing a frame.
        const h = this.createFile(this.guestPath(r));
        if (!h) { r.setResultCf(true); r.set('ax', 3); return true; }   // path not found
        r.set('ax', h);
        r.setResultCf(false);
        return true;
      }
      case 0x41: {                              // delete
        const key = fileKey(this.guestPath(r));
        if (key && this.tempFiles.delete(key)) { r.setResultCf(false); return true; }
        // A file we never created is on the host side and stays there; the
        // program is told it is gone, which is what it wants to hear.
        r.setResultCf(false);
        return true;
      }
      case 0x36: {                              // free disk space
        r.set('ax', 8);                         // sectors per cluster
        r.set('cx', 512);                       // bytes per sector
        r.set('dx', 0xFFFF);                    // total clusters
        r.set('bx', 0xF000);                    // free clusters -- ~126MB
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
          const at0 = this.lin(r, 'ds', r.get('dx'));
          for (let i = 0; i < line.length; i++) this.mem[at0 + i] = line.charCodeAt(i);
          this.conPuts(line.replace(/\r\n$/, '\r\n'));
          r.set('ax', line.length);
          r.setResultCf(false);
          return true;
        }
        if (!f) { r.setResultCf(true); r.set('ax', 6); return true; }   // bad handle
        const at = this.lin(r, 'ds', r.get('dx'));
        const got = Math.max(0, Math.min(n, f.buf.length - f.pos));
        // A read that would run off the end of the 1MB address space is a bug
        // in the guest, not something to wrap around silently.
        const room = Math.max(0, Math.min(got, this.mem.length - at));
        this.mem.set(f.buf.subarray(f.pos, f.pos + room), at);
        f.pos += got;
        // Progress, for the stuck detector. A demo that unpacks a few hundred
        // assets out of its own datafile hands back at one address in its
        // extender for a long time with nothing on the console and the same
        // registers each pass -- which is what a spin looks like from there,
        // and is why AQUAPHOB.EXE was cut off 300 reads into its resource load.
        this.bytesRead += got;
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
        // AL=06 "get input status" and AL=07 "get output status" answer with
        // AL=0FFh ready / 00h not ready, CF clear -- they are not optional and
        // they are how a program decides a handle it just opened is a live
        // character device. ACME-VIC.EXE opens EMMXXXX0, checks bit 7 of the
        // AL=00 word, then asks AL=07 and compares AL against 0FFh; answering
        // "invalid function" made the ready device read as dead and the demo
        // ran with expanded memory switched off. A file handle is always ready
        // to write and is ready to read until its position reaches the end.
        if (al === 0x06 || al === 0x07) {
          const bx = r.get('bx') & 0xFFFF;
          const f = this.files.get(bx);
          if (!f && bx > 4) { r.setResultCf(true); r.set('ax', 6); return true; }
          const ready = (al === 0x07 || !f || f.device) ? 0xFF
            : (f.pos < f.buf.length ? 0xFF : 0x00);
          r.set('ax', (r.get('ax') & 0xFF00) | ready);
          r.setResultCf(false);
          return true;
        }
        r.setResultCf(true); r.set('ax', 1);    // "invalid function"
        return true;
      }
      case 0x48: {                              // allocate paragraphs
        const want = r.get('bx') & 0xFFFF;
        const seg = this.memAlloc(want);
        // BX comes back as the largest block available, which is how a program
        // asks how much memory there is: BX=FFFF is guaranteed to fail and the
        // answer is in the error return. That is the call ASMINST.EXE reads,
        // and with the old 0x9000 ceiling it was being told 64K.
        if (seg === null) {
          r.setResultCf(true); r.set('ax', 8); r.set('bx', this.memLargest());
          // A refused allocation is worth the whole map, not just the verdict.
          // "Out of conventional memory" is a claim about who is holding it,
          // and BX alone cannot say whether the pool is exhausted or merely
          // fragmented -- BLIQ.EXE's failure looks identical either way.
          this.log(`alloc ${want.toString(16)} refused; top=${this.allocTop.toString(16)}`
            + ` held=[${[...this.memBlocks].map(([s, n]) =>
              `${s.toString(16)}+${n.toString(16)}@${this.mcbOwner(s).toString(16)}`)
              .join(' ')}]`
            + ` free=[${this.memFree.map(b =>
              `${b.seg.toString(16)}+${b.size.toString(16)}`).join(' ')}]`);
          return true;
        }
        r.set('ax', seg);
        r.setResultCf(false);
        this.mcbSync();
        return true;
      }
      case 0x49: {                              // free
        const seg = r.get('es') & 0xFFFF;
        const size = this.memBlocks.get(seg);
        // A block we never handed out is not an error worth failing on -- a
        // program freeing its own PSP block on the way out is normal, and the
        // pool has no record of that one.
        if (size !== undefined) {
          this.memBlocks.delete(seg);
          this.memReleaseBlock(seg, size);
        } else {
          // Not an error, but worth saying: a free we drop is memory the guest
          // believes it gave back, and the shortage it causes surfaces at some
          // unrelated allocation much later.
          this.log(`free ${seg.toString(16)} -- no such block`);
        }
        r.setResultCf(false);
        this.mcbSync();
        return true;
      }
      case 0x4A: {                              // resize a block
        // A .EXE is loaded owning everything up to the ceiling, so the free
        // pool is empty until it gives some back -- which is what a C or Pascal
        // runtime does first thing. Honouring the shrink is what makes the
        // answer above mean anything.
        const seg = r.get('es') & 0xFFFF, want = r.get('bx') & 0xFFFF;
        const held = this.memBlocks.get(seg);
        if (held !== undefined) {
          // Shrinking always works and the tail goes back to the pool. Growing
          // works only into free space that starts where this block ends, which
          // is what a real MCB walk would find.
          if (want <= held) {
            this.memBlocks.set(seg, want);
            this.mcbWrite(seg, this.mcbOwner(seg), want);
            this.memRelease(seg + want, held - want);
            r.setResultCf(false);
            this.mcbSync();
            return true;
          }
          const at = seg + held, need = want - held;
          const gap = this.memFree.find(b => b.seg === at);
          if (gap && gap.size >= need) {
            if (gap.size === need) this.memFree.splice(this.memFree.indexOf(gap), 1);
            else { gap.seg += need; gap.size -= need; }
            this.memBlocks.set(seg, want);
            this.mcbWrite(seg, this.mcbOwner(seg), want);
            r.setResultCf(false);
            this.mcbSync();
            return true;
          }
          if (at === this.allocTop && DEFAULT_ALLOC_TOP - this.allocTop >= need) {
            this.allocTop += need;
            this.memBlocks.set(seg, want);
            this.mcbWrite(seg, this.mcbOwner(seg), want);
            r.setResultCf(false);
            this.mcbSync();
            return true;
          }
          r.setResultCf(true); r.set('ax', 8);
          r.set('bx', held + (gap ? gap.size : at === this.allocTop ? DEFAULT_ALLOC_TOP - at : 0));
          return true;
        }
        // The running program giving back the tail of its own image. `curPsp`
        // rather than the PSP_SEG constant, because after an EXEC the program
        // doing the shrinking is the CHILD and its PSP is somewhere else
        // entirely. CATWALK.EXE is three programs deep by the time it matters:
        // it writes CATWALK.PLY and CATWALK.TMP out of itself, EXECs each at
        // psp 3eb, and the last one asks for `AH=4Ah ES=3eb BX=1f40` to hand
        // back everything above its 124KB. Matched against the constant that
        // request fell through and did nothing, so allocTop stayed at the 9f00
        // ceiling, the AH=48h for 0xfa0 paragraphs that came next was refused
        // out of an empty pool, and the demo printed "Not enough memory!" while
        // 636KB sat unclaimed.
        if (seg === this.curPsp) {
          if (seg + want > DEFAULT_ALLOC_TOP) {
            r.setResultCf(true); r.set('ax', 8); r.set('bx', DEFAULT_ALLOC_TOP - seg);
            return true;
          }
          this.allocTop = seg + want;
          this.memTrim();
          // Shrinking is also what makes room for a child: a loader stub that
          // gives back everything above itself expects EXEC to load there.
          // And a child goes above the block as RESIZED, whichever way that
          // went against the image's minimum: ShellVT.EXE (RUNDEMO.EXE's
          // resident MOD player) sizes itself to 283KB for its heap, then
          // EXECs the demo -- and with only a shrink honoured here the demo
          // was loaded at 184F:0, inside that heap, over the player's
          // buffers, and the player jumped into data.
          this.imageTop = seg + want;
          this.mcbSync();
        }
        r.setResultCf(false);
        return true;
      }
      // Create a child PSP at DX:0. Undocumented, and the way a self-contained
      // overlay loader makes a home for the code it is about to read out of its
      // own .EXE -- CONTAGIO.EXE calls it between reading its overlay table and
      // jumping into one.
      case 0x55: {
        const seg = r.get('dx') & 0xFFFF, to = seg << 4, from = this.curPsp << 4;
        this.mem.copyWithin(to, from, from + 0x100);
        this.mem[to + 0x16] = this.curPsp & 0xFF;     // parent PSP
        this.mem[to + 0x17] = (this.curPsp >> 8) & 0xFF;
        // This is the call EXEC makes internally, so unlike AH=26h it also
        // makes the new PSP the current one. That is what puts the child's
        // terminate vector in reach of the AH=4Ch above.
        this.curPsp = seg;
        r.setResultCf(false);
        return true;
      }
      case 0x1A: this.dta = this.lin(r, 'ds', r.get('dx')); return true;
      case 0x2F:                                // get DTA -> ES:BX
        r.set('es', (this.dtaAddr() >> 4) & 0xFFFF); r.set('bx', this.dtaAddr() & 0xF);
        return true;
      // FindFirst / FindNext over the directory the program was started in.
      // ShellVT.EXE, the MOD-player shell RUNDEMO.EXE hands the demo to when
      // a Sound Blaster is chosen, locates `elysium.mod` this way -- and with
      // nothing here it opened "C:\" plus an empty name, printed "Error en el
      // fichero" 24 times and never ran mainpart.exe. The search state lives
      // in the DTA's reserved bytes exactly as DOS keeps it, so a program that
      // moves the DTA between calls, or nests two searches, still works.
      case 0x4E: {
        const spec = this.guestPath(r);
        const pat = dosPattern(fileKey(spec) || '');
        if (!pat) { r.setResultCf(true); r.set('ax', 2); return true; }
        const dta = this.dtaAddr();
        for (let i = 0; i < 11; i++) this.mem[dta + 1 + i] = pat.charCodeAt(i);
        this.mem[dta + 0x0C] = r.get('cx') & 0xFF;
        this.mem[dta + 0x0D] = 0; this.mem[dta + 0x0E] = 0;
        return this.findNext(r, 2);
      }
      case 0x4F: return this.findNext(r, 0x12);
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

  // Extended memory blocks are cut from the guest's own linear memory, above
  // the HMA at isa.XMS_BASE. They could have lived in a host buffer -- the move
  // call is the only thing a real-mode program can do with one through the
  // documented interface -- but ten demos in this corpus do not stop there.
  // They LOCK the block, take the 32-bit linear address the lock returns, and
  // then write through it with a 32-bit offset from real mode. That address has
  // to name something the guest can actually reach, so the block has to be in
  // the same memory everything else is in.
  //
  // Cutting from the low end of the extended region, first fit, coalescing by
  // construction: the live blocks are walked in address order and the first gap
  // that fits wins. A handful of allocations is all any of these programs make.
  xmsAlloc(kb) {
    const bytes = kb * 1024;
    const live = [...this.xmsBlocks.values()].sort((a, b) => a.base - b.base);
    let at = isa.XMS_BASE;
    for (const b of live) {
      if (b.base - at >= bytes) break;
      at = b.base + b.kb * 1024;
    }
    return at + bytes <= isa.XMS_BASE + isa.XMS_SIZE ? at : -1;
  }

  // An 8086 has twenty address lines and every address wraps at 1MB. A machine
  // with extended memory in it does not, and a program that has just been handed
  // an address above 1MB is relying on that. The wrap is the default because it
  // is what an 8086 does and what the instruction gate's recorded vectors
  // expect; taking an XMS handle is the guest saying it is not on one.
  openBus() {
    if (this.linFlat) return;
    this.linFlat = true;
    if (this.vmExports && this.vmExports.set_linmask) {
      this.vmExports.set_linmask(isa.LIN_MASK_FLAT);
    }
  }

  // Extended memory still unhanded-out, in KB. A method rather than a closure
  // because INT 15h AH=88h answers the same question from outside.
  xmsFreeKb() {
    return XMS_TOTAL_KB - [...this.xmsBlocks.values()].reduce((a, b) => a + b.kb, 0);
  }

  xms(ah, r) {
    const ok = (dx) => { r.set('ax', 1); if (dx !== undefined) r.set('dx', dx); };
    const fail = (bl) => { r.set('ax', 0); r.set('bx', (r.get('bx') & 0xFF00) | bl); };
    const free = () => this.xmsFreeKb();
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
        const base = kb > free() ? -1 : this.xmsAlloc(kb);
        if (base < 0) { fail(0xA0); return true; }                // out of memory
        const h = this.xmsNext++;
        this.xmsBlocks.set(h, { kb, base, locks: 0 });
        this.openBus();
        ok(h);
        return true;
      }
      case 0x0A: {                                                // free EMB
        const h = r.get('dx') & 0xFFFF;
        const b = this.xmsBlocks.get(h);
        if (!b) { fail(0xA2); return true; }
        if (b.locks) { fail(0xAB); return true; }                 // block is locked
        this.xmsBlocks.delete(h);
        ok();
        return true;
      }
      case 0x0B: return this.xmsMove(r);
      case 0x0C: {                                                // lock EMB
        const b = this.xmsBlocks.get(r.get('dx') & 0xFFFF);
        if (!b) { fail(0xA2); return true; }
        b.locks++;
        this.openBus();
        // DX:BX is a 32-bit LINEAR address, not a segment pair.
        r.set('ax', 1);
        r.set('dx', (b.base >>> 16) & 0xFFFF);
        r.set('bx', b.base & 0xFFFF);
        return true;
      }
      case 0x0D: {                                                // unlock EMB
        const b = this.xmsBlocks.get(r.get('dx') & 0xFFFF);
        if (!b) { fail(0xA2); return true; }
        if (!b.locks) { fail(0xAA); return true; }                // not locked
        b.locks--;
        ok();
        return true;
      }
      case 0x0E: {                                                // get handle info
        const b = this.xmsBlocks.get(r.get('dx') & 0xFFFF);
        if (!b) { fail(0xA2); return true; }
        r.set('ax', 1);
        r.set('bx', ((b.locks & 0xFF) << 8) | (0xFF - this.xmsBlocks.size));
        r.set('dx', b.kb);
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
    const p = this.lin(r, 'ds', r.get('si'));
    const m = this.mem;
    const u16 = (o) => m[p + o] | (m[p + o + 1] << 8);
    const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
    const len = u32(0);
    // Both sides are plain linear addresses now that extended memory is part of
    // the same array: handle 0 means the offset is a far pointer to unpack,
    // anything else means an offset within the block's own slice.
    const side = (ho, oo) => {
      const h = u16(ho);
      if (h === 0) {
        const far = u32(oo);
        return ((((far >>> 16) & 0xFFFF) << 4) + (far & 0xFFFF)) & 0xFFFFF;
      }
      const b = this.xmsBlocks.get(h);
      return b ? b.base + u32(oo) : null;
    };
    const src = side(4, 6), dst = side(10, 12);
    // An odd length is an error on a real driver, and so is a handle nobody
    // allocated. Both are worth reporting rather than papering over: a program
    // that gets a success it did not earn goes wrong further away.
    if (src === null || dst === null || (len & 1)) {
      r.set('ax', 0);
      r.set('bx', (r.get('bx') & 0xFF00) | (len & 1 ? 0xA7 : 0xA3));
      return true;
    }
    if (src + len <= m.length && dst + len <= m.length) {
      m.copyWithin(dst, src, src + len);
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
      // AH=4Eh, get/set page map. This is how a library that does not own the
      // page frame borrows it: save what is mapped, use the window, put it
      // back. MIDAS -- the sound system six demos in this corpus link against
      // -- opens by calling AL=03 to size the save area, and an "invalid
      // subfunction" there is reported as `MIDAS Error: Expanded Memory Manager
      // failure` before the demo draws anything at all.
      //
      // The map is four physical pages; each is saved as {handle, logical} and
      // restored by re-mapping, which is what makes the copy-on-map model
      // behave like the address lines it stands in for.
      case 0x4E: {
        const es = r.get('es'), di = r.get('di'), ds = r.get('ds'), si = r.get('si');
        const put = (seg, off) => {
          const at = ((seg << 4) + (off & 0xFFFF)) & 0xFFFFF;
          for (let i = 0; i < 4; i++) {
            const m = this.emsMapped[i];
            const h = m ? m.h : 0, lg = m ? m.page : 0xFFFF;
            this.mem[at + i * 4] = h & 0xFF; this.mem[at + i * 4 + 1] = (h >> 8) & 0xFF;
            this.mem[at + i * 4 + 2] = lg & 0xFF; this.mem[at + i * 4 + 3] = (lg >> 8) & 0xFF;
          }
        };
        const take = (seg, off) => {
          const at = ((seg << 4) + (off & 0xFFFF)) & 0xFFFFF;
          for (let i = 0; i < 4; i++) {
            const h = this.mem[at + i * 4] | (this.mem[at + i * 4 + 1] << 8);
            const lg = this.mem[at + i * 4 + 2] | (this.mem[at + i * 4 + 3] << 8);
            if (lg === 0xFFFF || !this.emsHandles.has(h)) { this.emsFlush(i); this.emsMapped[i] = null; }
            else this.emsMap(i, lg, h, r);
          }
        };
        if (al === 0x00) { put(es, di); st(0); return true; }
        if (al === 0x01) { take(ds, si); st(0); return true; }
        if (al === 0x02) { put(es, di); take(ds, si); st(0); return true; }
        if (al === 0x03) { r.set('ax', 16); return true; }         // AL = bytes, AH = 0
        st(0x8F);                                                  // invalid subfunction
        return true;
      }
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
      // Button press/release info: how many transitions since the last ask, and
      // where the last one was. BL selects the button. The counters are real --
      // a program that polls these instead of AX=03h is asking for the clicks
      // it has not seen yet, and answering a constant 0 is the same as saying
      // the mouse is dead.
      case 0x05: case 0x06: {
        const b = r.get('bx') & 0xFFFF;
        const side = fn === 0x05 ? this.mouse.pressed : this.mouse.released;
        r.set('ax', this.mouse.buttons);
        r.set('bx', side[b] || 0);
        r.set('cx', this.mouse.x); r.set('dx', this.mouse.y);
        if (side[b]) side[b] = 0;
        return true;
      }
      // The driver-state block. AX=15h reports how big a buffer the caller must
      // hand back to 16h/17h; there is no hardware state here worth preserving,
      // so the honest size is the one field we do have -- position and buttons
      // -- and 16h/17h move exactly that. Reporting nothing at all is what left
      // CTSLASSE.EXE and COUNTDWN.EXE with an unhandled call.
      case 0x15: r.set('bx', 8); return true;
      case 0x16: case 0x17: {
        const at = this.lin(r, 'es', r.get('dx'));
        const w = (o, v) => { this.mem[at + o] = v & 0xFF; this.mem[at + o + 1] = (v >> 8) & 0xFF; };
        if (fn === 0x16) { w(0, this.mouse.x); w(2, this.mouse.y); w(4, this.mouse.buttons); w(6, 0); }
        else {
          const rd = (o) => this.mem[at + o] | (this.mem[at + o + 1] << 8);
          this.mouse.x = rd(0); this.mouse.y = rd(2); this.mouse.buttons = rd(4);
        }
        return true;
      }
      // Cursor shape (09h graphics, 0Ah text), event handlers (0Ch, 14h), light
      // pen (0Dh/0Eh), speed and sensitivity (0Bh's siblings 13h, 1Ah, 1Bh),
      // and the software reset 21h. None of them has hardware behind it here:
      // there is no drawn cursor and no interrupt to call a handler from, so
      // "accepted, nothing to do" is what this driver actually does.
      case 0x09: case 0x0A: case 0x0C: case 0x0D: case 0x0E:
      case 0x13: case 0x14: case 0x1A: case 0x1B:
        return true;
      case 0x21: r.set('ax', 0xFFFF); r.set('bx', 2); return true;
      // Driver version, type and IRQ. 8.00 is late enough that nothing in this
      // corpus asks for a function newer than what is above.
      case 0x24: r.set('bx', 0x0800); r.set('cx', 0x0400); return true;
      default: return false;
    }
  }
}

module.exports = {
  Machine, loadExe, vgaGeometry, parseKeys,
  VGA_BASE, STUB_SEG, STUB_OFF, STUB_BYTE, LOAD_SEG, PSP_SEG,
  ENV_SEG, ENV_PARAS, LOL_SEG, LOL_OFF, MCB_FIRST, MCB_SYSTEM, DEFAULT_ALLOC_TOP,
};

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/toyvm/dos.js <file.exe>   # MZ header summary'); process.exit(2); }
  const mem = new Uint8Array(1 << 20);
  const info = loadExe(mem, fs.readFileSync(file));
  console.log(info);
}
