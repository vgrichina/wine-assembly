#!/usr/bin/env node
'use strict';

// Focused upper-bound benchmark for executing the existing x86 threaded words
// in one br_table function. It covers the unmodified four-block AoE fixture.
// Generated stages separately measure dispatch collapse, local thread IP,
// direct register access, specialized ALU semantics, and persistent locals.

const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'src', '05a-aoe-localregs-bench.generated.wat');
const HANDLERS = [7, 11, 12, 18, 20, 21, 28, 43, 48, 53, 64, 65, 128, 312, 319, 355];
// Production exact-form handler IDs emitted by $te for AoE forms already in
// the generic subset. RCT's 382-384 forms remain cold until their generic
// handler families are implemented in this dispatcher.
const SPECIALIZED_HANDLERS = [368, 373, 374, 378];
const DISPATCH_HANDLERS = [...HANDLERS, ...SPECIALIZED_HANDLERS];
const RAW_WORDS = new Map([
  [7, 1], [20, 1], [21, 1], [28, 1], [43, 1], [48, 1], [128, 1],
  [312, 2], [319, 2], [355, 1],
]);
const TERMINAL_HANDLERS = new Set([43, 312, 319, 355]);
const EXACT_OPERANDS = new Map([
  [7, [0]], [11, [0x10, 0x27]], [12, [0x21, 0x71]], [18, [0]],
  [20, [3, 7]], [21, [6, 7]], [28, [6]], [43, null], [48, [87]],
  [53, [263425]], [64, [6]], [65, [2]], [128, [1827]],
  [312, [0]], [319, [0]], [355, null],
]);

