#!/usr/bin/env node
'use strict';

// Focused upper-bound benchmark for executing the existing x86 threaded words
// in one br_table function. It covers the unmodified four-block AoE fixture.
// The two functions differ only in whether architectural state lives in Wasm
// globals or persistent locals across all requested blocks.

const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'src', '05a-aoe-localregs-bench.generated.wat');
const HANDLERS = [7, 11, 12, 18, 20, 21, 28, 43, 48, 53, 64, 65, 128, 312, 319, 355];

function body(id, local) {
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
      read, advance, '(local.set $r (i32.and (local.get $a) ' + g('eax') + '))',
      set('eax', '(local.get $r)'), ...flag('logic', '', '', '(local.get $r)'),
    ];
    case 11: return [
      `(if (i32.eq (local.get $op) (i32.const 0x10)) (then ${set('ecx', g('eax'))}) (else ${set('edx', g('edi'))}))`,
    ];
    case 12: return [
      `(local.set $a (if (result i32) (i32.eq (local.get $op) (i32.const 0x21)) (then ${g('edx')}) (else ${g('edi')})))`,
      `(local.set $b ${g('ecx')})`,
      '(local.set $r (i32.add (local.get $a) (local.get $b)))',
      `(if (i32.eq (local.get $op) (i32.const 0x21)) (then ${set('edx', '(local.get $r)')}) (else ${set('edi', '(local.get $r)')}))`,
      ...flag('add', '(local.get $a)', '(local.get $b)', '(local.get $r)'),
    ];
    case 18: return [set('eax', '(i32.const 0)'), ...flag('logic', '', '', '(i32.const 0)')];
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
      '(local.set $r (i32.sub (local.get $a) (local.get $b)))', set('edi', '(local.get $r)'),
      ...flag('sub', '(local.get $a)', '(local.get $b)', '(local.get $r)'),
    ];
    case 53: return [
      `(local.set $a ${g('ecx')})`, '(local.set $b (i32.const 4))',
      '(local.set $r (i32.shr_u (local.get $a) (local.get $b)))', set('ecx', '(local.get $r)'),
      ...flag('shift', '(local.get $a)', '(i32.and (i32.shr_u (local.get $a) (i32.const 3)) (i32.const 1))', '(local.get $r)'),
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
      '(local.set $r (i32.sub (local.get $a) (local.get $b)))',
      ...flag('sub', '(local.get $a)', '(local.get $b)', '(local.get $r)'),
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

function emitFunction(name, local) {
  const out = [];
  const p = (s = '') => out.push(s);
  p(`  (func $${name} (export "${name}") (param $max_blocks i32)`);
  p('    (local $blocks i32) (local $thread i32) (local $ip_v i32)');
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
  p('      (local.set $ip_v (local.get $thread))');
  p('      (block $block_done (loop $dispatch');
  p('        (local.set $fn (i32.load (local.get $ip_v)))');
  p('        (local.set $op (i32.load offset=4 (local.get $ip_v)))');
  p('        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))');
  p('        (block $fallback');
  for (let i = HANDLERS.length - 1; i >= 0; i--) p(`          (block $case_${HANDLERS[i]}`);
  const target = Array.from({ length: 356 }, (_, id) => HANDLERS.includes(id) ? `$case_${id}` : '$fallback').join(' ');
  p(`            (br_table ${target} $fallback (local.get $fn))`);
  for (const id of HANDLERS) {
    p(`          ) ;; case ${id}`);
    for (const row of body(id, local)) p(`          ${row}`);
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

const text = [
  '  ;; GENERATED focused benchmark; see tools/generate-aoe-localregs-dispatch.js.',
  emitFunction('run_aoe_brtable_globals', false),
  emitFunction('run_aoe_brtable_locals', true),
  '',
].join('\n');
fs.writeFileSync(OUT, text);
console.log(`generated ${path.relative(path.join(__dirname, '..'), OUT)}`);
