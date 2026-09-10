'use strict';

// The toy VM's instruction set and its handler bodies, in one place.
//
// This is 8086 real mode: 16-bit registers, ModRM addressing, and a real FLAGS
// word. The point of choosing x86-16 over something simpler is the flags -- our
// production interpreter computes them lazily (four globals written per ALU op)
// and that design has never been A/B'd against eager computation on a real
// workload. A flagless toy ISA could not have asked the question.
//
// Handler BODIES here are pure WAT fragments: they read their operands from
// $ip, advance $ip past them, and fall off the end. They never emit their own
// dispatch. That is what lets tools/toyvm/emit.js wrap the same body six
// different ways (call_indirect, return_call_indirect, one giant br_table,
// replicated br_table, replicated tail call, typed table) so the ONLY variable
// between builds is how control reaches the next handler.

// ---------------------------------------------------------------------------
// Register numbering, as the x86 encoding itself numbers them.
// ---------------------------------------------------------------------------
const REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const REG8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
// FS and GS are 80386 additions and are never selected by an 8088 encoding, but
// they cost one global each and a 386-era demo overrides to them freely.
const SEG = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];

// Flags word bit positions. The 8086 reads bits 1 and 12-15 as 1 always, which
// is why FLAGS_RESERVED is OR'd into every value the VM produces -- the test
// vectors are recorded off real silicon and carry those bits set.
const F = { CF: 0, PF: 2, AF: 4, ZF: 6, SF: 7, TF: 8, IF: 9, DF: 10, OF: 11 };
const FLAGS_RESERVED = 0xF002;
// The bits an 8086 actually implements: CF PF AF ZF SF TF IF DF OF. Bits 3 and 5
// always read 0, so POPF and IRET must mask with this as well as OR the
// reserved-set bits in.
const FLAGS_DEFINED = 0x0FD5;
// Bits the VM computes; everything else is carried through untouched.
const FLAGS_ARITH = (1 << F.CF) | (1 << F.PF) | (1 << F.AF)
  | (1 << F.ZF) | (1 << F.SF) | (1 << F.OF);