const callIndirectBenchHandlers = `
  ;; Focused call_indirect microbenchmarks. The JS harness promotes only the
  ;; matching decoded AoE fixture words to these handler IDs.
  (func $th_bench_sub_r_m32_direct_alu (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
    (local.set $b (call $gl32 (call $read_thread_word)))
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))
    (return_call $next))
  (func $th_bench_shr_r_direct_alu (param $op i32)
    (local $reg i32) (local $a i32) (local $count i32) (local $r i32)
    (local.set $reg (i32.and (local.get $op) (i32.const 255)))
    (local.set $a (call $get_reg (local.get $reg)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 31)))
    (local.set $r (i32.shr_u (local.get $a) (local.get $count)))
    (call $set_flags_shift (local.get $r)
      (i32.and (i32.shr_u (local.get $a) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
    (call $set_reg (local.get $reg) (local.get $r))
    (return_call $next))
  (func $th_bench_cmp_r_m32_ro_direct_alu (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
    (local.set $b (call $gl32 (i32.add
      (call $get_reg (i32.and (local.get $op) (i32.const 15)))
      (call $read_thread_word))))
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))
  (func $th_bench_jnz_direct (param $op i32)
    (local $fall i32) (local $target i32)
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (global.set $eip (if (result i32) (global.get $flag_res)
      (then (local.get $target)) (else (local.get $fall)))))
  (func $th_bench_jl_direct (param $op i32)
    (local $fall i32) (local $target i32)
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (global.set $eip (if (result i32)
      (i32.lt_s (global.get $flag_a) (global.get $flag_b))
      (then (local.get $target)) (else (local.get $fall)))))

  (func $th_bench_store_esi_abs (param $op i32)
    (call $gs32 (call $read_thread_word) (global.get $esi)) (return_call $next))
  (func $th_bench_xor_eax_eax (param $op i32)
    (global.set $eax (i32.const 0)) (call $set_flags_logic (i32.const 0)) (return_call $next))
  (func $th_bench_store_edi_abs (param $op i32)
    (call $gs32 (call $read_thread_word) (global.get $edi)) (return_call $next))
  (func $th_bench_load8_al_esi_disp (param $op i32)
    (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xffffff00))
      (call $gl8 (i32.add (global.get $esi) (call $read_thread_word)))))
    (return_call $next))
  (func $th_bench_sub_edi_m32_generic_alu (param $op i32)
    (global.set $edi (call $do_alu32 (i32.const 5) (global.get $edi)
      (call $gl32 (call $read_thread_word))))
    (return_call $next))
  (func $th_bench_mov_ecx_eax (param $op i32)
    (global.set $ecx (global.get $eax)) (return_call $next))
  (func $th_bench_inc_esi (param $op i32)
    (local $a i32) (local $r i32)
    (local.set $a (global.get $esi)) (local.set $r (i32.add (local.get $a) (i32.const 1)))
    (global.set $esi (local.get $r)) (call $set_flags_inc (local.get $a) (local.get $r)) (return_call $next))
  (func $th_bench_and_eax_i32 (param $op i32)
    (local $r i32) (local.set $r (i32.and (global.get $eax) (call $read_thread_word)))
    (global.set $eax (local.get $r)) (call $set_flags_logic (local.get $r)) (return_call $next))
  (func $th_bench_load_ebx_abs (param $op i32)
    (global.set $ebx (call $gl32 (call $read_thread_word))) (return_call $next))
  (func $th_bench_shr_ecx_generic_alu (param $op i32)
    (global.set $ecx (call $do_shift32 (i32.const 5) (global.get $ecx) (i32.const 4)))
    (return_call $next))
  (func $th_bench_mov_edx_edi (param $op i32)
    (global.set $edx (global.get $edi)) (return_call $next))
  (func $th_bench_add_edx_ecx (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (global.get $edx)) (local.set $b (global.get $ecx))
    (local.set $r (i32.add (local.get $a) (local.get $b)))
    (global.set $edx (local.get $r)) (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))
  (func $th_bench_dec_edx (param $op i32)
    (local $a i32) (local $r i32)
    (local.set $a (global.get $edx)) (local.set $r (i32.sub (local.get $a) (i32.const 1)))
    (global.set $edx (local.get $r)) (call $set_flags_dec (local.get $a) (local.get $r)) (return_call $next))
  (func $th_bench_cmp_edx_ebx_disp_generic_alu (param $op i32)
    (drop (call $do_alu32 (i32.const 7) (global.get $edx)
      (call $gl32 (i32.add (global.get $ebx) (call $read_thread_word)))))
    (return_call $next))
  (func $th_bench_load_edi_abs (param $op i32)
    (global.set $edi (call $gl32 (call $read_thread_word))) (return_call $next))
  (func $th_bench_add_edi_ecx (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (global.get $edi)) (local.set $b (global.get $ecx))
    (local.set $r (i32.add (local.get $a) (local.get $b)))
    (global.set $edi (local.get $r)) (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))

  (func $th_bench_sub_edi_m32_direct_alu (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (global.get $edi)) (local.set $b (call $gl32 (call $read_thread_word)))
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (global.set $edi (local.get $r)) (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))
  (func $th_bench_shr_ecx_direct_alu (param $op i32)
    (local $a i32) (local $r i32)
    (local.set $a (global.get $ecx)) (local.set $r (i32.shr_u (local.get $a) (i32.const 4)))
    (global.set $ecx (local.get $r))
    (call $set_flags_shift (local.get $r) (i32.and (i32.shr_u (local.get $a) (i32.const 3)) (i32.const 1)))
    (return_call $next))
  (func $th_bench_cmp_edx_ebx_disp_direct_alu (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (global.get $edx))
    (local.set $b (call $gl32 (i32.add (global.get $ebx) (call $read_thread_word))))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
    (return_call $next))
`;

function rawRead(target, globalIp) {
  return globalIp
    ? [`(local.set $${target} (call $read_thread_word))`]
    : [`(local.set $${target} (i32.load (local.get $ip_v)))`,
       '(local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))'];
}

