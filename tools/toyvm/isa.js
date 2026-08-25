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
const GUEST_RAM = 0x00000;      // 1MB, the 8086's whole address space
const GUEST_RAM_SIZE = 0x100000;
const THREAD_BASE = 0x100000;   // decoded op stream lives here
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
// {key = cs<<16|ip, arenaAddr}, arenaAddr 0 meaning empty. A collision or a
// stale entry costs a handback, never a wrong jump, because the key is checked.
const JTAB_BASE = RSTACK_BASE + RSTACK_SIZE;
const JTAB_ENTRIES = 16384;
const JTAB_SIZE = JTAB_ENTRIES * 8;
const JTAB_HASH_MUL = -1640531527;   // 2654435761 as a signed i32
function jhash(cs, ip) {
  return (Math.imul((((cs & 0xFFFF) << 16) | (ip & 0xFFFF)) | 0, JTAB_HASH_MUL) >>> 16)
    & (JTAB_ENTRIES - 1);
}
const MEM_PAGES = ((JTAB_BASE + JTAB_SIZE + 0xFFFF) & ~0xFFFF) >> 16;

// Effective-address kinds, in ModRM rm order for mod != 11. Kind 8 is the
// mod=00,rm=110 special case: a bare disp16 with no base at all.
const EA = {
  BX_SI: 0, BX_DI: 1, BP_SI: 2, BP_DI: 3, SI: 4, DI: 5, BP: 6, BX: 7, DISP: 8,
};
// Which segment each kind defaults to when no prefix overrides it. Anything
// built on BP is stack-relative; everything else is data.
const EA_DEFAULT_SEG = [3, 3, 2, 2, 3, 3, 2, 3, 3]; // index into SEG

module.exports = {
  REG16, REG8, SEG, F, FLAGS_RESERVED, FLAGS_DEFINED, FLAGS_ARITH,
  GUEST_RAM, GUEST_RAM_SIZE, THREAD_BASE, THREAD_SIZE, MEM_PAGES,
  RSTACK_BASE, RSTACK_ENTRIES, RSTACK_SIZE,
  JTAB_BASE, JTAB_ENTRIES, JTAB_SIZE, JTAB_HASH_MUL, jhash,
  EA, EA_DEFAULT_SEG,
};