// Memory map of the toy VM's single linear memory.
// The first 1MB is the 8086's whole address space. The rest is extended
// memory, and it is here rather than in a host buffer because a program that
// LOCKS an XMS block is handed a 32-bit linear address and then writes through
// it -- from real mode, with a 32-bit offset and A20 on. There is nowhere else
// for that address to point. $lin masks with the $linmask global, which stays
// at 0xFFFFF (the 8086's twenty address lines, wrapping at 1MB) until the guest
// takes an XMS handle; only then does the address space grow, so a program that
// never asks for extended memory keeps exact 8086 wrap semantics and the
// instruction gate is unaffected.
//
// Ten demos in the corpus stop at `Extended memory allocation failure. (weird
// eh???)`, all of them on the lock call, all of them from the same intro
// system. Failing the lock was the honest answer while there was no memory to
// point at.
const GUEST_RAM = 0x00000;
const GUEST_RAM_SIZE = 0x1000000;          // 16MB: 1MB real mode + 15MB extended
const XMS_BASE = 0x110000;                 // above the HMA, where EMBs are cut from
const XMS_SIZE = GUEST_RAM_SIZE - XMS_BASE;
const LIN_MASK_REAL = 0x000FFFFF;          // 8086: twenty address lines
const LIN_MASK_FLAT = GUEST_RAM_SIZE - 1;  // A20 on, extended memory in play
const THREAD_BASE = GUEST_RAM + GUEST_RAM_SIZE;   // decoded op stream lives here
const THREAD_SIZE = 0x100000;
// Shadow return stack. A `ret` reads its target off the guest stack, so no
// arena address can be baked into it and every return would otherwise hand
// control back to the host -- on mars.exe that was 103 dispatches per JS round
// trip, which would have made this a benchmark of the harness. Each entry is
// {guestIp, arenaAddr, guestSp} and is only ever a hint: it is used when all
// three still agree with the guest's own stack, and thrown away when they do
// not, so a guest that manufactures a return address is still correct.
const RSTACK_BASE = THREAD_BASE + THREAD_SIZE;
const RSTACK_ENTRIES = 4096;
const RSTACK_SIZE = RSTACK_ENTRIES * 12;
// Indirect-jump target cache. mars.exe dispatches into an unrolled span writer
// through a computed jump, and without this every one of those is a JS round
// trip -- 85k of them at a single address in a 40M-dispatch run. Direct-mapped,
// {ip, cs, arenaAddr, pad}, arenaAddr 0 meaning empty. A collision or a stale
// entry costs a handback, never a wrong jump, because the key is checked.
//
// The key is the FULL offset and the selector beside it, not the two packed
// into one word. Packing was exact while every offset was 16 bits; in a flat
// 32-bit code segment two blocks 64KB apart pack to the same key, and an exact
// match on it would resume the wrong one.
const JTAB_BASE = RSTACK_BASE + RSTACK_SIZE;
const JTAB_ENTRIES = 16384;
const JTAB_STRIDE = 16;
const JTAB_SIZE = JTAB_ENTRIES * JTAB_STRIDE;
const JTAB_HASH_MUL = -1640531527;   // 2654435761 as a signed i32
function jhash(cs, ip) {
  return (Math.imul((ip ^ ((cs & 0xFFFF) << 16)) | 0, JTAB_HASH_MUL) >>> 16)
    & (JTAB_ENTRIES - 1);
}
// VGA plane store, four 64K planes plus a small control block.
//
// In chained mode 13h a byte written to A000:off is one pixel and lands in the
// guest's own RAM, which is why video needed no modelling at all. Unchained
// ("mode X") breaks that: the sequencer's map mask decides WHICH of four planes
// a write reaches, so the same A000 offset names four different bytes and the
// 64K window cannot hold them. The planes therefore live outside the 1MB the
// guest can address, and only the unchained path ever touches them.
//
// The control block is in linear memory rather than in globals so that the host
// can update it with a plain store into the shared buffer, and so the trace JIT
// -- which builds its own module around the same helpers -- inherits it without
// a new import.
const VGA_CTL = (JTAB_BASE + JTAB_SIZE + 0xFFFF) & ~0xFFFF;
const VGA_CTL_KEY = VGA_CTL + 0;    // VGA_KEY_ON while planar, else 0
const VGA_CTL_MASK = VGA_CTL + 4;   // sequencer map mask, low 4 bits
const VGA_CTL_LATCH = VGA_CTL + 16; // the four plane latches, one byte each
// Counters, so "the picture is empty" can be told apart from "the guest never
// wrote to it". Bumped only on the planar path, so a chained run pays nothing.
const VGA_CTL_WRITES = VGA_CTL + 20;
const VGA_CTL_READS = VGA_CTL + 24;
// The graphics controller's nine registers, one word each, mirrored here by the
// host on every write to port 0x3CF. All of them: an EGA 16-colour mode drives
// set/reset, the bit mask and the ALU function on nearly every store, so the
// subset mode X happens to need is not enough.
const VGA_CTL_GC = VGA_CTL + 32;
const VGA_PLANES = VGA_CTL + 0x100;
const VGA_PLANE_SIZE = 0x10000;
// The guard compares the key against `(lin & 0xF0000) | 1`, and the low bit is
// there so that ZERO reliably means chained. Two callers -- gate.js and
// fpu-check.js -- reset the machine with a whole-buffer `mem.fill(0)`, and a
// guard that treated 0 as a valid key would then route every access in the low
// 64K, which is where those suites put their test memory, into the plane store.
// Making the off state the same value an empty memory already holds means no
// caller has to know the control block exists.
const VGA_KEY_OFF = 0;
const VGA_KEY_ON = 0xA0001;