function bodyGeneric(id, globalIp) {
  const read = target => rawRead(target, globalIp);
  switch (id) {
    case 368: return ['(global.set $ecx (global.get $eax))'];
    case 373: return ['(global.set $edx (global.get $edi))'];
    case 374: return [
      '(local.set $a (global.get $edx))', '(local.set $b (global.get $ecx))',
      '(local.set $r (i32.add (local.get $a) (local.get $b)))',
      '(global.set $edx (local.get $r))',
      '(call $set_flags_add (local.get $a) (local.get $b) (local.get $r))',
    ];
    case 378: return [
      '(local.set $a (global.get $edi))', '(local.set $b (global.get $ecx))',
      '(local.set $r (i32.add (local.get $a) (local.get $b)))',
      '(global.set $edi (local.get $r))',
      '(call $set_flags_add (local.get $a) (local.get $b) (local.get $r))',
    ];
    case 7: return [
      ...read('b'), '(local.set $a (call $get_reg (local.get $op)))',
      '(local.set $r (i32.and (local.get $a) (local.get $b)))',
      '(call $set_reg (local.get $op) (local.get $r))', '(call $set_flags_logic (local.get $r))',
    ];
    case 11: return [
      '(call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 15))))',
    ];
    case 12: return [
      '(local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))',
      '(local.set $a (call $get_reg (local.get $addr)))',
      '(local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 15))))',
      '(local.set $r (i32.add (local.get $a) (local.get $b)))',
      '(call $set_reg (local.get $addr) (local.get $r))',
      '(call $set_flags_add (local.get $a) (local.get $b) (local.get $r))',
    ];
    case 18: return [
      '(local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))',
      '(local.set $r (i32.xor (call $get_reg (local.get $addr)) (call $get_reg (i32.and (local.get $op) (i32.const 15)))))',
      '(call $set_reg (local.get $addr) (local.get $r))', '(call $set_flags_logic (local.get $r))',
    ];
    case 20: return [
      ...read('addr'), '(call $set_reg (local.get $op) (call $gl32 (local.get $addr)))',
    ];
    case 21: return [
      ...read('addr'), '(call $gs32 (local.get $addr) (call $get_reg (local.get $op)))',
    ];
    case 28: return [
      ...read('addr'),
      '(call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))',
    ];
    case 43: return [...read('a'), '(global.set $eip (local.get $a))', '(br $block_done)'];
    case 48: return [
      ...read('addr'), '(local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))',
      '(local.set $b (call $gl32 (local.get $addr)))',
      '(local.set $r (call $do_alu32 (i32.shr_u (local.get $op) (i32.const 4)) (local.get $a) (local.get $b)))',
      '(if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (then (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))))',
    ];
    case 53: return [
      '(local.set $addr (i32.and (local.get $op) (i32.const 255)))',
      '(local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 255)))',
      '(if (i32.eq (local.get $a) (i32.const 255)) (then (local.set $a (i32.and (global.get $ecx) (i32.const 31)))))',
      '(call $set_reg (local.get $addr) (call $do_shift32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 255)) (call $get_reg (local.get $addr)) (local.get $a)))',
    ];
    case 64: return [
      '(local.set $a (call $get_reg (local.get $op)))', '(local.set $r (i32.add (local.get $a) (i32.const 1)))',
      '(call $set_reg (local.get $op) (local.get $r))', '(call $set_flags_inc (local.get $a) (local.get $r))',
    ];
    case 65: return [
      '(local.set $a (call $get_reg (local.get $op)))', '(local.set $r (i32.sub (local.get $a) (i32.const 1)))',
      '(call $set_reg (local.get $op) (local.get $r))', '(call $set_flags_dec (local.get $a) (local.get $r))',
    ];
    case 128: return [
      ...read('addr'),
      '(local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))',
      '(local.set $b (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))',
      '(local.set $r (call $do_alu32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (local.get $a) (local.get $b)))',
      '(if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (i32.const 7)) (then (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)) (local.get $r))))',
    ];
    case 312: return [
      ...read('a'), ...read('b'),
      '(global.set $eip (if (result i32) (call $eval_cc (i32.const 5)) (then (local.get $b)) (else (local.get $a))))',
      '(br $block_done)',
    ];
    case 319: return [
      ...read('a'), ...read('b'),
      '(global.set $eip (if (result i32) (call $eval_cc (i32.const 12)) (then (local.get $b)) (else (local.get $a))))',
      '(br $block_done)',
    ];
    case 355: return [
      ...read('addr'),
      '(global.set $eip (call $gl32 (i32.add (local.get $addr) (i32.shl (global.get $eax) (i32.const 2)))))',
      '(br $block_done)',
    ];
    default: throw new Error(String(id));
  }
}

