'use strict';

// Which handlers get a per-register twin, and why exactly these.
//
// A handler that reaches the register file with an index out of the arena pays
// a call and a br_table for it. Pinning that index to a constant turns the
// whole thing into one `global.get`, and since the index is a word the COMPILER
// wrote, it can pick the pinned twin at compile time. The catch is that a twin
// costs a handler-table entry, and the table is hard-capped: `--handler-hist`'s
// pair census is HIST_SLOTS^2 words of the VM's own linear memory, so going
// past 2048 handlers quadruples a 16MB table that every run allocates. With
// 1581 handlers built, 467 entries are free -- 58 handlers at eight twins each.
//
// So the list is a budget, and it was spent by measurement rather than by
// intuition. `tools/toyvm/reg-index-census.js` ranks every eligible handler by
// its MEAN share of dispatches across the ten programs in
// bench-set-core10.txt, and these are the top 58:
//
//   node tools/toyvm/reg-index-census.js \
//     $(grep -v '^#' tools/toyvm/bench-set-core10.txt) --budget=8e6 --top=0 --names
//
// Measured 2026-08-30, 8M dispatches each: these 58 cover **46.6%** of all
// dispatches in that set, against 51.3% for all 245 eligible handlers that ran
// at all. The tail really is worthless -- handler 59 onwards is 4.7% between
// them -- which is why a budget that looked crippling is not.
//
// A name here that no longer exists in the handler table is a build error, not
// a silent skip: a rename means this ranking was taken on a different table and
// wants re-running.
//
// NONE OF THIS IS ON BY DEFAULT. The twins are correct and the coverage is
// real, and the change still measures as a null-to-slightly-negative --
// docs/toyvm-reg-specialization.md has the numbers and the reason. `--reg-spec`
// generates them and uses them; without it the handler table is untouched.
module.exports = [
  'mov_rm16', 'cmp_ri8_jz', 'cmp_rm8_jnz_t', 'push_r16', 'mov_rm8',
  'sh4_r16', 'pop_r16', 'mov_ri16', 'sh5_r16', 'sub_ri16',
  'cmp_rm8_jz_t', 'sbb_ri16_jb_t', 'mov_mr16', 'mov_ri8', 'mov_rm32',
  'mov_mr8', 'dec_r16_nf', 'push_r32', 'add_ri16', 'dec_r16_jnz_t',
  'sh2_r16', 'inc_r16_nf', 'sh3_r16', 'sh7_r16', 'cmp_mr8',
  'add_ri16_nf', 'neg_r16_nf', 'sh5_r8', 'cmp_ri8_jz_t', 'add_ri8',
  'and_ri8', 'inc_r16', 'add_rm16', 'dec_r16_jnz', 'pop_r32',
  'sh4_r8', 'adc_ri16', 'cmp_ri16_jae_t', 'dec_r16_jz_t', 'cmp_ri16',
  'cmp_ri8_jb_t', 'sub_ri16_nf', 'cmp_ri8_jnz_t', 'sh5_r32', 'and_ri8_nf',
  'sh2_r16_jae_t', 'sh2_r16_jb', 'cmp_ri16_jnz_t', 'dec_r8_jnz_t', 'dec_r8_ja_t',
  'les', 'or_ri16_nf', 'lea', 'add_mr16', 'sub_rm16_nf',
  'dec_r8_jns', 'and_ri16_nf', 'imul_r16_nf',
];