// Which BYTES of guest memory hold code that has been COMPILED. One bit each,
// 128KB for the whole 1MB. Every store checks its bit and, on a hit, sets the
// $smc global -- the host then throws the compiled regions away and decodes
// again from memory as it now is.
//
// One bit per 16 bytes was the first shape and it cost a lot more than the
// 120KB it saved, because a 16-byte answer is not "did you write code", it is
// "did you write within 16 bytes of code" -- and a real-mode program keeps its
// variables in its code segment. B-STEEL.EXE reads and writes six of them at
// cs:0xf3..0x102, a few bytes from the instructions that use them
// (`cmp word [0xf3], 0xff` at 110:8c, `mov [0xf3], ax` at 110:a7). Every one of
// those ordinary data stores landed in a paragraph holding real code and threw
// the compiled region away: 302,563 breaks, 418,360 recompiles, 477MB of arena
// and 11 dispatches per handback, which is 70k dispatches a second against the
// 80M this machine otherwise runs at. The demo does finish -- it is 307200
// pixels when it gets the wall clock for it -- so what this looked like from
// the sweep was a program that intermittently photographed blank.
//
// The precision was always there: compile.js already records the exact byte
// ranges it decoded, and the host was rounding them out to paragraphs on the
// way into the bitmap. The guest-side check costs the same two instructions
// either way.
//
// This is not an optimisation, it is what makes a packed program run at all.
// Most of this corpus ships compressed (LZEXE, PKLITE, DIET): the file is a
// small depacker plus a blob, and the program that eventually runs was written
// into memory by that depacker. Compiling a region ahead of the guest means the
// bytes at 0100:0100 were decoded while they were still the depacker's, and
// jumping back there ran the depacker's code for ever. uman.com spent 10M
// dispatches doing exactly that, executing its own unpacked text screen.
// The SVGA framebuffer, for the VESA modes. It lives outside the guest's
// address space on purpose: VBE 1.2 shows a program 64KB of its picture at a
// time through the window at A000, so the picture itself has nowhere to live
// down there, and the window is copied in and out of here as the program moves
// it. 1MB covers 1024x768 in 256 colours, the largest mode we offer.
const VESA_FB = VGA_PLANES + VGA_PLANE_SIZE * 4;
const VESA_FB_SIZE = 0x100000;

const CODE_BITMAP = (VESA_FB + VESA_FB_SIZE + 0xFFFF) & ~0xFFFF;
const CODE_BITMAP_SIZE = GUEST_RAM_SIZE >> 3;      // one bit per byte

// Dispatch histogram, for --handler-hist. Two tables: one i32 counter per
// handler, and one per ORDERED PAIR of handlers.
//
// The pair table is the expensive half and it is the half worth having. What a
// superinstruction fuses is a pair -- cmp+jcc, shift+dec+jz, load+op -- and
// what makes replicated dispatch win is that the next opcode correlates with
// the current one. A flat per-handler census can answer neither question: it
// says `jz` is hot without saying what it follows, and every fusion candidate
// is exactly that "what it follows".
//
// Sized for the real handler count with headroom, and reserved unconditionally
// so there is only ever one memory layout -- two layouts would mean the
// instrumented build measures a different machine than the one that ships.
// A power of two keeps the pair index a shift rather than a multiply.
//
// The 16MB pair table costs address space, not memory: a wasm memory is one
// large mapping and pages materialize when first touched, so a run without
// --handler-hist never faults a single one of them in.
//
// **This has to be >= HANDLERS.length and there is nothing between them that
// says so.** It was 1024 while the table grew past it to 1148 (the flagless
// variants) and the only symptom was that `--handler-hist` crashed with
// `memory access out of bounds`, and only on a program that happened to
// execute a handler with a high index -- so the census looked fine for weeks.
// emit.js asserts the relationship now, at table-build time.
const HIST_SLOTS = 2048;                           // >= HANDLERS.length, power of two
const HIST_BASE = (CODE_BITMAP + CODE_BITMAP_SIZE + 0xFFFF) & ~0xFFFF;
const HIST_PAIRS = HIST_BASE + HIST_SLOTS * 4;     // [prev * HIST_SLOTS + cur]
const HIST_SIZE = HIST_SLOTS * 4 + HIST_SLOTS * HIST_SLOTS * 4;