function body(id, local, genericAlu) {
  const g = name => local ? `(local.get $${name}_v)` : `(global.get $${name})`;
  const set = (name, value) => local ? `(local.set $${name}_v ${value})` : `(global.set $${name} ${value})`;
  const flag = (kind, a, b, r) => {
    if (!local) {
      if (kind === 'logic') return [`(call $set_flags_logic ${r})`];
      if (kind === 'shift') return [`(call $set_flags_shift ${r} ${b})`];
      if (kind === 'inc' || kind === 'dec') return [`(call $set_flags_${kind} ${a} ${r})`];
      return [`(call $set_flags_${kind} ${a} ${b} ${r})`];
    }
    const op = { add: 1, sub: 2, logic: 3, inc: 4, dec: 5, shift: 7 }[kind];
    const rows = [
      `(local.set $flag_op_v (i32.const ${op}))`,
      `(local.set $flag_res_v ${r})`,
      '(local.set $flag_shift_v (i32.const 31))',
    ];
    if (kind === 'add' || kind === 'sub') rows.push(`(local.set $flag_a_v ${a})`, `(local.set $flag_b_v ${b})`);
    if (kind === 'shift') rows.push(`(local.set $flag_b_v ${b})`);
    if (kind === 'inc' || kind === 'dec') rows.push(`(local.set $flag_a_v ${a})`, '(local.set $flag_b_v (i32.const 1))');
    return rows;
  };
  const read = '(local.set $a (i32.load (local.get $ip_v)))', advance = '(local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))';
  switch (id) {
    case 7: return [
      read, advance,
      genericAlu
        ? `(local.set $r (call $do_alu32 (i32.const 4) ${g('eax')} (local.get $a)))`
        : '(local.set $r (i32.and (local.get $a) ' + g('eax') + '))',
      set('eax', '(local.get $r)'),
      ...(genericAlu ? [] : flag('logic', '', '', '(local.get $r)')),
    ];
    case 11: return [
      `(if (i32.eq (local.get $op) (i32.const 0x10)) (then ${set('ecx', g('eax'))}) (else ${set('edx', g('edi'))}))`,
    ];
    case 12: return [
      `(local.set $a (if (result i32) (i32.eq (local.get $op) (i32.const 0x21)) (then ${g('edx')}) (else ${g('edi')})))`,
      `(local.set $b ${g('ecx')})`,
      genericAlu
        ? '(local.set $r (call $do_alu32 (i32.const 0) (local.get $a) (local.get $b)))'
        : '(local.set $r (i32.add (local.get $a) (local.get $b)))',
      `(if (i32.eq (local.get $op) (i32.const 0x21)) (then ${set('edx', '(local.get $r)')}) (else ${set('edi', '(local.get $r)')}))`,
      ...(genericAlu ? [] : flag('add', '(local.get $a)', '(local.get $b)', '(local.get $r)')),
    ];
    case 18: return genericAlu
      ? ['(local.set $r (call $do_alu32 (i32.const 6) ' + g('eax') + ' ' + g('eax') + '))', set('eax', '(local.get $r)')]
      : [set('eax', '(i32.const 0)'), ...flag('logic', '', '', '(i32.const 0)')];
    case 20: return [
      read, advance, '(local.set $r (call $gl32 (local.get $a)))',
      `(if (i32.eq (local.get $op) (i32.const 3)) (then ${set('ebx', '(local.get $r)')}) (else ${set('edi', '(local.get $r)')}))`,
    ];
    case 21: return [
      read, advance,
      `(call $gs32 (local.get $a) (if (result i32) (i32.eq (local.get $op) (i32.const 6)) (then ${g('esi')}) (else ${g('edi')})))`,
    ];
    case 28: return [
      read, advance,
      set('eax', `(i32.or (i32.and ${g('eax')} (i32.const 0xffffff00)) (call $gl8 (i32.add ${g('esi')} (local.get $a))))`),
    ];
    case 43: return [read, advance, set('eip', '(local.get $a)'), '(br $block_done)'];
    case 48: return [
      '(local.set $addr (i32.load (local.get $ip_v)))', advance,
      `(local.set $a ${g('edi')})`, '(local.set $b (call $gl32 (local.get $addr)))',
      genericAlu
        ? '(local.set $r (call $do_alu32 (i32.const 5) (local.get $a) (local.get $b)))'
        : '(local.set $r (i32.sub (local.get $a) (local.get $b)))',
      set('edi', '(local.get $r)'),
      ...(genericAlu ? [] : flag('sub', '(local.get $a)', '(local.get $b)', '(local.get $r)')),
    ];
    case 53: return [
      `(local.set $a ${g('ecx')})`, '(local.set $b (i32.const 4))',
      genericAlu
        ? '(local.set $r (call $do_shift32 (i32.const 5) (local.get $a) (local.get $b)))'
        : '(local.set $r (i32.shr_u (local.get $a) (local.get $b)))',
      set('ecx', '(local.get $r)'),
      ...(genericAlu ? [] : flag('shift', '(local.get $a)', '(i32.and (i32.shr_u (local.get $a) (i32.const 3)) (i32.const 1))', '(local.get $r)')),
    ];
    case 64: return [
      `(local.set $a ${g('esi')})`, '(local.set $r (i32.add (local.get $a) (i32.const 1)))', set('esi', '(local.get $r)'),
      ...flag('inc', '(local.get $a)', '(i32.const 1)', '(local.get $r)'),
    ];
    case 65: return [
      `(local.set $a ${g('edx')})`, '(local.set $r (i32.sub (local.get $a) (i32.const 1)))', set('edx', '(local.get $r)'),
      ...flag('dec', '(local.get $a)', '(i32.const 1)', '(local.get $r)'),
    ];
    case 128: return [
      '(local.set $addr (i32.load (local.get $ip_v)))', advance,
      `(local.set $a ${g('edx')})`, `(local.set $b (call $gl32 (i32.add ${g('ebx')} (local.get $addr))))`,
      genericAlu
        ? '(local.set $r (call $do_alu32 (i32.const 7) (local.get $a) (local.get $b)))'
        : '(local.set $r (i32.sub (local.get $a) (local.get $b)))',
      ...(genericAlu ? [] : flag('sub', '(local.get $a)', '(local.get $b)', '(local.get $r)')),
    ];
    case 312: return [
      read, advance, '(local.set $b (i32.load (local.get $ip_v)))', advance,
      set('eip', local
        ? '(if (result i32) (local.get $flag_res_v) (then (local.get $b)) (else (local.get $a)))'
        : '(if (result i32) (global.get $flag_res) (then (local.get $b)) (else (local.get $a)))'),
      '(br $block_done)',
    ];
    case 319: return [
      read, advance, '(local.set $b (i32.load (local.get $ip_v)))', advance,
      set('eip', local
        ? '(if (result i32) (i32.lt_s (local.get $flag_a_v) (local.get $flag_b_v)) (then (local.get $b)) (else (local.get $a)))'
        : '(if (result i32) (call $eval_cc (i32.const 12)) (then (local.get $b)) (else (local.get $a)))'),
      '(br $block_done)',
    ];
    case 355: return [
      read, advance, set('eip', `(call $gl32 (i32.add (local.get $a) (i32.shl ${g('eax')} (i32.const 2))))`),
      '(br $block_done)',
    ];
    default: throw new Error(String(id));
  }
}

