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
const SEG = ['es', 'cs', 'ss', 'ds'];

// Flags word bit positions. The 8086 reads bits 1 and 12-15 as 1 always, which
// is why FLAGS_RESERVED is OR'd into every value the VM produces -- the test
// vectors are recorded off real silicon and carry those bits set.
const F = { CF: 0, PF: 2, AF: 4, ZF: 6, SF: 7, TF: 8, IF: 9, DF: 10, OF: 11 };
const FLAGS_RESERVED = 0xF002;
// Bits the VM computes; everything else is carried through untouched.
const FLAGS_ARITH = (1 << F.CF) | (1 << F.PF) | (1 << F.AF)
  | (1 << F.ZF) | (1 << F.SF) | (1 << F.OF);

// Memory map of the toy VM's single linear memory.
const GUEST_RAM = 0x00000;      // 1MB, the 8086's whole address space
const GUEST_RAM_SIZE = 0x100000;
const THREAD_BASE = 0x100000;   // decoded op stream lives here
const THREAD_SIZE = 0x100000;
const MEM_PAGES = (THREAD_BASE + THREAD_SIZE) >> 16;

// Effective-address kinds, in ModRM rm order for mod != 11. Kind 8 is the
// mod=00,rm=110 special case: a bare disp16 with no base at all.
const EA = {
  BX_SI: 0, BX_DI: 1, BP_SI: 2, BP_DI: 3, SI: 4, DI: 5, BP: 6, BX: 7, DISP: 8,
};
// Which segment each kind defaults to when no prefix overrides it. Anything
// built on BP is stack-relative; everything else is data.
const EA_DEFAULT_SEG = [3, 3, 2, 2, 3, 3, 2, 3, 3]; // index into SEG

module.exports = {
  REG16, REG8, SEG, F, FLAGS_RESERVED, FLAGS_ARITH,
  GUEST_RAM, GUEST_RAM_SIZE, THREAD_BASE, THREAD_SIZE, MEM_PAGES,
  EA, EA_DEFAULT_SEG,
};