// The wasm decoder's constant tables and its scratch. See
// docs/toyvm-decoder-in-wasm.md.
//
// DEC_TAB holds tables generated from the same JS tables decode.js decodes
// with -- (alu op, form, operand size) -> handler index, and the sixteen Jcc
// handlers in tttn order -- so the two decoders cannot drift apart in the one
// place a decoder is most likely to: which handler an encoding names.
//
// The rest is what a block compile hands back to the host cache, which keeps it
// in JS objects: the branch fixups to resolve, and the byte ranges it decoded
// (those feed CODE_BITMAP). There is no pending-block list here on purpose --
// the worklist stays in compile.js, which already has one and owns the cache the
// answers go into. Both are fixed-size and overrunning one stops the block,
// which costs a JS compile: the thing that was going to happen anyway.
const DEC_TAB = (HIST_BASE + HIST_SIZE + 0xFFFF) & ~0xFFFF;
const DEC_TAB_SIZE = 0x1000;
// [wordIndex, targetIp, insnIp, wroteSoFar]. The last two are not for resolving
// the fixup -- they are what lets the host apply its decryptor rule to a block
// wasm decoded, unchanged and per instruction: "did anything up to HERE store,
// and does this edge go backward from THIS instruction". Aggregating them per
// block instead would call a decryptor's own back edge a forward one, and the
// host would compile the ciphertext ahead of it. See compile.js.
const DEC_FIXUPS = DEC_TAB + DEC_TAB_SIZE;
const DEC_FIXUPS_MAX = 8192;
const DEC_FIXUP_WORDS = 4;
// Where a block compile writes its threaded-code words. Not the real arena:
// compileProgram assembles a program in a JS array and installs it in one go,
// and a decoder writing into the live arena as it went would be writing over
// code the guest may still be inside.
// One bit per guest ip (low 16 bits) marking an ip compileProgram has already
// given a block head. Straight-line code that falls into one must stop there and
// jump to it, or the same tail is emitted twice -- and two copies of a tail are
// not merely wasteful: the blocks around them end at different places, the guest
// takes its interrupts at different instructions, and a demo renders a different
// frame. Measured on COMPOVRS.EXE, which diverged at 4M dispatches for exactly
// that reason while both decoders agreed instruction for instruction.
//
// Indexed by ip & 0xFFFF, so a 32-bit segment can alias two ips onto one bit.
// An alias can only cause a SPURIOUS stop, never a missed one: the host then
// finds no block at that ip and simply carries on from there. Wrong in the safe
// direction, for 8KB instead of a 512MB bitmap.
const DEC_HEADS = DEC_FIXUPS + DEC_FIXUPS_MAX * DEC_FIXUP_WORDS * 4;
const DEC_HEADS_SIZE = 0x10000 >> 3;

const DEC_SCRATCH = DEC_HEADS + DEC_HEADS_SIZE;
const DEC_SCRATCH_WORDS = 0x10000;
// [wordIndex, ip] per instruction the wasm decoder emitted in one call. A
// fixup names an ip only for a branch, so without this nothing says where a
// mid-block op sits in the guest; region-jit needs that to turn a branch to an
// ip inside its own body into a wasm `br` instead of an exit. Past the cap the
// decoder simply stops recording -- the map is a hint, never a correctness
// input.
const DEC_INSNS = DEC_SCRATCH + DEC_SCRATCH_WORDS * 4;
const DEC_INSNS_MAX = 0x4000;