function emitFunction(name, {
  local = false,
  generic = false,
  globalIp = false,
  genericAlu = false,
  blockFallback = false,
  exactOperands = false,
  cachedTag = false,
  cachedMetadata = false,
} = {}) {
  const out = [];
  const p = (s = '') => out.push(s);
  const dispatchHandlers = generic ? DISPATCH_HANDLERS : HANDLERS;
  p(`  (func $${name} (export "${name}") (param $max_blocks i32)`);
  p('    (local $blocks i32) (local $thread i32) (local $ip_v i32)');
  if (blockFallback) p('    (local $scan i32) (local $scan_fn i32) (local $scan_op i32) (local $scan_supported i32)');
  p('    (local $fn i32) (local $op i32) (local $addr i32) (local $a i32) (local $b i32) (local $r i32)');
  if (local) {
    p('    (local $eax_v i32) (local $ecx_v i32) (local $edx_v i32) (local $ebx_v i32)');
    p('    (local $esp_v i32) (local $ebp_v i32) (local $esi_v i32) (local $edi_v i32) (local $eip_v i32)');
    p('    (local $flag_op_v i32) (local $flag_a_v i32) (local $flag_b_v i32) (local $flag_res_v i32)');
    p('    (local $flag_shift_v i32) (local $saved_cf_v i32)');
    for (const reg of ['eax','ecx','edx','ebx','esp','ebp','esi','edi','eip']) p(`    (local.set $${reg}_v (global.get $${reg}))`);
    for (const f of ['flag_op','flag_a','flag_b','flag_res']) p(`    (local.set $${f}_v (global.get $${f}))`);
    p('    (local.set $flag_shift_v (global.get $flag_sign_shift))');
    p('    (local.set $saved_cf_v (global.get $saved_cf))');
  }
  p('    (local.set $blocks (local.get $max_blocks))');
  p('    (block $all_done (loop $main');
  p('      (br_if $all_done (i32.le_s (local.get $blocks) (i32.const 0)))');
  p(`      (br_if $all_done (i32.eqz ${local ? '(local.get $eip_v)' : '(global.get $eip)'}))`);
  p('      (local.set $blocks (i32.sub (local.get $blocks) (i32.const 1)))');
  p(`      (local.set $thread (call $cache_lookup ${local ? '(local.get $eip_v)' : '(global.get $eip)'}))`);
  p('      (if (i32.eqz (local.get $thread))');
  p(`        (then (local.set $thread (call $decode_block ${local ? '(local.get $eip_v)' : '(global.get $eip)'}))))`);
  if (cachedTag) {
    p('      ;; Benchmark-only classify-once selector. Bit 0 marks a packet');
    p('      ;; already proven compatible with this generated handler subset.');
    p('      (if (i32.eqz (i32.and (local.get $thread) (i32.const 1)))');
    p('        (then');
    p('          (global.set $ip (local.get $thread))');
    p('          (global.set $steps (i32.const 1000))');
    p('          (call $next)');
    p('          (br $main)))');
    p('      (local.set $thread (i32.and (local.get $thread) (i32.const -2)))');
  }
  if (cachedMetadata) {
    p(`      (if (i32.eqz (call $x86_hot_cache_is_hot ${local ? '(local.get $eip_v)' : '(global.get $eip)'}))`);
    p('        (then');
    p('          (global.set $x86_hot_subset_fallback_blocks');
    p('            (i32.add (global.get $x86_hot_subset_fallback_blocks) (i32.const 1)))');
    p('          (global.set $ip (local.get $thread))');
    p('          (global.set $steps (i32.const 1000))');
    p('          (call $next)');
    p('          (br $main)))');
    p('      (global.set $x86_hot_subset_hot_blocks');
    p('        (i32.add (global.get $x86_hot_subset_hot_blocks) (i32.const 1)))');
  }
  if (blockFallback) {
    p('      ;; Production-shaped fallback: validate the complete decoded block');
    p('      ;; before changing guest state. Unsupported blocks restart through $next.');
    p('      (local.set $scan (local.get $thread))');
    p('      (block $hot_ready');
    p('        (block $use_fallback');
    p('          (loop $scan_loop');
    p('            (local.set $scan_fn (i32.load (local.get $scan)))');
    p('            (local.set $scan_op (i32.load offset=4 (local.get $scan)))');
    p('            (local.set $scan (i32.add (local.get $scan) (i32.const 8)))');
    p('            (local.set $scan_supported (i32.const 0))');
    for (const id of HANDLERS) {
      const operands = exactOperands ? EXACT_OPERANDS.get(id) : null;
      const operandCheck = operands && operands.length
        ? operands.map(op => `(i32.eq (local.get $scan_op) (i32.const ${op}))`)
          .reduce((a, b) => `(i32.or ${a} ${b})`)
        : null;
      const condition = operandCheck
        ? `(i32.and (i32.eq (local.get $scan_fn) (i32.const ${id})) ${operandCheck})`
        : `(i32.eq (local.get $scan_fn) (i32.const ${id}))`;
      p(`            (if ${condition}`);
      p('              (then');
      p('                (local.set $scan_supported (i32.const 1))');
      const rawBytes = (RAW_WORDS.get(id) || 0) * 4;
      if (rawBytes) p(`                (local.set $scan (i32.add (local.get $scan) (i32.const ${rawBytes})))`);
      if (TERMINAL_HANDLERS.has(id)) p('                (br $hot_ready)');
      p('              ))');
    }
    p('            (br_if $use_fallback (i32.eqz (local.get $scan_supported)))');
    p('            (br $scan_loop)))');
    p('        ;; No hot instruction ran, so only the thread IP needs restoring.');
    p('        (global.set $x86_hot_subset_fallback_blocks');
    p('          (i32.add (global.get $x86_hot_subset_fallback_blocks) (i32.const 1)))');
    p('        (global.set $ip (local.get $thread))');
    p('        (global.set $steps (i32.const 1000))');
    p('        (call $next)');
    p('        (br $main)');
    p('      ) ;; hot_ready');
    p('      (global.set $x86_hot_subset_hot_blocks');
    p('        (i32.add (global.get $x86_hot_subset_hot_blocks) (i32.const 1)))');
  }
  if (globalIp) p('      (global.set $ip (local.get $thread))');
  else p('      (local.set $ip_v (local.get $thread))');
  p('      (block $block_done (loop $dispatch');
  p(`        (local.set $fn (i32.load ${globalIp ? '(global.get $ip)' : '(local.get $ip_v)'}))`);
  p(`        (local.set $op (i32.load offset=4 ${globalIp ? '(global.get $ip)' : '(local.get $ip_v)'}))`);
  p(`        (${globalIp ? 'global.set $ip' : 'local.set $ip_v'} (i32.add ${globalIp ? '(global.get $ip)' : '(local.get $ip_v)'} (i32.const 8)))`);
  p('        (block $fallback');
  for (let i = dispatchHandlers.length - 1; i >= 0; i--) p(`          (block $case_${dispatchHandlers[i]}`);
  const maxHandler = Math.max(...dispatchHandlers);
  const target = Array.from({ length: maxHandler + 1 }, (_, id) => dispatchHandlers.includes(id) ? `$case_${id}` : '$fallback').join(' ');
  p(`            (br_table ${target} $fallback (local.get $fn))`);
  for (const id of dispatchHandlers) {
    p(`          ) ;; case ${id}`);
    for (const row of (generic ? bodyGeneric(id, globalIp) : body(id, local, genericAlu))) p(`          ${row}`);
    p('          (br $dispatch)');
  }
  p('        ) ;; fallback');
  p('        (call $host_log_i32 (i32.const 0x10CA1BAD))');
  if (local) p('        (local.set $eip_v (i32.const 0))'); else p('        (global.set $eip (i32.const 0))');
  p('        (br $block_done)))');
  p('      (br $main)))');
  if (local) {
    for (const reg of ['eax','ecx','edx','ebx','esp','ebp','esi','edi','eip']) p(`    (global.set $${reg} (local.get $${reg}_v))`);
    for (const f of ['flag_op','flag_a','flag_b','flag_res']) p(`    (global.set $${f} (local.get $${f}_v))`);
    p('    (global.set $flag_sign_shift (local.get $flag_shift_v))');
    p('    (global.set $saved_cf (local.get $saved_cf_v))');
  }
  p('  )');
  return out.join('\n');
}

function emitClassifier() {
  const out = [];
  const p = (s = '') => out.push(s);
  p('  ;; Classify the final emitted x86 packet once at cache-store time.');
  p('  (func $x86_hot_subset_classify_packet (param $start i32) (param $end i32) (result i32)');
  p('    (local $ptr i32) (local $fn i32)');
  p('    (local.set $ptr (local.get $start))');
  p('    (block $cold (loop $scan');
  p('      (br_if $cold (i32.ge_u (local.get $ptr) (local.get $end)))');
  p('      (local.set $fn (i32.load (local.get $ptr)))');
  p('      (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))');
  p('      (block $fallback');
  for (let i = DISPATCH_HANDLERS.length - 1; i >= 0; i--) p(`        (block $class_${DISPATCH_HANDLERS[i]}`);
  const maxHandler = Math.max(...DISPATCH_HANDLERS);
  const target = Array.from({ length: maxHandler + 1 }, (_, id) => DISPATCH_HANDLERS.includes(id) ? `$class_${id}` : '$fallback').join(' ');
  p(`          (br_table ${target} $fallback (local.get $fn))`);
  for (const id of DISPATCH_HANDLERS) {
    p(`        ) ;; class ${id}`);
    const rawBytes = (RAW_WORDS.get(id) || 0) * 4;
    if (rawBytes) p(`        (local.set $ptr (i32.add (local.get $ptr) (i32.const ${rawBytes})))`);
    if (TERMINAL_HANDLERS.has(id)) p('        (return (i32.const 1))');
    else p('        (br $scan)');
  }
  p('      ) ;; fallback');
  p('      (br $cold)');
  p('    ))');
  p('    (i32.const 0)');
  p('  )');
  return out.join('\n');
}