// One u32 per ARENA WORD, bumped in $next by the `--block-hits` build only.
// This is the per-block-entry census `--handler-hist` cannot give: that table
// is indexed by handler NUMBER, so it says how many `mov_rr16` dispatches the
// run retired and nothing about which block they were in. Indexed by arena
// BYTE offset (arena words are 4 bytes and so are counters, so the mapping is
// 1:1 and the table is exactly THREAD_SIZE), which makes the counter for a
// block head the block's entry count and the counters across a block's words
// its retired-op profile.
//
// It is reserved unconditionally so MEM_PAGES does not depend on a debug flag
// -- a memory whose size changes with a census switch would make the census
// build a different machine from the one being measured. 1MB against the
// ~16MB the pair table already reserves.
const IPHIST_BASE = DEC_INSNS + DEC_INSNS_MAX * 8;
const IPHIST_SIZE = THREAD_SIZE;
const DEC_END = IPHIST_BASE + IPHIST_SIZE;

const MEM_PAGES = ((DEC_END + 0xFFFF) & ~0xFFFF) >> 16;

// Effective-address kinds, in ModRM rm order for mod != 11. Kind 8 is the
// mod=00,rm=110 special case: a bare disp16 with no base at all.
const EA = {
  BX_SI: 0, BX_DI: 1, BP_SI: 2, BP_DI: 3, SI: 4, DI: 5, BP: 6, BX: 7, DISP: 8,
  // Kind 9 is the whole of 386 32-bit addressing: base + index*scale + disp32.
  // It cannot be enumerated the way the 16-bit forms can -- 8 bases x 8 indices
  // x 4 scales is 256 shapes -- so the packed operand carries the fields and
  // one arm decodes them. See EA_A32 below for the layout.
  A32: 9,
};
// Which segment each kind defaults to when no prefix overrides it. Anything
// built on BP is stack-relative; everything else is data. Kind 9's default is
// worked out at decode time from its base register, so its entry is never read.
const EA_DEFAULT_SEG = [3, 3, 2, 2, 3, 3, 2, 3, 3, 3]; // index into SEG

// Extra fields the A32 kind packs into the same operand word, above the ones
// every EA uses (kind 0-3, segment 4-6, ModRM reg 8-10).
const EA_A32 = {
  BASE_SHIFT: 12, INDEX_SHIFT: 15, SCALE_SHIFT: 18,
  NO_BASE: 1 << 20, NO_INDEX: 1 << 21,
};

module.exports = {
  REG16, REG8, SEG, F, FLAGS_RESERVED, FLAGS_DEFINED, FLAGS_ARITH,
  GUEST_RAM, GUEST_RAM_SIZE, THREAD_BASE, THREAD_SIZE, MEM_PAGES,
  HIST_BASE, HIST_PAIRS, HIST_SLOTS, HIST_SIZE,
  XMS_BASE, XMS_SIZE, LIN_MASK_REAL, LIN_MASK_FLAT,
  RSTACK_BASE, RSTACK_ENTRIES, RSTACK_SIZE,
  JTAB_BASE, JTAB_ENTRIES, JTAB_SIZE, JTAB_STRIDE, JTAB_HASH_MUL, jhash,
  VGA_CTL, VGA_CTL_KEY, VGA_CTL_MASK, VGA_CTL_LATCH, VGA_CTL_GC,
  VGA_CTL_WRITES, VGA_CTL_READS,
  VGA_PLANES, VGA_PLANE_SIZE, VGA_KEY_OFF, VGA_KEY_ON,
  VESA_FB, VESA_FB_SIZE,
  CODE_BITMAP, CODE_BITMAP_SIZE,
  DEC_TAB, DEC_TAB_SIZE, DEC_FIXUPS, DEC_FIXUPS_MAX, DEC_FIXUP_WORDS,
  DEC_HEADS, DEC_HEADS_SIZE, DEC_SCRATCH, DEC_SCRATCH_WORDS, DEC_INSNS, DEC_INSNS_MAX, DEC_END,
  IPHIST_BASE, IPHIST_SIZE,
  EA, EA_DEFAULT_SEG, EA_A32,
};