function emitPacketFunction(name) {
  const out = [];
  const p = (s = '') => out.push(s);
  p(`  (func $${name} (param $thread i32)`);
  p('    (local $ip_v i32) (local $fn i32) (local $op i32)');
  p('    (local $addr i32) (local $a i32) (local $b i32) (local $r i32)');
  p('    (local.set $ip_v (local.get $thread))');
  p('    (block $block_done (loop $dispatch');
  p('      (local.set $fn (i32.load (local.get $ip_v)))');
  p('      (local.set $op (i32.load offset=4 (local.get $ip_v)))');
  p('      (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))');
  p('      (block $fallback');
  for (let i = DISPATCH_HANDLERS.length - 1; i >= 0; i--) {
    p(`        (block $case_${DISPATCH_HANDLERS[i]}`);
  }
  const maxHandler = Math.max(...DISPATCH_HANDLERS);
  const target = Array.from({ length: maxHandler + 1 }, (_, id) =>
    DISPATCH_HANDLERS.includes(id) ? `$case_${id}` : '$fallback').join(' ');
  p(`          (br_table ${target} $fallback (local.get $fn))`);
  for (const id of DISPATCH_HANDLERS) {
    p(`        ) ;; case ${id}`);
    for (const row of bodyGeneric(id, false)) p(`        ${row}`);
    p('        (br $dispatch)');
  }
  p('      ) ;; fallback');
  p('      ;; Cache-time classification makes this unreachable unless the');
  p('      ;; packet or metadata was corrupted after insertion.');
  p('      (call $host_log_i32 (i32.const 0x10CA1BAD))');
  p('      (global.set $eip (i32.const 0))');
  p('      (br $block_done)))');
  p('  )');
  return out.join('\n');
}

const text = [
  '  ;; GENERATED focused benchmark; see tools/generate-aoe-localregs-dispatch.js.',
  callIndirectBenchHandlers,
  emitClassifier(),
  emitPacketFunction('run_x86_hot_subset_packet_generic'),
  emitFunction('run_aoe_brtable_generic_global_ip', { generic: true, globalIp: true }),
  emitFunction('run_aoe_brtable_generic_local_ip', { generic: true }),
  emitFunction('run_aoe_brtable_direct_generic_alu', { genericAlu: true }),
  emitFunction('run_aoe_brtable_subset_generic', { generic: true, blockFallback: true }),
  emitFunction('run_aoe_brtable_subset_direct', { genericAlu: true, blockFallback: true, exactOperands: true }),
  emitFunction('run_aoe_brtable_cached_generic', { generic: true, cachedTag: true }),
  emitFunction('run_x86_hot_subset_cached_generic', { generic: true, cachedMetadata: true }),
  emitFunction('run_aoe_brtable_globals'),
  emitFunction('run_aoe_brtable_locals', { local: true }),
  '',
].join('\n');
fs.writeFileSync(OUT, text);
console.log(`generated ${path.relative(path.join(__dirname, '..'), OUT)}`);
